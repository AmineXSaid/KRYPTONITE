"""jenkins-mcp: the URL shape, the console tail, and the honest empty answer.

The three things this file exists to pin, in order of how expensive they are to
get wrong:

* **The console tail must not fetch the whole log.** Jenkins' progressive log
  endpoint resets `start` to zero when it exceeds the log's length - the source
  calls it "text rolled over" - so the obvious way to discover the size, by
  asking for a huge offset, downloads two hundred megabytes instead of
  answering. The tail here is two requests, and the second one's `start` is
  asserted exactly.

* **`result: null` means running, not failed.** Jenkins leaves `result` null
  while a build is in progress. Reported as a failure of unknown kind, it makes
  an agent announce a broken build that is merely slow.

* **No artifacts is an answer.** Most builds archive nothing. An error here
  makes an agent report a failure that did not happen, and stop before reading
  the console log where the cause actually was.
"""

from __future__ import annotations

import httpx
import pytest

from jenkins_mcp import server as srv
from jenkins_mcp.shaping import (
    build_status,
    colour_to_status,
    find_failure_lines,
    flatten_jobs,
    looks_like_text,
    shape_artifact,
    shape_build,
    shape_job,
)
from readonly_client.config import ServiceConfig
from readonly_client.errors import NotFoundError, ReadOnlyViolation, ServiceError
from readonly_client.http import ReadOnlyClient, assert_read_only
from readonly_client.paths import jenkins as paths


# ── the URL shape ──────────────────────────────────────────────────────────


def test_a_folder_path_gets_one_job_segment_per_level() -> None:
    """Jenkins nests one `/job/` at a time. Joining with `/` produces a URL
    that 404s, and the failure reads as a missing job rather than a bad path."""
    assert paths.job_path("team/backend/build") == "/job/team/job/backend/job/build"
    assert paths.job_path("build") == "/job/build"


def test_a_pasted_jenkins_url_is_accepted_as_a_job_path() -> None:
    """Models paste the URL about as often as they type the path, and the
    `/job/` segments in it are the same information twice."""
    assert paths.job_path("/job/team/job/backend/job/build/") == (
        "/job/team/job/backend/job/build"
    )


def test_a_job_name_with_a_space_is_quoted() -> None:
    assert paths.job_path("my team/nightly build") == (
        "/job/my%20team/job/nightly%20build"
    )


def test_an_empty_job_path_is_refused_rather_than_hitting_the_root() -> None:
    """An empty path would silently address the Jenkins root, and a tool that
    answers about the whole instance when asked about one job is worse than
    one that errors."""
    for bad in ("", "   ", "/", "///", "job"):
        with pytest.raises(ValueError):
            paths.job_path(bad)


def test_build_aliases_reach_the_api_unchanged() -> None:
    """`lastFailedBuild` is a path segment Jenkins resolves itself, which is
    what lets "why did the last build fail" work with no number."""
    assert paths.build_api("a", "lastFailedBuild") == (
        "/job/a/lastFailedBuild/api/json"
    )
    assert "lastFailedBuild" in paths.BUILD_ALIASES


def test_an_artifact_path_keeps_its_directories_but_escapes_each_segment() -> None:
    assert paths.artifact("a", 7, "target/surefire reports/TEST-x.xml") == (
        "/job/a/7/artifact/target/surefire%20reports/TEST-x.xml"
    )


def test_dot_dot_is_stripped_from_an_artifact_path() -> None:
    """The read-only guard already makes a write impossible, so this is about
    not letting a model wander out of the archive by accident."""
    assert paths.artifact("a", 7, "../../../etc/passwd") == (
        "/job/a/7/artifact/etc/passwd"
    )


def test_the_builds_tree_carries_a_range() -> None:
    """Without `{0,N}` Jenkins serialises every build the job ever had, built
    server-side before a byte is sent. On a nightly job that is tens of
    thousands of records."""
    assert paths.builds_tree(20).endswith("{0,20}")
    assert paths.builds_tree(0).endswith("{0,1}")


