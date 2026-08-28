"""The read-only guard. This is the test that matters most in the suite.

The claim being defended is not "we do not currently call POST" - that is a
property of today's code and would survive no refactor. It is "this client
cannot express a write", which has to hold for every method, every path, and
every way a caller might try to smuggle one past the check.

So the cases below are adversarial rather than illustrative: casing, whitespace,
path traversal that normalises back onto a write endpoint, absolute URLs to
another host, and prefix tricks against the search allowlist.

The allowlist itself is now per-client rather than a module global, and the
default is EMPTY. That is the property the first block below defends: a caller
that forgets to pass an allowlist gets GET and only GET, so adding a fifth
product cannot silently inherit Jira's one POST carve-out.
"""

from __future__ import annotations

import httpx
import pytest

from readonly_client.config import ServiceConfig
from readonly_client.errors import ReadOnlyViolation
from readonly_client.http import ReadOnlyClient, assert_read_only, normalise_path
from readonly_client.paths.atlassian import JIRA_SEARCH, SEARCH_POST_ALLOWLIST


def cfg(**over) -> ServiceConfig:
    base = dict(
        base_url="https://jira.test.internal",
        auth_mode="bearer",
        token="test-token-value-long-enough",
        product="Jira",
        base_url_var="JIRA_BASE_URL",
        env_prefix="ATLASSIAN",
        search_post_allowlist=SEARCH_POST_ALLOWLIST,
    )
    base.update(over)
    return ServiceConfig(**base)  # type: ignore[arg-type]


# ── the mutating verbs are refused outright ────────────────────────────────


@pytest.mark.parametrize(
    "method",
    ["PUT", "DELETE", "PATCH", "HEAD", "OPTIONS", "TRACE", "CONNECT", "PROPFIND"],
)
def test_mutating_methods_are_refused(method: str) -> None:
    """Anything outside {GET, POST} raises before a request is built."""
    with pytest.raises(ReadOnlyViolation) as exc:
        assert_read_only(method, "/rest/api/2/issue/ABC-1")
    assert "read-only" in str(exc.value)
    # The message must say nothing was sent, or a caller cannot tell whether
    # a partial write happened.
    assert "No request was made" in str(exc.value)


@pytest.mark.parametrize("method", ["put", "Delete", "pAtCh"])
def test_method_check_is_case_insensitive(method: str) -> None:
    """A lowercase verb is the same verb. Casing must not slip past."""
    with pytest.raises(ReadOnlyViolation):
        assert_read_only(method, "/rest/api/2/issue/ABC-1")


def test_empty_method_is_refused() -> None:
    with pytest.raises(ReadOnlyViolation):
        assert_read_only("", "/rest/api/2/search")


# ── GET is always fine ─────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "path",
    [
        "/rest/api/2/search",
        "/rest/api/2/issue/ABC-1",
        "/rest/api/content/search",
        "/anything/at/all",
    ],
)
def test_get_is_permitted_anywhere(path: str) -> None:
    assert_read_only("GET", path)  # must not raise


# ── POST is permitted only for allowlisted search paths ────────────────────


def test_post_to_search_is_permitted() -> None:
    """The single carve-out: Atlassian needs POST for long JQL."""
    assert_read_only("POST", JIRA_SEARCH, SEARCH_POST_ALLOWLIST)


def test_the_default_allowlist_is_empty() -> None:
    """Fail closed. A caller that passes no allowlist can only GET.

    This is the property that makes adding a product safe. GitLab and Jenkins
    have no POST search, so their configs name no allowlist - and if the
    default were Jira's, they would silently gain the right to POST to a Jira
    path that happens to exist on no GitLab instance today and might tomorrow.
    """
    with pytest.raises(ReadOnlyViolation) as exc:
        assert_read_only("POST", JIRA_SEARCH)
    assert "No request was made" in str(exc.value)
    # And explicitly passing an empty allowlist must behave identically.
    with pytest.raises(ReadOnlyViolation):
        assert_read_only("POST", JIRA_SEARCH, ())


def test_one_products_carve_out_does_not_reach_another_client() -> None:
    """The allowlist travels on the config, so it cannot leak sideways."""
    jira = ServiceConfig(
        base_url="https://jira.test.internal",
        auth_mode="bearer",
        token="test-token-value-long-enough",
        search_post_allowlist=SEARCH_POST_ALLOWLIST,
    )
    gitlab_shaped = ServiceConfig(
        base_url="https://gitlab.test.internal",
        auth_mode="header",
        token="test-token-value-long-enough",
        auth_header_name="PRIVATE-TOKEN",
    )
    assert_read_only("POST", JIRA_SEARCH, jira.search_post_allowlist)
    with pytest.raises(ReadOnlyViolation):
        assert_read_only("POST", JIRA_SEARCH, gitlab_shaped.search_post_allowlist)


