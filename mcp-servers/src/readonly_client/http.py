"""The one HTTP client every server uses, and the read-only guard inside it.

The guard is the reason this module exists. "Read-only" enforced by convention
means every future tool author has to remember; enforced here it means a write
is not expressible. :meth:`ReadOnlyClient.request` raises before a request
object is constructed, so there is no code path from an MCP tool to a mutation
even if a tool asks for one.

Three things the guard is careful about:

* **POST is allowed only for search, and only where the product says so.**
  Atlassian's JQL search takes POST so a long JQL string can travel in a body.
  That carve-out is scoped to an exact-match allowlist carried on the *config*,
  so the Jira client's allowlist is not the GitLab client's - a module-level
  global would have let one product's exception apply to all four.
* **The check is on the normalised path.** ``/rest/api/2/search/../issue/X``
  resolves to ``/rest/api/2/issue/X`` at the server but would pass a naive
  ``startswith`` test. It is normalised first, then matched exactly.
* **The default is closed.** A config that names no allowlist gets GET and
  only GET. Adding a product cannot accidentally inherit a carve-out.

The client also reads text, not just JSON, because Jenkins answers
``/consoleText`` with ``text/plain``. That path keeps the same guard: an HTML
body is an SSO login page, never a console log.
"""

from __future__ import annotations

import asyncio
import posixpath
from typing import Any, Iterable, Mapping
from urllib.parse import urlsplit

import httpx

from .config import ServiceConfig
from .errors import (
    ServiceError,
    RateLimitError,
    ReadOnlyViolation,
    raise_for_response,
    transport_error,
)

# Methods the client will build a request for at all. Anything else raises
# before a connection is opened. This is a property of the client, not of any
# product, so it lives here rather than in a paths module.
ALLOWED_METHODS: frozenset[str] = frozenset({"GET", "POST"})

MAX_RETRIES = 3
# Only these are worth retrying. A 401/403/404 will fail identically on retry,
# and retrying a 4xx against an SSO-fronted instance is how an account gets
# locked out.
RETRY_STATUSES = frozenset({429, 502, 503, 504})

# A console log can be hundreds of megabytes. Text responses are streamed and
# cut at this many bytes unless the caller asks for less; the caller is told
# the cut happened rather than being handed a silently truncated log.
DEFAULT_TEXT_LIMIT = 2 * 1024 * 1024


def normalise_path(path: str) -> str:
    """Collapse ``.``/``..`` and duplicate slashes to a canonical absolute path.

    Anything a guard decides has to be decided on this form, not on the raw
    string the caller supplied.
    """
    # Strip any scheme/host a caller mistakenly passed, so the guard always
    # sees a path and never silently allows an absolute URL to another host.
    if "://" in path:
        path = urlsplit(path).path
    if not path.startswith("/"):
        path = "/" + path
    return posixpath.normpath(path)


def assert_read_only(
    method: str, path: str, allowlist: Iterable[str] = ()
) -> None:
    """Raise unless ``method`` on ``path`` is a read.

    ``allowlist`` is the set of paths this caller may POST to, and it defaults
    to empty so that forgetting to pass one fails closed.

    Separated from the client so it can be tested directly and reused by
    anything that builds a request outside :class:`ReadOnlyClient`.
    """
    m = (method or "").upper()
    if m not in ALLOWED_METHODS:
        raise ReadOnlyViolation(
            f"{m or '<empty>'} is not permitted: this client is read-only and "
            "builds GET requests only (plus POST to the search endpoints this "
            "product declares). No request was made."
        )
    if m == "GET":
        return

    allowed = tuple(allowlist)
    clean = normalise_path(path)
    if clean not in allowed:
        raise ReadOnlyViolation(
            f"POST {clean} is not permitted. POST is allowed only for the search "
            f"endpoints {list(allowed)}, where the API requires a request body "
            "for a query too long to put in a URL. No request was made."
        )


