"""gitlab-mcp: the encoding contract, the paging honesty, and the caps.

Three classes of bug are what this file is here to catch, and none of them
looks like a bug when it happens:

* **Encoding.** A project path is `group/sub/repo` and has to travel as one
  path segment. Get it wrong and every call 404s; get it half right and only
  nested groups fail, which is most of a corporate instance.
* **Paging read as truth.** GitLab reports counts in headers and stops sending
  `x-total` above 10,000 records. Reporting that as `total: 0` tells a model it
  has the whole answer when it has the first page.
* **Version drift.** `collapsed` and `too_large` arrived on the diffs endpoint
  in GitLab 18.4. On an older instance they are absent, and absent is not
  False - claiming a diff is complete when we do not know is the failure mode
  that produces a confidently wrong review.
"""

from __future__ import annotations

import base64

import httpx
import pytest

from gitlab_mcp.shaping import (
    BinaryFile,
    decode_file,
    paginated,
    shape_blob_hit,
    shape_diffs,
    shape_merge_request,
    shape_project,
)
from readonly_client.config import ServiceConfig, load_config
from readonly_client.errors import ReadOnlyViolation, ServiceError
from readonly_client.http import ReadOnlyClient, assert_read_only
from readonly_client.paths import gitlab as paths


# ── the URL contract ───────────────────────────────────────────────────────


def test_a_nested_project_path_becomes_one_segment() -> None:
    """`group/sub/repo` is ONE path segment. Left unencoded it is three, and
    every call against a subgroup 404s."""
    assert paths.project("group/sub/repo") == "/api/v4/projects/group%2Fsub%2Frepo"


def test_a_numeric_project_id_passes_through() -> None:
    assert paths.project(13083) == "/api/v4/projects/13083"
    assert paths.project("13083") == "/api/v4/projects/13083"


def test_a_file_path_is_encoded_but_its_dots_are_not() -> None:
    """doc/api/rest/_index.md states the rule as "encode the /" and its own
    examples leave the dot alone. The parameter tables show %2E; we follow the
    rule, and this test is where that decision is written down."""
    assert paths.file(1, "src/main.go") == (
        "/api/v4/projects/1/repository/files/src%2Fmain.go"
    )


def test_encoding_covers_the_characters_that_actually_appear() -> None:
    for raw, want in [
        ("a b", "a%20b"),
        ("feature/JIRA-1#2", "feature%2FJIRA-1%232"),
        ("group/sub", "group%2Fsub"),
        ("100%", "100%25"),
    ]:
        assert paths.encode(raw) == want, raw


def test_httpx_does_not_re_encode_an_encoded_segment() -> None:
    """The whole scheme rests on this. If httpx escaped the percent sign,
    `%2F` would reach GitLab as `%252F` and every nested path would 404."""
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        return httpx.Response(200, json={})

    client = httpx.Client(
        transport=httpx.MockTransport(handler), base_url="https://gl.test"
    )
    client.get(paths.file("group/sub/repo", "a/b.go"))
    client.close()
    assert seen == [
        "https://gl.test/api/v4/projects/group%2Fsub%2Frepo"
        "/repository/files/a%2Fb.go"
    ]


def test_the_iid_path_is_not_the_id_path() -> None:
    """A merge request is addressed by its per-project iid. Passing the global
    id returns a different MR or a 404, and neither is visible in a result."""
    assert paths.merge_request("g/r", 7) == "/api/v4/projects/g%2Fr/merge_requests/7"
    assert paths.merge_request_diffs("g/r", 7) == (
        "/api/v4/projects/g%2Fr/merge_requests/7/diffs"
    )


# ── auth and the read-only surface ─────────────────────────────────────────