@pytest.mark.parametrize(
    "path",
    [
        "/rest/api/2/issue",                       # create issue
        "/rest/api/2/issue/ABC-1/transitions",     # transition
        "/rest/api/2/issue/ABC-1/comment",         # comment
        "/rest/api/2/issueLink",                   # link issues
        "/rest/api/content",                       # create Confluence page
        "/rest/api/2/user",                        # create user
    ],
)
def test_post_to_write_endpoints_is_refused(path: str) -> None:
    """Every real Jira/Confluence write endpoint is unreachable by POST."""
    with pytest.raises(ReadOnlyViolation) as exc:
        assert_read_only("POST", path, SEARCH_POST_ALLOWLIST)
    assert "No request was made" in str(exc.value)


def test_post_allowlist_is_exact_not_prefix() -> None:
    """A path that merely starts with an allowlisted one is still refused.

    Guards written with startswith() let /search/../issue/X/transitions through.
    """
    with pytest.raises(ReadOnlyViolation):
        assert_read_only("POST", JIRA_SEARCH + "/../issue/ABC-1/transitions", SEARCH_POST_ALLOWLIST)
    with pytest.raises(ReadOnlyViolation):
        assert_read_only("POST", JIRA_SEARCH + "x", SEARCH_POST_ALLOWLIST)
    with pytest.raises(ReadOnlyViolation):
        assert_read_only("POST", JIRA_SEARCH + "/sub", SEARCH_POST_ALLOWLIST)


def test_post_traversal_that_normalises_to_a_write_is_refused() -> None:
    """The check runs on the normalised path, which is what the server sees."""
    sneaky = "/rest/api/2/search/../../2/issue/ABC-1/transitions"
    assert normalise_path(sneaky) == "/rest/api/2/issue/ABC-1/transitions"
    with pytest.raises(ReadOnlyViolation):
        assert_read_only("POST", sneaky, SEARCH_POST_ALLOWLIST)


def test_post_traversal_that_normalises_onto_search_is_allowed() -> None:
    """Normalisation is honest in both directions: this really is the search path."""
    assert normalise_path("/rest/api/2/foo/../search") == JIRA_SEARCH
    assert_read_only("POST", "/rest/api/2/foo/../search", SEARCH_POST_ALLOWLIST)


def test_absolute_url_is_reduced_to_its_path() -> None:
    """A caller cannot smuggle another host past the guard.

    The guard strips scheme and host so it always decides on a path. httpx
    would otherwise treat an absolute URL as an override of base_url.
    """
    assert normalise_path("https://evil.example/rest/api/2/issue") == "/rest/api/2/issue"
    with pytest.raises(ReadOnlyViolation):
        assert_read_only("POST", "https://evil.example/rest/api/2/issue", SEARCH_POST_ALLOWLIST)


def test_allowlist_contains_only_search() -> None:
    """A regression guard on the allowlist itself.

    If someone adds a path here, this test fails and forces them to justify it
    in review rather than slipping a write endpoint into the tuple.
    """
    assert SEARCH_POST_ALLOWLIST == ("/rest/api/2/search",)


# ── the guard fires inside the real client, before any I/O ─────────────────


async def test_client_refuses_write_without_touching_the_network() -> None:
    """End-to-end: the guard is in request(), not just in the helper.

    The transport raises if it is ever called, so reaching it fails the test.
    """

    def explode(request: httpx.Request) -> httpx.Response:  # pragma: no cover
        raise AssertionError(f"network was touched: {request.method} {request.url}")

    client = ReadOnlyClient(cfg())
    client._client = httpx.AsyncClient(
        transport=httpx.MockTransport(explode), base_url="https://jira.test.internal"
    )

    for method, path in [
        ("PUT", "/rest/api/2/issue/ABC-1"),
        ("DELETE", "/rest/api/2/issue/ABC-1"),
        ("POST", "/rest/api/2/issue/ABC-1/transitions"),
    ]:
        with pytest.raises(ReadOnlyViolation):
            await client.request(method, path)

    await client.aclose()


async def test_search_post_helper_reaches_the_network() -> None:
    """The carve-out genuinely works - it is not refused by accident."""
    seen: list[tuple[str, str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((request.method, request.url.path))
        return httpx.Response(200, json={"issues": [], "total": 0, "startAt": 0})

    client = ReadOnlyClient(cfg())
    client._client = httpx.AsyncClient(
        transport=httpx.MockTransport(handler), base_url="https://jira.test.internal"
    )

    await client.search_post(JIRA_SEARCH, json={"jql": "project = X"})
    assert seen == [("POST", JIRA_SEARCH)]

    await client.aclose()
