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

# The largest attachment worth downloading, and the number is not arbitrary.
# An image reaches the model as base64, and base64 of N bytes is 4*ceil(N/3)
# characters: 3,750,000 bytes is exactly 5,000,000 characters, which is the
# per-image cap the client enforces at the other end of the pipe. A byte over
# this and the picture is fetched, encoded, sent and then dropped by the
# client - all the cost of the download and none of the benefit.
DEFAULT_BINARY_LIMIT = 3_750_000

# A download endpoint that redirects more than this is not pointing at a file.
MAX_DOWNLOAD_REDIRECTS = 3

# Sentinel for "the body was there and was not JSON", so the raise happens
# outside the except block and does not chain a ValueError onto the message.
_NON_JSON = object()


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


class JsonResponse:
    """A decoded JSON body together with the response headers.

    Headers are not decoration on these APIs, they are half the answer. GitLab
    reports pagination entirely in `x-total` / `x-next-page` and friends, and
    Jenkins reports how much log exists in `X-Text-Size`. A client that returns
    only the parsed body forces every caller that needs those to reach past it.

    :meth:`ReadOnlyClient.request` still returns the bare body, because most
    callers want exactly that and threading a wrapper through them all would be
    noise. This is what the ones that need more ask for.
    """

    __slots__ = ("data", "headers", "status_code")

    def __init__(self, data: Any, headers: httpx.Headers, status_code: int) -> None:
        self.data = data
        self.headers = headers
        self.status_code = status_code

    def header_int(self, name: str) -> int | None:
        """A header parsed as an int, or None if absent or unparseable.

        None is a real answer, not a failure. GitLab omits `x-total` entirely
        once a query exceeds 10,000 records, and reporting that as 0 would tell
        a model it had the whole result set when it had the first page of
        hundreds.
        """
        raw = self.headers.get(name)
        if raw is None:
            return None
        try:
            return int(raw)
        except (TypeError, ValueError):
            return None


class TextResponse:
    """A text body, with the fact of truncation carried alongside it.

    A truncated console log that looks whole is worse than no log: the model
    reads the tail it was given, sees no stack trace, and reports that the
    build failed for no visible reason. So the cut travels with the text.
    """

    __slots__ = ("text", "truncated", "byte_limit", "content_type", "headers")

    def __init__(
        self,
        text: str,
        *,
        truncated: bool,
        byte_limit: int,
        content_type: str,
        headers: httpx.Headers | None = None,
    ) -> None:
        self.text = text
        self.truncated = truncated
        self.byte_limit = byte_limit
        self.content_type = content_type
        self.headers = headers if headers is not None else httpx.Headers()

    def header_int(self, name: str) -> int | None:
        """As :meth:`JsonResponse.header_int`. Jenkins reports the true size of
        a log in ``X-Text-Size``, which is how a tail can be fetched without
        downloading everything before it."""
        raw = self.headers.get(name)
        if raw is None:
            return None
        try:
            return int(raw)
        except (TypeError, ValueError):
            return None

    def __str__(self) -> str:  # pragma: no cover - convenience only
        return self.text