def test_the_token_travels_in_private_token_not_authorization(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """GitLab documents PRIVATE-TOKEN as the home for a personal access token.
    The same token sent as `Authorization: Bearer` 401s on older self-managed
    instances, and that 401 is indistinguishable from a bad credential."""
    monkeypatch.setenv("GITLAB_BASE_URL", "https://gitlab.test.internal")
    monkeypatch.setenv("GITLAB_AUTH_MODE", "header")
    monkeypatch.setenv("GITLAB_TOKEN", "glpat-token-value-long-enough")
    cfg = load_config(
        "GITLAB_BASE_URL",
        "GitLab",
        env_prefix="GITLAB",
        auth_modes=("header",),
        default_auth_mode="header",
        auth_header_name="PRIVATE-TOKEN",
    )
    assert cfg.auth_headers() == {"PRIVATE-TOKEN": "glpat-token-value-long-enough"}
    assert "Authorization" not in cfg.auth_headers()


def test_the_gitlab_client_can_post_nowhere() -> None:
    """gitlab-mcp passes no search_post_allowlist, so unlike jira-mcp its
    client has no POST carve-out at all. Every path is refused."""
    cfg = ServiceConfig(
        base_url="https://gitlab.test.internal",
        auth_mode="header",
        token="glpat-token-value-long-enough",
        auth_header_name="PRIVATE-TOKEN",
        product="GitLab",
    )
    assert cfg.search_post_allowlist == ()
    for path in (
        paths.SEARCH,
        paths.PROJECTS,
        paths.project_search("g/r"),
        "/api/v4/projects/1/merge_requests/1/notes",
    ):
        with pytest.raises(ReadOnlyViolation):
            assert_read_only("POST", path, cfg.search_post_allowlist)


async def test_the_header_reaches_the_wire() -> None:
    """Config in isolation is not proof; the client has to actually send it."""
    seen: list[httpx.Headers] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.headers)
        return httpx.Response(200, json=[])

    cfg = ServiceConfig(
        base_url="https://gitlab.test.internal",
        auth_mode="header",
        token="glpat-token-value-long-enough",
        auth_header_name="PRIVATE-TOKEN",
        product="GitLab",
    )
    c = ReadOnlyClient(cfg)
    c._client = httpx.AsyncClient(
        transport=httpx.MockTransport(handler),
        base_url="https://gitlab.test.internal",
        headers=dict(cfg.auth_headers()),
    )
    await c.get(paths.PROJECTS)
    await c.aclose()
    assert seen[0]["private-token"] == "glpat-token-value-long-enough"
    assert "authorization" not in seen[0]


# ── paging is reported honestly ────────────────────────────────────────────


def test_a_missing_total_is_null_and_explained_not_zero() -> None:
    """GitLab omits x-total above 10,000 records. Zero would tell a model it
    had the whole set when it had page one of hundreds."""
    out = paginated([{"a": 1}], total=None, next_page=2, page=1, per_page=20)
    assert out["total"] is None
    assert out["has_more"] is True
    assert "10,000" in out["total_unavailable"]


def test_a_real_total_carries_no_apology() -> None:
    out = paginated([{"a": 1}], total=1, next_page=None, page=1, per_page=20)
    assert out["total"] == 1
    assert out["has_more"] is False
    assert "total_unavailable" not in out


def test_returned_counts_the_rows_not_the_page_size() -> None:
    out = paginated([{}, {}, {}], total=97, next_page=2, page=1, per_page=20)
    assert (out["returned"], out["total"]) == (3, 97)