def test_the_artifact_tree_does_not_ask_for_a_size_that_does_not_exist() -> None:
    """hudson.model.Run.Artifact has a getLength() but no @Exported on it, so
    `size` in a tree comes back empty and every artifact looks like 0 bytes."""
    assert "size" not in paths.ARTIFACTS_TREE
    assert "relativePath" in paths.ARTIFACTS_TREE


# ── the read-only surface ──────────────────────────────────────────────────


def test_the_jenkins_client_can_post_nowhere() -> None:
    """This matters more here than anywhere else: /build, /stop and /doDelete
    are POSTs one path segment away from the endpoints we read."""
    cfg = ServiceConfig(
        base_url="https://jenkins.test.internal",
        auth_mode="basic",
        username="builder",
        token="test-token-value-long-enough",
        product="Jenkins",
    )
    assert cfg.search_post_allowlist == ()
    for path in (
        "/job/a/build",
        "/job/a/7/stop",
        "/job/a/doDelete",
        paths.ROOT_API,
    ):
        with pytest.raises(ReadOnlyViolation):
            assert_read_only("POST", path, cfg.search_post_allowlist)


# ── status is never null ───────────────────────────────────────────────────


def test_a_running_build_reads_as_building_not_as_an_unknown_failure() -> None:
    assert build_status({"building": True, "result": None}) == "BUILDING"


def test_a_finished_build_reports_its_result() -> None:
    assert build_status({"building": False, "result": "FAILURE"}) == "FAILURE"
    assert build_status({"building": False, "result": "SUCCESS"}) == "SUCCESS"


def test_a_build_with_neither_is_unknown_not_a_crash() -> None:
    assert build_status({}) == "UNKNOWN"


def test_unstable_is_not_failure() -> None:
    """Yellow means the build succeeded and its tests did not. Collapsing the
    two reports every flaky suite as a broken build."""
    assert colour_to_status("yellow") == "UNSTABLE"
    assert colour_to_status("red") == "FAILURE"
    assert colour_to_status("blue") == "SUCCESS"


def test_the_anime_suffix_means_currently_building() -> None:
    """Jenkins encodes "running" as a suffix on the colour, which is easy to
    miss and changes what the status means."""
    assert colour_to_status("blue_anime") == "SUCCESS"
    job = shape_job({"name": "x", "color": "red_anime"})
    assert job["status"] == "FAILURE"
    assert job["building"] is True
    assert "building" not in shape_job({"name": "x", "color": "red"})


def test_an_unknown_colour_passes_through_rather_than_being_invented() -> None:
    assert colour_to_status("chartreuse") == "chartreuse"


# ── shaping ────────────────────────────────────────────────────────────────


def test_epoch_milliseconds_become_a_readable_time() -> None:
    """`timestamp: 1755859200000` forces a model to do arithmetic it gets
    wrong. Both forms are kept: one to read, one to compute with."""
    out = shape_build(
        {"number": 7, "result": "FAILURE", "timestamp": 1755859200000,
         "duration": 754000},
        full=True,
    )
    assert out["started_at"].startswith("2025-08-22T")
    assert out["duration"] == "12m 34s"
    assert out["duration_ms"] == 754000


def test_a_broken_timestamp_is_dropped_not_rendered_as_1970() -> None:
    out = shape_build({"number": 1, "timestamp": None, "duration": "soon"})
    assert "started_at" not in out
    assert "duration" not in out


def test_causes_and_changes_survive_because_they_are_the_investigation() -> None:
    out = shape_build(
        {
            "number": 7, "result": "FAILURE",
            "actions": [
                {"_class": "hudson.plugins.git.util.BuildData"},
                {"causes": [{"shortDescription": "Started by GitHub push by amine"}]},
            ],
            "changeSet": {"items": [
                {"commitId": "abcdef1234567890", "msg": "Bump timeout",
                 "author": {"fullName": "Amine"}},
            ]},
        },
        full=True,
    )
    assert out["causes"] == ["Started by GitHub push by amine"]
    assert out["changes"][0]["commit"] == "abcdef123456"
    assert out["changes"][0]["author"] == "Amine"