class BinaryResponse:
    """Bytes that are not text and must not be treated as text.

    Deliberately has no ``truncated`` flag, unlike :class:`TextResponse`, and
    that asymmetry is the whole design. The tail of a truncated log is still
    the answer to "why did the build fail"; the first three megabytes of a
    four-megabyte PNG is not a picture, it is a decode error at the model's
    end that costs the download and explains nothing. So an oversized
    attachment is REFUSED, with its real size named, and never delivered in
    part.
    """

    __slots__ = ("content", "content_type", "url", "headers")

    def __init__(
        self,
        content: bytes,
        *,
        content_type: str,
        url: str,
        headers: httpx.Headers | None = None,
    ) -> None:
        self.content = content
        self.content_type = content_type
        self.url = url
        self.headers = headers if headers is not None else httpx.Headers()

    def __len__(self) -> int:  # pragma: no cover - convenience only
        return len(self.content)


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

    async def get_full(
        self, path: str, *, params: Mapping[str, Any] | None = None
    ) -> JsonResponse:
        """GET, returning the headers as well as the body."""
        return await self.request("GET", path, params=params, want_headers=True)

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
        want_headers: bool = False,
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
                data: Any = {}
            else:
                try:
                    data = response.json()
                except ValueError:
                    data = _NON_JSON
            if data is _NON_JSON:
                raise ServiceError(
                    f"{self._config.product} returned a non-JSON body for "
                    f"{normalise_path(path)} (content-type "
                    f"{response.headers.get('content-type', 'unknown')!r}). This "
                    "usually means an SSO portal intercepted the request and "
                    "answered with a login page instead of the API."
                ) from None
            if want_headers:
                return JsonResponse(data, response.headers, response.status_code)
            return data

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
                text,
                truncated=truncated,
                byte_limit=limit,
                content_type=ctype,
                headers=response.headers,
            )

    async def get_bytes(
        self,
        path: str,
        *,
        params: Mapping[str, Any] | None = None,
        max_bytes: int | None = None,
    ) -> BinaryResponse:
        """GET a binary body - an attachment - streamed, size-checked, and
        REFUSED rather than truncated when it is too big.

        Three things here are absent from the JSON and text paths, and each is
        a way this particular call goes wrong that the others cannot.

        **Accept.** Every other request advertises ``application/json``, which
        is what makes Atlassian answer with JSON rather than a login page. A
        download endpoint asked for JSON can answer 406, so this one request
        asks for anything.

        **Redirects, followed by hand, same-origin only.** The client is built
        with ``follow_redirects=False`` and that stays true. An attachment URL
        on Data Center commonly 302s to ``/download/...``, so the hop has to be
        followed for the tool to work at all - but the credential is a
        client-wide header, so httpx would present it to whatever host the
        Location names, and nothing about a 302 is authenticated. The hop is
        therefore resolved, checked against the configured origin, and refused
        if it leaves it: a refusal the caller can read, rather than a token
        already sent.

        **A size check before the transfer, not after.** ``Content-Length`` is
        consulted first, so an oversized attachment costs one round trip rather
        than a full download, and the stream is abandoned mid-flight for a
        server that sent no length.
        """
        limit = DEFAULT_BINARY_LIMIT if max_bytes is None else max(1, int(max_bytes))
        assert_read_only("GET", path, self._config.search_post_allowlist)
        clean_params = {k: v for k, v in (params or {}).items() if v is not None}

        target: Any = path
        # Only the first hop carries the caller's query. A redirect target
        # already has everything it needs in it, and re-appending ours produces
        # a signed Atlassian download URL with a duplicated parameter.
        query: Mapping[str, Any] | None = clean_params or None

        for _ in range(MAX_DOWNLOAD_REDIRECTS + 1):
            hop = await self._one_download_hop(target, query, path, limit)
            if isinstance(hop, BinaryResponse):
                return hop
            target, query = hop, None

        raise ServiceError(
            f"{self._config.product} redirected {normalise_path(path)} more than "
            f"{MAX_DOWNLOAD_REDIRECTS} times. That is a redirect loop or an SSO portal, "
            "not an attachment."
        )

    async def _one_download_hop(
        self,
        target: Any,
        query: Mapping[str, Any] | None,
        path: str,
        limit: int,
    ) -> "BinaryResponse | httpx.URL":
        """One request: the bytes, or the next URL to try.

        Split out of :meth:`get_bytes` so the retry loop and the redirect loop
        are two loops in two places rather than one nest with a break whose
        target has to be worked out by reading it twice.
        """
        attempt = 0
        while True:
            try:
                async with self._client.stream(
                    "GET", target, params=query, headers={"Accept": "*/*"}
                ) as response:
                    if self._should_retry(response.status_code, attempt):
                        await response.aclose()
                        await asyncio.sleep(self._retry_delay(response, attempt))
                        attempt += 1
                        continue

                    if response.status_code in (301, 302, 303, 307, 308):
                        location = response.headers.get("location", "")
                        await response.aclose()
                        return self._same_origin_hop(location, response.url, path)

                    if response.status_code >= 400:
                        await response.aread()
                        self._check(response, path)

                    declared = response.headers.get("content-length", "")
                    if declared.isdigit() and int(declared) > limit:
                        await response.aclose()
                        raise ServiceError(
                            f"That attachment is {int(declared):,} bytes, over the "
                            f"{limit:,}-byte limit, so it was not downloaded. A file this "
                            "size would be dropped before the model ever saw it. Open it "
                            "in a browser instead."
                        )

                    chunks: list[bytes] = []
                    size = 0
                    oversize = False
                    async for chunk in response.aiter_bytes():
                        size += len(chunk)
                        if size > limit:
                            oversize = True
                            break
                        chunks.append(chunk)
                    if oversize:
                        raise ServiceError(
                            f"That attachment is larger than the {limit:,}-byte limit, so the "
                            "download was abandoned. Half a file is not a file: it would reach "
                            "the model as a decode error rather than a picture. Open it in a "
                            "browser instead."
                        )
                    raw = b"".join(chunks)
                    ctype = response.headers.get("content-type", "")
                    final_url = str(response.url)
            except httpx.HTTPError as exc:
                raise self._transport(exc) from None

            if _looks_like_html(raw[:512].decode("utf-8", errors="replace"), ctype):
                raise ServiceError(
                    f"{self._config.product} answered {normalise_path(path)} with HTML "
                    "instead of a file. That is an SSO or reverse-proxy login page, not the "
                    f"attachment. Check that the credential in {self._config.env_prefix}_TOKEN "
                    "is valid."
                )
            return BinaryResponse(
                raw, content_type=ctype, url=final_url, headers=response.headers
            )

    def _same_origin_hop(self, location: str, current: httpx.URL, path: str) -> httpx.URL:
        """Resolve a redirect, refusing to leave the configured instance.

        The credential rides on the client rather than on the request, so httpx
        would present it to whatever host a Location header names. That host is
        chosen by whoever can answer for the instance, which on a compromised
        or merely mis-proxied deployment is not the instance.
        """
        if not location:
            raise ServiceError(
                f"{self._config.product} redirected {normalise_path(path)} with no Location "
                "header. That is a broken response, not an attachment."
            )
        nxt = current.join(location)
        origin = httpx.URL(self._config.base_url)
        # httpx leaves `port` as None when the URL used the scheme's default,
        # so https://host and https://host:443 must compare equal.
        default = {"http": 80, "https": 443}
        same = (
            nxt.scheme == origin.scheme
            and nxt.host == origin.host
            and (nxt.port or default.get(nxt.scheme)) == (origin.port or default.get(origin.scheme))
        )
        if not same:
            raise ServiceError(
                f"{self._config.product} redirected the download to {nxt.scheme}://{nxt.host} "
                f"but {self._config.base_url_var} names {origin.scheme}://{origin.host}. The "
                "request was abandoned rather than presenting your credential to another host. "
                "If the instance really does serve attachments from a second hostname, point "
                f"{self._config.base_url_var} at the one that serves both."
            )
        return nxt

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