async def test_paging_is_read_out_of_the_headers() -> None:
    """GitLab has no envelope around the array - the counts are ONLY in
    headers, so a client that returns the parsed body alone loses them."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json=[{"id": 1, "path_with_namespace": "g/r", "name": "r"}],
            headers={"x-total": "97", "x-next-page": "2", "x-page": "1",
                     "x-per-page": "20"},
        )

    cfg = ServiceConfig(
        base_url="https://gitlab.test.internal", auth_mode="header",
        token="glpat-token-value-long-enough", auth_header_name="PRIVATE-TOKEN",
    )
    c = ReadOnlyClient(cfg)
    c._client = httpx.AsyncClient(
        transport=httpx.MockTransport(handler), base_url="https://gitlab.test.internal"
    )
    resp = await c.get_full(paths.PROJECTS)
    assert resp.header_int("x-total") == 97
    assert resp.header_int("x-next-page") == 2
    assert resp.header_int("x-nonexistent") is None
    assert resp.data[0]["path_with_namespace"] == "g/r"
    await c.aclose()


# ── shaping ────────────────────────────────────────────────────────────────


def test_a_project_row_drops_the_hundred_keys_and_keeps_the_six() -> None:
    raw = {
        "id": 7, "path_with_namespace": "platform/gateway", "name": "gateway",
        "default_branch": "main", "web_url": "https://gl/platform/gateway",
        "description": "edge", "_links": {"self": "..."}, "avatar_url": "...",
        "container_expiration_policy": {"enabled": True},
        "permissions": {"project_access": None}, "namespace": {"full_path": "platform"},
    }
    out = shape_project(raw)
    assert out["path"] == "platform/gateway"
    assert out["default_branch"] == "main"
    for noise in ("_links", "avatar_url", "container_expiration_policy", "permissions"):
        assert noise not in out


def test_archived_is_reported_only_when_true() -> None:
    """An archived repo looks current and is not, so it is worth a key. But
    `archived: false` on forty rows is forty wasted lines."""
    assert shape_project({"id": 1, "archived": True})["archived"] is True
    assert "archived" not in shape_project({"id": 1, "archived": False})


def test_a_merge_request_leads_with_iid_never_id() -> None:
    raw = {"id": 90210, "iid": 7, "title": "Fix retry", "state": "opened",
           "author": {"username": "amine", "name": "A", "avatar_url": "x"},
           "source_branch": "fix", "target_branch": "main",
           "web_url": "https://gl/x/-/merge_requests/7"}
    out = shape_merge_request(raw)
    assert out["iid"] == 7
    assert "id" not in out
    assert out["author"] == "amine"


def test_a_draft_says_so_by_either_field_name() -> None:
    """`work_in_progress` was the old name and still appears on older
    instances; both mean the same thing to a reviewer."""
    assert shape_merge_request({"iid": 1, "draft": True})["draft"] is True
    assert shape_merge_request({"iid": 1, "work_in_progress": True})["draft"] is True
    assert "draft" not in shape_merge_request({"iid": 1, "draft": False})


def test_the_pipeline_status_survives_because_it_is_the_point() -> None:
    out = shape_merge_request(
        {"iid": 1, "head_pipeline": {"status": "failed", "web_url": "https://gl/p/1",
                                     "id": 5, "sha": "abc"}},
        full=True,
    )
    assert out["pipeline"] == {"status": "failed", "url": "https://gl/p/1"}


# ── diff caps ──────────────────────────────────────────────────────────────


def test_one_huge_file_cannot_eat_the_whole_budget() -> None:
    """Without a per-file cap, a generated lockfile crowds out every real
    change and the review is of nothing."""
    entries = [
        {"old_path": "yarn.lock", "new_path": "yarn.lock", "diff": "+x\n" * 20_000},
        {"old_path": "src/auth.go", "new_path": "src/auth.go", "diff": "+real\n"},
    ]
    out = shape_diffs(entries, per_file_bytes=500, total_bytes=5_000)
    lock, auth = out["files"]
    assert lock["diff_truncated"] is True
    assert len(lock["diff"]) == 500
    assert lock["diff_full_bytes"] == 60_000
    # The real change survived, which is the entire point of the per-file cap.
    assert auth["diff"] == "+real\n"
    assert "diff_truncated" not in auth


def test_files_past_the_total_budget_are_counted_not_dropped_silently() -> None:
    entries = [
        {"old_path": f"f{n}.go", "new_path": f"f{n}.go", "diff": "+x\n" * 100}
        for n in range(20)
    ]
    out = shape_diffs(entries, per_file_bytes=1_000, total_bytes=2_500)
    assert out["files_omitted"] > 0
    assert out["returned"] + out["files_omitted"] == 20
    assert "gitlab_get_file" in out["omitted_note"]


def test_a_flag_absent_before_gitlab_18_4_is_not_reported_as_false() -> None:
    """`collapsed` and `too_large` arrived in 18.4. On an older instance they
    are missing, and 'not flagged' is not the same claim as 'not truncated'."""
    old = shape_diffs([{"old_path": "a", "new_path": "a", "diff": "+x"}])["files"][0]
    assert "collapsed" not in old
    assert "too_large" not in old

    new = shape_diffs(
        [{"old_path": "a", "new_path": "a", "diff": "+x",
          "collapsed": False, "too_large": False}]
    )["files"][0]
    assert new["collapsed"] is False
    assert new["too_large"] is False


def test_a_file_gitlab_refused_to_diff_keeps_its_path_and_says_why() -> None:
    """Knowing that src/auth.go changed is most of the value, even with no
    hunks. Dropping the row loses that."""
    out = shape_diffs([{"old_path": "big.bin", "new_path": "big.bin", "too_large": True}])
    row = out["files"][0]
    assert row["new_path"] == "big.bin"
    assert "too large" in row["diff_omitted"]


def test_renames_and_deletions_are_flagged() -> None:
    out = shape_diffs([
        {"old_path": "a.go", "new_path": "b.go", "renamed_file": True, "diff": ""},
        {"old_path": "c.go", "new_path": "c.go", "deleted_file": True, "diff": ""},
    ])
    assert out["files"][0]["renamed_file"] is True
    assert out["files"][1]["deleted_file"] is True


# ── file content ───────────────────────────────────────────────────────────


def _payload(data: bytes, **over) -> dict:
    base = {
        "file_path": "src/main.go", "ref": "main", "size": len(data),
        "encoding": "base64", "content": base64.b64encode(data).decode(),
        "last_commit_id": "abc123",
    }
    base.update(over)
    return base


def test_a_text_file_comes_back_decoded() -> None:
    out = decode_file(_payload(b"package main\n"))
    assert out["content"] == "package main\n"
    assert out["path"] == "src/main.go"
    assert "truncated" not in out


def test_a_binary_file_is_refused_with_its_size_not_dumped_as_base64() -> None:
    """A model handed the base64 of a PNG has spent thirty thousand tokens on
    nothing. Its size and type are the useful answer."""
    png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 2000
    with pytest.raises(BinaryFile) as exc:
        decode_file(_payload(png, file_path="logo.png"))
    assert "binary" in str(exc.value)
    assert "logo.png" in str(exc.value)


def test_a_utf8_file_with_no_nul_is_text_even_with_high_bytes() -> None:
    """The NUL test is what git uses. Accented text and emoji are not binary,
    and refusing them would make the tool useless outside ASCII."""
    out = decode_file(_payload("héllo — ✅\n".encode()))
    assert "héllo" in out["content"]


def test_a_large_file_is_cut_and_says_so() -> None:
    out = decode_file(_payload(b"x" * 5_000), max_bytes=1_000)
    assert len(out["content"]) == 1_000
    assert out["truncated"] is True
    assert "gitlab_search_code" in out["note"]


def test_undecodable_content_is_a_refusal_not_a_crash() -> None:
    with pytest.raises(BinaryFile):
        decode_file({"file_path": "x", "encoding": "base64", "content": None})


# ── search hits ────────────────────────────────────────────────────────────


def test_a_blob_hit_keeps_the_line_number_that_makes_it_actionable() -> None:
    out = shape_blob_hit({
        "basename": "loader", "data": "func Load() {\n", "path": "internal/loader.go",
        "filename": "internal/loader.go", "id": None, "ref": "main",
        "startline": 42, "project_id": 6,
    })
    assert out["path"] == "internal/loader.go"
    assert out["startline"] == 42
    assert out["match"] == "func Load() {\n"


def test_a_long_match_is_cut() -> None:
    out = shape_blob_hit({"path": "a", "data": "x" * 5_000}, max_data=100)
    assert len(out["match"]) == 100
    assert out["match_truncated"] is True


# ── the tools, driven end to end ───────────────────────────────────────────
#
# Everything above tests a piece. These drive the actual tool functions against
# a mock transport, which is the only place the WIRING is checked: that
# gitlab_search_code really sends scope=blobs, that gitlab_list_projects really
# sends simple=true, that the right path function is called for the right tool.
# A shaping test cannot catch a tool that calls the wrong endpoint perfectly.

from gitlab_mcp import server as srv  # noqa: E402


class Recorder:
    """Captures each request and replies from a scripted queue."""

    def __init__(self, replies: list[httpx.Response]) -> None:
        self.replies = replies
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return self.replies[min(len(self.requests) - 1, len(self.replies) - 1)]

    @property
    def paths(self) -> list[str]:
        return [r.url.raw_path.decode().split("?")[0] for r in self.requests]

    def params(self, n: int = 0) -> dict[str, str]:
        return dict(self.requests[n].url.params)


@pytest.fixture
def wired(monkeypatch: pytest.MonkeyPatch):
    """Install a client whose transport is scripted, and hand back the recorder."""

    def install(*replies: httpx.Response) -> Recorder:
        rec = Recorder(list(replies))
        cfg = ServiceConfig(
            base_url="https://gitlab.test.internal",
            auth_mode="header",
            token="glpat-token-value-long-enough",
            auth_header_name="PRIVATE-TOKEN",
            product="GitLab",
            env_prefix="GITLAB",
            max_results_cap=50,
        )
        client = ReadOnlyClient(cfg)
        client._client = httpx.AsyncClient(
            transport=httpx.MockTransport(rec),
            base_url="https://gitlab.test.internal",
        )
        monkeypatch.setattr(srv, "_config", cfg)
        monkeypatch.setattr(srv, "_client", client)
        return rec

    return install


def _json(body, **headers) -> httpx.Response:
    return httpx.Response(200, json=body, headers=headers)


async def test_list_projects_asks_for_the_small_record(wired) -> None:
    """`simple=true` is the difference between six keys a row and a hundred."""
    rec = wired(_json([{"id": 1, "path_with_namespace": "g/r", "name": "r"}],
                      **{"x-total": "1", "x-page": "1", "x-per-page": "20"}))
    out = await srv.gitlab_list_projects(search="gate")
    assert rec.paths == ["/api/v4/projects"]
    p = rec.params()
    assert p["simple"] == "true"
    assert p["search"] == "gate"
    assert p["membership"] == "true"
    assert out["projects"][0]["path"] == "g/r"
    assert out["total"] == 1


async def test_membership_false_is_omitted_not_sent_as_the_string_false(
    wired,
) -> None:
    """GitLab reads the presence of the parameter. `membership=false` as a
    string is truthy to Grape and would silently restrict the search that was
    explicitly widened."""
    rec = wired(_json([]))
    await srv.gitlab_list_projects(membership=False)
    assert "membership" not in rec.params()


async def test_page_size_is_clamped_to_gitlabs_own_maximum(wired) -> None:
    rec = wired(_json([]))
    await srv.gitlab_list_projects(max_results=9999)
    assert int(rec.params()["per_page"]) <= paths.MAX_PER_PAGE


async def test_search_code_is_project_scoped_and_asks_for_blobs(wired) -> None:
    """Instance-wide blob search needs Premium plus Elasticsearch; the
    project-scoped one needs neither, which is why it is the default."""
    rec = wired(_json([{"path": "a.go", "data": "x", "startline": 1}]))
    await srv.gitlab_search_code("group/sub/repo", "connectTimeout filename:*.go")
    assert rec.paths == ["/api/v4/projects/group%2Fsub%2Frepo/search"]
    p = rec.params()
    assert p["scope"] == "blobs"
    assert p["search"] == "connectTimeout filename:*.go"


async def test_an_empty_code_search_explains_itself(wired) -> None:
    """An empty list reads as "not in the codebase". It can equally mean the
    default branch was searched and the code is on another one."""
    wired(_json([]))
    out = await srv.gitlab_search_code("g/r", "nothing")
    assert out["hits"] == []
    assert "ref" in out["note"]


async def test_an_empty_query_is_refused_before_the_network(wired) -> None:
    rec = wired(_json([]))
    with pytest.raises(ServiceError):
        await srv.gitlab_search_code("g/r", "   ")
    assert rec.requests == []


async def test_a_404_on_search_names_both_possible_causes(wired) -> None:
    """404 here means "no such project" OR "no /search on this instance", and
    reporting only the first sends someone to re-check a correct path."""
    rec = wired(httpx.Response(404, json={"message": "404 Project Not Found"}))
    with pytest.raises(Exception) as exc:
        await srv.gitlab_search_code("g/r", "x")
    assert "probe.py --gitlab" in str(exc.value)
    assert len(rec.requests) == 1


async def test_get_file_sends_the_ref_and_decodes(wired) -> None:
    body = _payload(b"package main\n")
    rec = wired(_json(body))
    out = await srv.gitlab_get_file("group/sub/repo", "src/main.go", ref="develop")
    assert rec.paths == [
        "/api/v4/projects/group%2Fsub%2Frepo/repository/files/src%2Fmain.go"
    ]
    assert rec.params()["ref"] == "develop"
    assert out["content"] == "package main\n"


async def test_get_file_defaults_ref_to_head_rather_than_guessing_main(
    wired,
) -> None:
    """`ref` is required by the API. HEAD is GitLab's own "whatever the default
    branch is"; hardcoding `main` breaks every repo still on `master`."""
    rec = wired(_json(_payload(b"x")))
    await srv.gitlab_get_file("g/r", "a.go")
    assert rec.params()["ref"] == "HEAD"