def test_an_action_without_causes_is_skipped_not_guessed_at() -> None:
    """`actions` is a heterogeneous list of plugin payloads; most entries have
    no causes at all."""
    out = shape_build(
        {"number": 1, "actions": [{"_class": "x"}, None, {"causes": None}]}, full=True
    )
    assert "causes" not in out


def test_a_folder_is_flattened_into_paths_the_next_tool_accepts() -> None:
    tree = {"jobs": [
        {"name": "backend", "fullName": "team/backend", "jobs": [
            {"name": "build", "fullName": "team/backend/build", "color": "red"},
        ]},
        {"name": "docs", "fullName": "docs", "color": "blue"},
    ]}
    rows = flatten_jobs(tree)
    paths_found = [r["path"] for r in rows]
    assert "team/backend/build" in paths_found
    assert "docs" in paths_found
    folder = next(r for r in rows if r["path"] == "team/backend")
    assert folder["is_folder"] is True
    assert folder["contains"] == 1


def test_an_artifact_row_leads_with_the_path_the_tool_takes() -> None:
    out = shape_artifact({"fileName": "TEST-x.xml",
                          "relativePath": "target/surefire-reports/TEST-x.xml"})
    assert out["path"] == "target/surefire-reports/TEST-x.xml"
    assert "size" not in out


# ── failure-line extraction ────────────────────────────────────────────────


def test_failure_lines_are_quoted_with_context() -> None:
    log = "\n".join([
        "downloading dep 1", "downloading dep 2", "compiling",
        "Exception in thread \"main\" java.lang.NullPointerException",
        "\tat com.acme.Auth.check(Auth.java:42)", "Finished: FAILURE",
    ])
    hits = find_failure_lines(log, context=1)
    assert any("NullPointerException" in h for h in hits)
    assert any("Auth.java:42" in h for h in hits)
    assert any("Finished: FAILURE" in h for h in hits)


def test_a_clean_log_produces_no_hits() -> None:
    assert find_failure_lines("compiling\nlinking\nFinished: SUCCESS\n") == []


def test_the_markers_do_not_fire_on_ordinary_build_chatter() -> None:
    """A marker list that matches "error" as a substring flags every line of a
    build that compiles error_handler.go, and two hundred false positives are
    worse than no summary at all."""
    log = "\n".join([
        "compiling internal/errorhandler/error_handler.go",
        "[INFO] no errors found",
        "wrote error-report.html",
        "Finished: SUCCESS",
    ])
    assert find_failure_lines(log) == []


def test_gaps_between_hits_are_marked_rather_than_silently_joined() -> None:
    """Two lines pulled from opposite ends of a log, printed adjacently, read
    as consecutive output and invent a causal link that is not there."""
    log = "\n".join(["Exception in thread A"] + ["noise"] * 50 + ["Finished: FAILURE"])
    hits = find_failure_lines(log, context=0)
    assert "…" in hits


def test_an_enormous_line_is_cut() -> None:
    hits = find_failure_lines("Finished: FAILURE " + "x" * 5000, context=0)
    assert len(hits[0]) <= 500


def test_the_text_artifact_test_is_by_extension_and_case_insensitive() -> None:
    assert looks_like_text("target/surefire-reports/TEST-x.XML")
    assert looks_like_text("build.log")
    assert not looks_like_text("target/app.jar")
    assert not looks_like_text("dist/bundle.tar.gz")


# ── the tools, driven end to end ───────────────────────────────────────────


class Recorder:
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
    def install(*replies: httpx.Response) -> Recorder:
        rec = Recorder(list(replies))
        cfg = ServiceConfig(
            base_url="https://jenkins.test.internal",
            auth_mode="basic",
            username="builder",
            token="test-token-value-long-enough",
            product="Jenkins",
            env_prefix="JENKINS",
            max_results_cap=50,
        )
        client = ReadOnlyClient(cfg)
        client._client = httpx.AsyncClient(
            transport=httpx.MockTransport(rec),
            base_url="https://jenkins.test.internal",
        )
        monkeypatch.setattr(srv, "_config", cfg)
        monkeypatch.setattr(srv, "_client", client)
        return rec

    return install