class TextResponse:
    """A text body, with the fact of truncation carried alongside it.

    A truncated console log that looks whole is worse than no log: the model
    reads the tail it was given, sees no stack trace, and reports that the
    build failed for no visible reason. So the cut travels with the text.
    """

    __slots__ = ("text", "truncated", "byte_limit", "content_type")

    def __init__(
        self, text: str, *, truncated: bool, byte_limit: int, content_type: str
    ) -> None:
        self.text = text
        self.truncated = truncated
        self.byte_limit = byte_limit
        self.content_type = content_type

    def __str__(self) -> str:  # pragma: no cover - convenience only
        return self.text


def _looks_like_html(body: str, content_type: str) -> bool:
    if "html" in content_type.lower():
        return True
    return body.lstrip()[:15].lower().startswith(("<!doctype", "<html"))


class ReadOnlyClient:
    """An httpx wrapper that can only read.

    One instance per product per process. Holds a connection pool, so it is
    created at server startup and closed at shutdown rather than per call.
    """

    def __init__(self, config: ServiceConfig) -> None:
        self._config = config
        timeout = httpx.Timeout(
            connect=config.connect_timeout,
            read=config.read_timeout,
            write=config.read_timeout,
            pool=config.connect_timeout,
        )
        # verify: a path string makes httpx load that PEM bundle *instead of*
        # certifi's. True keeps the default trust store. There is deliberately
        # no code path that sets this to False - see errors.transport_error.
        verify: str | bool = config.ca_bundle if config.ca_bundle else True
        headers = {
            "Accept": "application/json",
            "User-Agent": f"kryptonite-readonly-mcp/1.0 ({config.product}, read-only)",
        }
        # Product-specific headers before auth, so a product cannot overwrite
        # the credential header by declaring one with the same name.
        headers.update(config.extra_headers)
        headers.update(config.auth_headers())
        self._client = httpx.AsyncClient(
            base_url=config.base_url,
            timeout=timeout,
            verify=verify,
            # httpx reads HTTPS_PROXY / NO_PROXY from the environment when
            # trust_env is on, which is what a corporate proxy needs.
            trust_env=True,
            follow_redirects=False,
            headers=headers,
        )

    @property
    def config(self) -> ServiceConfig:
        return self._config

    async def aclose(self) -> None:
        await self._client.aclose()

    async def __aenter__(self) -> "ReadOnlyClient":
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.aclose()

    async def get(
        self, path: str, *, params: Mapping[str, Any] | None = None
    ) -> Any:
        return await self.request("GET", path, params=params)

    async def search_post(self, path: str, *, json: Mapping[str, Any]) -> Any:
        """POST to a search endpoint. Rejected unless ``path`` is allowlisted."""
        return await self.request("POST", path, json=json)

    async def request(
        self,
        method: str,
        path: str,
        *,
        params: Mapping[str, Any] | None = None,
        json: Mapping[str, Any] | None = None,
    ) -> Any:
        # THE GUARD. Before anything else, including URL construction.
        assert_read_only(method, path, self._config.search_post_allowlist)

        clean_params = {k: v for k, v in (params or {}).items() if v is not None}
        attempt = 0
        while True:
            try:
                response = await self._client.request(
                    method.upper(), path, params=clean_params or None, json=json
                )
            except httpx.HTTPError as exc:
                raise self._transport(exc) from None

            if self._should_retry(response.status_code, attempt):
                await asyncio.sleep(self._retry_delay(response, attempt))
                attempt += 1
                continue

            self._check(response, path)

            if not response.content:
                return {}
            try:
                return response.json()
            except ValueError:
                raise ServiceError(
                    f"{self._config.product} returned a non-JSON body for "
                    f"{normalise_path(path)} (content-type "
                    f"{response.headers.get('content-type', 'unknown')!r}). This "
                    "usually means an SSO portal intercepted the request and "
                    "answered with a login page instead of the API."
                ) from None

    async def get_text(
        self,
        path: str,
        *,
        params: Mapping[str, Any] | None = None,
        max_bytes: int | None = None,
        tail: bool = False,
    ) -> TextResponse:
        """GET a ``text/plain`` body, streamed and capped.

        Jenkins answers ``/consoleText`` with plain text, and a build that
        looped can leave hundreds of megabytes of it. Reading that into memory
        to hand a model the last hundred lines is how a tool call takes the
        server down, so the body is streamed and cut at ``max_bytes``.

        ``tail=True`` keeps the LAST ``max_bytes`` rather than the first, which
        is what a failure diagnosis wants: the stack trace is at the end. It
        still costs a full download - Jenkins has no range on this endpoint -
        but memory stays bounded at the cap.
        """
        limit = DEFAULT_TEXT_LIMIT if max_bytes is None else max(1, int(max_bytes))
        assert_read_only("GET", path, self._config.search_post_allowlist)
        clean_params = {k: v for k, v in (params or {}).items() if v is not None}

        attempt = 0
        while True:
            try:
                async with self._client.stream(
                    "GET", path, params=clean_params or None
                ) as response:
                    if self._should_retry(response.status_code, attempt):
                        await response.aclose()
                        await asyncio.sleep(self._retry_delay(response, attempt))
                        attempt += 1
                        continue
                    # raise_for_response reads the body to classify the error,
                    # and a streamed response has not been read yet.
                    if response.status_code >= 400:
                        await response.aread()
                        self._check(response, path)

                    chunks: list[bytes] = []
                    size = 0
                    truncated = False
                    async for chunk in response.aiter_bytes():
                        chunks.append(chunk)
                        size += len(chunk)
                        if size <= limit:
                            continue
                        truncated = True
                        if not tail:
                            break
                        # Keep only enough tail chunks to cover the cap. Drops
                        # from the front so peak memory is limit + one chunk.
                        while len(chunks) > 1 and size - len(chunks[0]) >= limit:
                            size -= len(chunks.pop(0))
                    raw = b"".join(chunks)
            except httpx.HTTPError as exc:
                raise self._transport(exc) from None

            body = raw[-limit:] if (truncated and tail) else raw[:limit]
            ctype = response.headers.get("content-type", "")
            text = body.decode("utf-8", errors="replace")
            if _looks_like_html(text, ctype):
                raise ServiceError(
                    f"{self._config.product} returned an HTML body for "
                    f"{normalise_path(path)} instead of plain text. This is an "
                    "SSO or reverse-proxy login page, not the resource. Check "
                    f"that the credential in {self._config.env_prefix}_TOKEN is "
                    "valid and that the instance is reachable without an "
                    "interactive login."
                )
            return TextResponse(
                text, truncated=truncated, byte_limit=limit, content_type=ctype
            )

    def _should_retry(self, status: int, attempt: int) -> bool:
        return status in RETRY_STATUSES and attempt < MAX_RETRIES

    def _transport(self, exc: httpx.HTTPError) -> Exception:
        return transport_error(
            exc,
            product=self._config.product,
            base_url=self._config.base_url,
            base_url_var=self._config.base_url_var,
            env_prefix=self._config.env_prefix,
        )

    def _check(self, response: httpx.Response, path: str) -> None:
        if response.status_code == 429:
            raise RateLimitError(
                "Rate limited by the instance (HTTP 429) and the retry cap of "
                f"{MAX_RETRIES} was reached. Retry-After was honoured on each "
                "attempt. Reduce max_results or slow the call rate."
            )
        raise_for_response(
            response,
            product=self._config.product,
            path=normalise_path(path),
            base_url_var=self._config.base_url_var,
            env_prefix=self._config.env_prefix,
            wrong_path_hint=self._config.wrong_path_hint,
        )

    @staticmethod
    def _retry_delay(response: httpx.Response, attempt: int) -> float:
        """Honour Retry-After when present, else exponential backoff.

        Retry-After wins because the instance knows its own limiter window;
        guessing shorter just burns the next attempt. Capped at 30s so a
        hostile or misconfigured header cannot hang a tool call indefinitely.
        """
        header = response.headers.get("retry-after")
        if header:
            try:
                return min(float(header), 30.0)
            except ValueError:
                pass  # Retry-After may be an HTTP-date; fall through to backoff.
        return min(2.0**attempt, 30.0)
