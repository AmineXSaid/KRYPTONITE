"""Error mapping. The 401/403 split is the assertion that earns its keep.

Collapsing those two into "access denied" is the single most expensive thing
this layer could do to a user: it sends someone to regenerate a token that was
working, while the actual fix - ask a project admin for access - goes
unmentioned. So the test asserts not just that the messages differ, but that
each names its own remedy and does not name the other's.
"""

from __future__ import annotations

import httpx
import pytest

from readonly_client.config import ServiceConfig
from readonly_client.errors import (
    ServiceError,
    AuthError,
    NotFoundError,
    PermissionError_,
    RateLimitError,
    TransportError,
    raise_for_response,
    transport_error,
)
from readonly_client.http import ReadOnlyClient
from readonly_client.paths.atlassian import (
    SEARCH_POST_ALLOWLIST,
    WRONG_PATH_HINT,
)


def cfg(**over) -> ServiceConfig:
    base = dict(
        base_url="https://jira.test.internal",
        auth_mode="bearer",
        token="test-token-value-long-enough",
        product="Jira",
        base_url_var="JIRA_BASE_URL",
        env_prefix="ATLASSIAN",
        wrong_path_hint=WRONG_PATH_HINT,
        search_post_allowlist=SEARCH_POST_ALLOWLIST,
    )
    base.update(over)
    return ServiceConfig(**base)  # type: ignore[arg-type]


def response(status: int, *, json=None, text: str | None = None, headers=None) -> httpx.Response:
    request = httpx.Request(
        "GET",
        "https://jira.test.internal/rest/api/2/search",
        headers={"authorization": "Bearer x"},
    )
    if json is not None:
        return httpx.Response(status, json=json, request=request, headers=headers or {})
    return httpx.Response(status, text=text or "", request=request, headers=headers or {})


def _raise(resp: httpx.Response, path: str = "/rest/api/2/search") -> None:
    raise_for_response(
        resp,
        product="Jira",
        path=path,
        base_url_var="JIRA_BASE_URL",
        env_prefix="ATLASSIAN",
        wrong_path_hint=WRONG_PATH_HINT,
    )


# ── 401 and 403 must never be the same message ─────────────────────────────


def test_401_names_the_credential() -> None:
    with pytest.raises(AuthError) as exc:
        _raise(response(401, json={"errorMessages": ["Unauthorized"]}))
    msg = str(exc.value)
    assert "Token rejected" in msg
    assert "ATLASSIAN_TOKEN" in msg
    assert "ATLASSIAN_AUTH_MODE" in msg
    # Must not send the user chasing a permission problem.
    assert "no permission" not in msg.lower()


def test_403_says_the_token_is_fine() -> None:
    with pytest.raises(PermissionError_) as exc:
        _raise(response(403, json={"errorMessages": ["Forbidden"]}))
    msg = str(exc.value)
    assert "Authenticated, but no permission" in msg
    # The load-bearing sentence: stop people regenerating a working token.
    assert "Regenerating the token will not help" in msg
    assert "Token rejected" not in msg


def test_401_and_403_are_distinct_types_and_messages() -> None:
    with pytest.raises(AuthError) as a:
        _raise(response(401))
    with pytest.raises(PermissionError_) as b:
        _raise(response(403))
    assert str(a.value) != str(b.value)
    assert type(a.value) is not type(b.value)


# ── 404: wrong path vs missing item ────────────────────────────────────────


def test_404_with_html_reads_as_a_wrong_path() -> None:
    """An HTML 404 means the request never reached the REST layer."""
    resp = response(
        404,
        text="<!DOCTYPE html><html><body>Not Found</body></html>",
        headers={"content-type": "text/html;charset=UTF-8"},
    )
    with pytest.raises(NotFoundError) as exc:
        _raise(resp, "/rest/api/3/search")
    msg = str(exc.value)
    assert "wrong API path" in msg
    assert "probe.py" in msg
    # Must mention the Cloud/DC split, which is the usual cause.
    assert "/wiki" in msg


def test_404_with_json_reads_as_a_missing_or_invisible_item() -> None:
    resp = response(404, json={"errorMessages": ["Issue does not exist"]})
    with pytest.raises(NotFoundError) as exc:
        _raise(resp, "/rest/api/2/issue/ABC-1")
    msg = str(exc.value)
    assert "does not exist, or it exists and your account cannot see it" in msg
    assert "wrong API path" not in msg


# ── 429 and 5xx ────────────────────────────────────────────────────────────


def test_429_mentions_retry_after_and_the_cap() -> None:
    with pytest.raises(RateLimitError) as exc:
        _raise(response(429))
    assert "Retry-After" in str(exc.value)


def test_500_is_attributed_to_the_instance() -> None:
    with pytest.raises(ServiceError) as exc:
        _raise(response(503))
    assert "server-side fault" in str(exc.value)