def _json(body, **headers) -> httpx.Response:
    return httpx.Response(200, json=body, headers=headers)


def _text(body: bytes, **headers) -> httpx.Response:
    h = {"content-type": "text/plain;charset=UTF-8"}
    h.update(headers)
    return httpx.Response(200, content=body, headers=h)


async def test_list_jobs_prunes_server_side(wired) -> None:
    rec = wired(_json({"jobs": [{"name": "build", "fullName": "build",
                                 "color": "blue"}]}))
    out = await srv.jenkins_list_jobs()
    assert rec.paths == ["/api/json"]
    assert rec.params()["tree"] == paths.JOBS_TREE
    assert out["jobs"][0]["status"] == "SUCCESS"


async def test_list_jobs_in_a_folder_addresses_the_folder(wired) -> None:
    rec = wired(_json({"jobs": []}))
    out = await srv.jenkins_list_jobs("team/backend")
    assert rec.paths == ["/job/team/job/backend/api/json"]
    assert "folder path" in out["note"]


async def test_list_builds_asks_for_only_the_page_it_wants(wired) -> None:
    rec = wired(_json({"builds": [
        {"number": 12, "result": None, "building": True, "timestamp": 1755859200000},
    ]}))
    out = await srv.jenkins_list_builds("team/backend/build", max_results=5)
    assert rec.params()["tree"].endswith("{0,5}")
    assert out["builds"][0]["status"] == "BUILDING"


async def test_get_build_defaults_to_lastbuild(wired) -> None:
    """"Why did the last build fail" should not require looking up a number."""
    rec = wired(_json({"number": 12, "result": "FAILURE"}))
    out = await srv.jenkins_get_build("a/b")
    assert rec.paths == ["/job/a/job/b/lastBuild/api/json"]
    assert out["status"] == "FAILURE"
    assert out["job"] == "a/b"


# ── the console tail: the expensive one to get wrong ───────────────────────


async def test_the_tail_is_two_requests_and_the_second_asks_for_the_end(
    wired,
) -> None:
    """The whole design in one test. First request: headers only, body
    abandoned. Second: exactly the tail."""
    huge = 200_000_000
    rec = wired(
        _text(b"x" * 100_000, **{"X-Text-Size": str(huge)}),
        _text(b"Finished: FAILURE\n", **{"X-Text-Size": str(huge)}),
    )
    out = await srv.jenkins_get_console("a/b", "12", max_bytes=60_000)

    assert len(rec.requests) == 2
    assert rec.paths == ["/job/a/job/b/12/logText/progressiveText"] * 2
    assert rec.params(0)["start"] == "0"
    assert int(rec.params(1)["start"]) == huge - 60_000
    assert out["log_bytes"] == huge
    assert out["truncated"] is True
    assert out["from_end"] is True
    assert "Finished: FAILURE" in out["failure_lines"][0]


async def test_the_tail_never_asks_for_a_start_past_the_end(wired) -> None:
    """Jenkins treats start > length as "the log rolled over" and answers with
    the WHOLE log from byte zero. Asking for a huge offset to discover the size
    cheaply does the exact opposite of what it looks like."""
    size = 1_000
    rec = wired(_text(b"short log\n", **{"X-Text-Size": str(size)}))
    await srv.jenkins_get_console("a/b", "12", max_bytes=60_000)
    for n in range(len(rec.requests)):
        assert int(rec.params(n)["start"]) <= size


async def test_a_log_smaller_than_the_cap_is_fetched_from_the_start(wired) -> None:
    rec = wired(_text(b"all of it\n", **{"X-Text-Size": "10"}))
    out = await srv.jenkins_get_console("a/b", "12", max_bytes=60_000)
    assert int(rec.params(1)["start"]) == 0
    assert out["from_end"] is False
    assert out["truncated"] is False


