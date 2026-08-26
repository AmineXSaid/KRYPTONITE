"""The one HTTP client both servers use, and the read-only guard inside it.

The guard is the reason this module exists. "Read-only" enforced by convention
means every future tool author has to remember; enforced here it means a write
is not expressible. :meth:`ReadOnlyClient.request` raises before a request
object is constructed, so there is no code path from an MCP tool to a mutation
even if a tool asks for one.

Two things the guard is careful about:

* **POST is allowed only for search.** Atlassian's JQL search takes POST so a
  long JQL string can travel in a body. That single carve-out is scoped to an
  exact-match allowlist of paths, checked after normalising ``..`` segments, so
  it cannot be widened into ``/issue/KEY-1/transitions``.
* **The check is on the normalised path.** ``/rest/api/2/search/../issue/X``
  resolves to ``/rest/api/2/issue/X`` at the server but would pass a naive
  ``startswith`` test. It is normalised first, then matched exactly.
"""

from __future__ import annotations

import asyncio
import posixpath
from typing import Any, Mapping
from urllib.parse import urlsplit

import httpx

from .config import AtlassianConfig
from .errors import (
    AtlassianError,
    RateLimitError,
    ReadOnlyViolation,
    raise_for_response,
    transport_error,
)
from .paths import ALLOWED_METHODS, SEARCH_POST_ALLOWLIST

MAX_RETRIES = 3
# Only these are worth retrying. A 401/403/404 will fail identically on retry,
# and retrying a 4xx against an SSO-fronted instance is how an account gets
# locked out.
RETRY_STATUSES = frozenset({429, 502, 503, 504})


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


def assert_read_only(method: str, path: str) -> None:
    """Raise unless ``method`` on ``path`` is a read.

    Separated from the client so it can be tested directly and reused by
    anything that builds a request outside :class:`ReadOnlyClient`.
    """
    m = (method or "").upper()
    if m not in ALLOWED_METHODS:
        raise ReadOnlyViolation(
            f"{m or '<empty>'} is not permitted: this client is read-only and "
            "builds GET requests only (plus POST to the search endpoints listed "
            "in paths.SEARCH_POST_ALLOWLIST). No request was made."
        )
    if m == "GET":
        return

    clean = normalise_path(path)
    if clean not in SEARCH_POST_ALLOWLIST:
        raise ReadOnlyViolation(
            f"POST {clean} is not permitted. POST is allowed only for the search "
            f"endpoints {list(SEARCH_POST_ALLOWLIST)}, where Atlassian requires a "
            "request body for long JQL. No request was made."
        )


class ReadOnlyClient:
    """An httpx wrapper that can only read.

    One instance per product per process. Holds a connection pool, so it is
    created at server startup and closed at shutdown rather than per call.
    """

    def __init__(self, config: AtlassianConfig) -> None:
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
        self._client = httpx.AsyncClient(
            base_url=config.base_url,
            timeout=timeout,
            verify=verify,
            # httpx reads HTTPS_PROXY / NO_PROXY from the environment when
            # trust_env is on, which is what a corporate proxy needs.
            trust_env=True,
            follow_redirects=False,
            headers={
                "Authorization": config.auth_header(),
                "Accept": "application/json",
                # Atlassian DC returns an HTML login page instead of a 401 to
                # clients it thinks are browsers. This header is what makes it
                # answer with JSON, and without it a bad token surfaces as an
                # unparseable 200.
                "X-Atlassian-Token": "no-check",
                "User-Agent": "atlassian-mcp/1.0 (read-only)",
            },
        )

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
        assert_read_only(method, path)

        clean_params = {k: v for k, v in (params or {}).items() if v is not None}
        attempt = 0
        while True:
            try:
                response = await self._client.request(
                    method.upper(), path, params=clean_params or None, json=json
                )
            except httpx.HTTPError as exc:
                raise transport_error(
                    exc,
                    product=self._config.product,
                    base_url=self._config.base_url,
                    base_url_var=self._config.base_url_var,
                ) from None

            if response.status_code in RETRY_STATUSES and attempt < MAX_RETRIES:
                await asyncio.sleep(self._retry_delay(response, attempt))
                attempt += 1
                continue

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
            )

            if not response.content:
                return {}
            try:
                return response.json()
            except ValueError:
                raise AtlassianError(
                    f"{self._config.product} returned a non-JSON body for "
                    f"{normalise_path(path)} (content-type "
                    f"{response.headers.get('content-type', 'unknown')!r}). On Data "
                    "Center this usually means an SSO portal intercepted the request "
                    "and answered with a login page instead of the API."
                ) from None

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