def test_atlassian_error_detail_is_surfaced() -> None:
    """Atlassian's own message is the only place an invalid JQL field is named."""
    resp = response(
        400, json={"errorMessages": ["Field 'sprintz' does not exist or is not searchable"]}
    )
    with pytest.raises(ServiceError) as exc:
        _raise(resp)
    assert "sprintz" in str(exc.value)


# ── transport ──────────────────────────────────────────────────────────────


def test_tls_failure_points_at_the_ca_bundle_and_refuses_to_suggest_disabling() -> None:
    """The important negative assertion in this file.

    verify=False on a connection carrying a personal token turns a config
    problem into an interception risk, so it must never be offered as a fix.
    """
    exc = httpx.ConnectError("[SSL: CERTIFICATE_VERIFY_FAILED] self signed certificate in chain")
    err = transport_error(
        exc,
        product="Jira",
        base_url="https://jira.test.internal",
        base_url_var="JIRA_BASE_URL",
        env_prefix="ATLASSIAN",
    )
    msg = str(err)
    assert "ATLASSIAN_CA_BUNDLE" in msg
    # The estate-wide fallback is worth naming: one corporate root CA usually
    # signs all four instances, and setting it four times is how three of them
    # end up stale.
    assert "MCP_CA_BUNDLE" in msg
    assert "Do not disable verification" in msg
    for forbidden in ("verify=False", "verify = False", "--insecure", "-k "):
        assert forbidden not in msg


def test_connect_timeout_suggests_vpn_not_a_bigger_timeout_alone() -> None:
    err = transport_error(
        httpx.ConnectTimeout("timed out"),
        product="Jira",
        base_url="https://jira.test.internal",
        base_url_var="JIRA_BASE_URL",
    )
    assert "VPN" in str(err)


def test_read_timeout_is_distinct_from_connect_timeout() -> None:
    connect = transport_error(
        httpx.ConnectTimeout("t"), product="Jira", base_url="u", base_url_var="V"
    )
    read = transport_error(
        httpx.ReadTimeout("t"), product="Jira", base_url="u", base_url_var="V"
    )
    assert str(connect) != str(read)
    assert "did not answer in time" in str(read)


def test_connect_error_names_the_base_url_variable() -> None:
    err = transport_error(
        httpx.ConnectError("Name or service not known"),
        product="Jira",
        base_url="https://jira.test.internal",
        base_url_var="JIRA_BASE_URL",
    )
    assert "JIRA_BASE_URL" in str(err)
    assert isinstance(err, TransportError)


# ── retry behaviour, driven through the real client ────────────────────────


async def test_429_is_retried_then_gives_up_at_the_cap() -> None:
    """Three retries, then a clear error. Not an infinite loop."""
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(429, headers={"retry-after": "0"}, request=request)

    client = ReadOnlyClient(cfg())
    client._client = httpx.AsyncClient(
        transport=httpx.MockTransport(handler), base_url="https://jira.test.internal"
    )
    with pytest.raises(RateLimitError):
        await client.get("/rest/api/2/search")
    # 1 initial + 3 retries
    assert calls["n"] == 4
    await client.aclose()


async def test_a_401_is_not_retried() -> None:
    """Retrying a rejected credential against SSO is how accounts get locked."""
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(401, json={}, request=request)

    client = ReadOnlyClient(cfg())
    client._client = httpx.AsyncClient(
        transport=httpx.MockTransport(handler), base_url="https://jira.test.internal"
    )
    with pytest.raises(AuthError):
        await client.get("/rest/api/2/search")
    assert calls["n"] == 1
    await client.aclose()


async def test_transient_503_recovers() -> None:
    """A retry that succeeds must return the payload, not the earlier failure."""
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(503, headers={"retry-after": "0"}, request=request)
        return httpx.Response(200, json={"total": 1}, request=request)

    client = ReadOnlyClient(cfg())
    client._client = httpx.AsyncClient(
        transport=httpx.MockTransport(handler), base_url="https://jira.test.internal"
    )
    assert await client.get("/rest/api/2/search") == {"total": 1}
    assert calls["n"] == 2
    await client.aclose()


async def test_html_login_page_is_named_as_sso_interception() -> None:
    """A 200 carrying HTML is what an SSO portal returns instead of the API."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            text="<html><body>Sign in</body></html>",
            headers={"content-type": "text/html"},
            request=request,
        )

    client = ReadOnlyClient(cfg())
    client._client = httpx.AsyncClient(
        transport=httpx.MockTransport(handler), base_url="https://jira.test.internal"
    )
    with pytest.raises(ServiceError) as exc:
        await client.get("/rest/api/2/search")
    assert "SSO" in str(exc.value)
    await client.aclose()