async def test_a_binary_file_returns_a_refusal_not_an_error(wired) -> None:
    """The model asked a reasonable question; "it is a 2 KB binary" IS the
    answer, and raising would make an agent report a failure instead."""
    png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 2000
    wired(_json(_payload(png, file_path="logo.png")))
    out = await srv.gitlab_get_file("g/r", "logo.png")
    assert out["content"] is None
    assert "binary" in out["refused"]
    assert out["size"] == len(png)


async def test_a_leading_slash_on_a_path_is_tolerated(wired) -> None:
    """Models write `/src/main.go` about half the time, and GitLab 404s on the
    empty leading segment."""
    rec = wired(_json(_payload(b"x")))
    await srv.gitlab_get_file("g/r", "/src/main.go")
    assert rec.paths[0].endswith("/files/src%2Fmain.go")


async def test_list_merge_requests_defaults_to_open_and_newest_first(wired) -> None:
    rec = wired(_json([{"iid": 7, "title": "t", "state": "opened"}],
                      **{"x-total": "1"}))
    out = await srv.gitlab_list_merge_requests("g/r")
    p = rec.params()
    assert (p["state"], p["order_by"], p["sort"]) == ("opened", "updated_at", "desc")
    assert out["merge_requests"][0]["iid"] == 7


async def test_an_invalid_state_is_refused_before_the_network(wired) -> None:
    """GitLab answers an unknown state with an empty list, which reads as "no
    merge requests" - the most misleading possible answer to a typo."""
    rec = wired(_json([]))
    with pytest.raises(ServiceError):
        await srv.gitlab_list_merge_requests("g/r", state="open")
    assert rec.requests == []


async def test_get_merge_request_does_not_fetch_the_diff_unless_asked(
    wired,
) -> None:
    rec = wired(_json({"iid": 7, "title": "t", "state": "opened"}))
    await srv.gitlab_get_merge_request("g/r", 7)
    assert rec.paths == ["/api/v4/projects/g%2Fr/merge_requests/7"]


async def test_include_diff_uses_diffs_not_the_deprecated_changes(wired) -> None:
    """`/changes` is deprecated and returns every file unpaginated, which is
    unreadable on a large MR."""
    rec = wired(
        _json({"iid": 7, "title": "t", "state": "opened"}),
        _json([{"old_path": "a.go", "new_path": "a.go", "diff": "+x\n"}]),
    )
    out = await srv.gitlab_get_merge_request("g/r", 7, include_diff=True)
    assert rec.paths[1] == "/api/v4/projects/g%2Fr/merge_requests/7/diffs"
    assert "changes" not in rec.paths[1]
    assert out["diff"]["files"][0]["new_path"] == "a.go"