async def test_a_missing_size_header_falls_back_to_consoletext(wired) -> None:
    """No X-Text-Size means this is not the endpoint we think it is - an older
    instance, or a proxy stripping headers. /consoleText always works."""
    rec = wired(_text(b"log body\n"))
    out = await srv.jenkins_get_console("a/b", "12")
    assert rec.paths[-1] == "/job/a/job/b/12/consoleText"
    assert out["console"] == "log body\n"


async def test_a_running_build_says_the_log_is_not_finished(wired) -> None:
    """A log that stops mid-sentence looks like a crash. It is a build that has
    not got there yet, and an agent must not report the difference wrongly."""
    rec = wired(_text(b"still going\n",
                      **{"X-Text-Size": "500", "X-More-Data": "true"}))
    out = await srv.jenkins_get_console("a/b", "12")
    assert out["still_running"] is True
    assert "still running" in out["note"]
    assert len(rec.requests) == 2


async def test_whole_log_reads_from_the_start_in_one_request(wired) -> None:
    rec = wired(_text(b"from the top\n", **{"X-Text-Size": "999999"}))
    out = await srv.jenkins_get_console("a/b", "12", whole_log=True)
    assert len(rec.requests) == 1
    assert rec.params(0)["start"] == "0"
    assert out["from_end"] is False


# ── artifacts ──────────────────────────────────────────────────────────────


async def test_a_build_with_no_artifacts_answers_rather_than_erroring(
    wired,
) -> None:
    """Most builds archive nothing. An error here makes an agent report a
    failure that did not happen and stop before reading the console log."""
    wired(_json({"artifacts": []}))
    out = await srv.jenkins_list_artifacts("a/b", "12")
    assert out["artifacts"] == []
    assert out["returned"] == 0
    assert "jenkins_get_console" in out["note"]


async def test_artifacts_come_back_with_the_path_the_reader_takes(wired) -> None:
    rec = wired(_json({"artifacts": [
        {"fileName": "TEST-Auth.xml",
         "relativePath": "target/surefire-reports/TEST-Auth.xml"},
    ]}))
    out = await srv.jenkins_list_artifacts("a/b", "12")
    assert rec.params()["tree"] == paths.ARTIFACTS_TREE
    assert out["artifacts"][0]["path"] == "target/surefire-reports/TEST-Auth.xml"


async def test_a_text_artifact_is_read(wired) -> None:
    rec = wired(_text(b"<testsuite failures='1'/>"))
    out = await srv.jenkins_get_artifact("a/b", "target/TEST-x.xml", "12")
    assert rec.paths == ["/job/a/job/b/12/artifact/target/TEST-x.xml"]
    assert "testsuite" in out["content"]


async def test_a_binary_artifact_is_refused_before_the_request(wired) -> None:
    """Downloading a 400 MB tarball to conclude that it is a tarball is the
    mistake worth not making."""
    rec = wired(_text(b"PK\x03\x04"))
    out = await srv.jenkins_get_artifact("a/b", "target/app.jar", "12")
    assert rec.requests == []
    assert out["content"] is None
    assert "does not look like a text file" in out["refused"]


async def test_a_missing_artifact_points_at_the_listing_tool(wired) -> None:
    """404 here means the build archived nothing, or archived something else -
    and both lead to the same next call."""
    wired(httpx.Response(404, json={"message": "not found"},
                         headers={"content-type": "application/json"}))
    with pytest.raises(NotFoundError) as exc:
        await srv.jenkins_get_artifact("a/b", "target/missing.log", "12")
    assert "jenkins_list_artifacts" in str(exc.value)


async def test_an_empty_job_path_is_refused_before_the_network(wired) -> None:
    rec = wired(_json({}))
    with pytest.raises(ServiceError):
        await srv.jenkins_list_builds("   ")
    assert rec.requests == []
