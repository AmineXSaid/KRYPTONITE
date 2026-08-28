#!/usr/bin/env python3
"""Standalone connectivity and capability probe. No MCP wiring involved.

Run this FIRST, before trusting anything in ``readonly_client/paths/``. It
answers the questions the build environment could not:

  1. Is the instance reachable from this machine (DNS, proxy, VPN)?
  2. Does TLS verify, or is a corporate CA bundle needed?
  3. Is the credential accepted, and in which auth mode?
  4. Is the API the shape we built for?

Question 4 is different for each product, and is the one that matters:

    Jira/Confluence  Data Center or Cloud. They diverge enough that a client
                     built for the wrong one fails confusingly: Jira Cloud has
                     retired the offset-paginated /rest/api/2/search that Data
                     Center still serves, and Confluence Cloud puts everything
                     behind /wiki.
    GitLab           the version, and whether project-scoped blob search
                     actually works here - it needs no licence tier and no
                     Elasticsearch, but "needs none" is a claim about GitLab,
                     not about your instance's configuration.
    Jenkins          whether /logText/progressiveText returns X-Text-Size. The
                     whole console-tail design rests on that header, and a
                     reverse proxy that strips it turns a 100 KB read into a
                     200 MB one.

    python probe.py               # probe everything configured
    python probe.py --jira        # one product
    python probe.py --confluence
    python probe.py --gitlab
    python probe.py --jenkins

A product with no BASE_URL set is skipped rather than failed - four servers on
one machine does not mean all four are in use.

Exit code is 0 only if every probe that RAN succeeded.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "src"))

from readonly_client.config import ConfigError, load_config  # noqa: E402
from readonly_client.errors import AuthError, ServiceError, TransportError  # noqa: E402
from readonly_client.http import ReadOnlyClient  # noqa: E402
from readonly_client.paths import gitlab as gl_paths  # noqa: E402
from readonly_client.paths import jenkins as jk_paths  # noqa: E402
from readonly_client.paths.atlassian import (  # noqa: E402
    CONFLUENCE_PROBE,
    EXTRA_HEADERS,
    JIRA_SERVER_INFO,
    SEARCH_POST_ALLOWLIST,
    WRONG_PATH_HINT,
)

GREEN, RED, YELLOW, DIM, RESET = "\033[32m", "\033[31m", "\033[33m", "\033[2m", "\033[0m"
if not sys.stdout.isatty() or os.environ.get("NO_COLOR"):
    GREEN = RED = YELLOW = DIM = RESET = ""


def ok(msg: str) -> None:
    print(f"  {GREEN}✓{RESET} {msg}")


def bad(msg: str) -> None:
    print(f"  {RED}✗{RESET} {msg}")


def warn(msg: str) -> None:
    print(f"  {YELLOW}!{RESET} {msg}")


def note(msg: str) -> None:
    print(f"    {DIM}{msg}{RESET}")


async def probe_jira() -> bool:
    """(a) GET {JIRA_BASE_URL}/rest/api/2/serverInfo

    Doc: https://developer.atlassian.com/server/jira/platform/rest/v10004/
    Confirms reachability, auth, deployment type and version in one call. This
    is the only Jira endpoint that reports ``deploymentType``, which is why it
    is the probe rather than something more interesting.
    """
    print(f"\n{'─' * 70}\nJIRA\n{'─' * 70}")
    try:
        cfg = load_config(
            "JIRA_BASE_URL",
            "Jira",
            env_prefix="ATLASSIAN",
            auth_modes=("bearer", "basic"),
            extra_headers=EXTRA_HEADERS,
            search_post_allowlist=SEARCH_POST_ALLOWLIST,
            wrong_path_hint=WRONG_PATH_HINT,
        )
    except ConfigError as exc:
        bad(f"Configuration: {exc}")
        return False

    ok(f"Config loaded. Base URL {cfg.base_url}, auth mode {cfg.auth_mode}.")
    note(f"CA bundle: {cfg.ca_bundle or 'system default'}")
    note(f"Proxy: {os.environ.get('HTTPS_PROXY') or 'none'}")

    async with ReadOnlyClient(cfg) as client:
        try:
            data = await client.get(JIRA_SERVER_INFO)
        except ServiceError as exc:
            bad(f"GET {JIRA_SERVER_INFO} failed.")
            note(str(exc))
            return False

    version = data.get("version", "unknown")
    deployment = data.get("deploymentType", "unknown")
    ok(f"GET {JIRA_SERVER_INFO} -> 200")
    note(f"title           {data.get('serverTitle', 'unknown')}")
    note(f"version         {version}")
    note(f"deploymentType  {deployment}")
    note(f"buildNumber     {data.get('buildNumber', 'unknown')}")

    if deployment == "Server":
        # Atlassian reports both Server and Data Center as "Server" here.
        ok("Data Center/Server confirmed. /rest/api/2 paths are correct.")
        note("Jira search: /rest/api/2/search with startAt + maxResults.")
        note("The Cloud /rest/api/3/search/jql nextPageToken model does not apply.")
    elif deployment == "Cloud":
        warn("This is Jira CLOUD, not Data Center.")
        note("paths.py targets Data Center. On Cloud you need /rest/api/3, and")
        note("/rest/api/2/search has been retired in favour of /rest/api/3/search/jql")
        note("with nextPageToken pagination. Tell me and I will add a Cloud path set.")
        note("Also set ATLASSIAN_AUTH_MODE=basic with email + API token.")
    else:
        warn(f"Unrecognised deploymentType {deployment!r}. Send me this output.")

    return True


async def probe_confluence() -> bool:
    """(b) The Confluence equivalent, confirming its API root.

    Doc: https://developer.atlassian.com/server/confluence/rest/v920/
    Confluence has no ``serverInfo`` analogue, so reachability and auth are
    confirmed by asking for a single space. The status code tells us the root:
    200 means ``/rest/api`` is right (Data Center); a 404 here with a 200 at
    ``/wiki/rest/api`` means this is Cloud.
    """
    print(f"\n{'─' * 70}\nCONFLUENCE\n{'─' * 70}")
    try:
        cfg = load_config(
            "CONFLUENCE_BASE_URL",
            "Confluence",
            env_prefix="ATLASSIAN",
            auth_modes=("bearer", "basic"),
            extra_headers=EXTRA_HEADERS,
            wrong_path_hint=WRONG_PATH_HINT,
        )
    except ConfigError as exc:
        bad(f"Configuration: {exc}")
        return False

    ok(f"Config loaded. Base URL {cfg.base_url}, auth mode {cfg.auth_mode}.")

    async with ReadOnlyClient(cfg) as client:
        try:
            data = await client.get(CONFLUENCE_PROBE, params={"limit": 1})
        except ServiceError as exc:
            bad(f"GET {CONFLUENCE_PROBE} failed.")
            note(str(exc))
            note("")
            note("If this is a 404, the API root is probably wrong. Data Center")
            note("serves /rest/api; Cloud serves /wiki/rest/api. Try adding /wiki")
            note("to CONFLUENCE_BASE_URL and re-running - if that works, this is")
            note("Cloud and I need to add a Cloud path set.")
            return False

    ok(f"GET {CONFLUENCE_PROBE} -> 200")
    ok("Data Center API root confirmed: /rest/api with no /wiki prefix.")
    results = data.get("results", [])
    note(f"visible spaces (first page) {data.get('size', len(results))}")
    if results:
        first = results[0]
        note(f"sample space  {first.get('key', '?')} - {first.get('name', '?')}")
    note("Confluence search: /rest/api/content/search?cql=... with start + limit.")
    note("The Cloud v2 API (/wiki/api/v2/) does not exist on Data Center.")
    return True


async def probe_gitlab() -> bool:
    """(c) GitLab: version, then whether project-scoped blob search works here.

    Source: gitlab-org/gitlab doc/api/. Two calls, because the second answers a
    question the docs cannot: `blobs` search at project scope carries no tier
    note and no Elasticsearch requirement, but whether it is switched on for
    YOUR instance is a fact about your instance.
    """
    print(f"\n{'─' * 70}\nGITLAB\n{'─' * 70}")
    try:
        cfg = load_config(
            "GITLAB_BASE_URL",
            "GitLab",
            env_prefix="GITLAB",
            auth_modes=("header",),
            default_auth_mode="header",
            auth_header_name="PRIVATE-TOKEN",
            wrong_path_hint=gl_paths.WRONG_PATH_HINT,
        )
    except ConfigError as exc:
        bad(f"Configuration: {exc}")
        return False

    ok(f"Config loaded. Base URL {cfg.base_url}, token sent as PRIVATE-TOKEN.")
    note(f"CA bundle: {cfg.ca_bundle or 'system default'}")

    async with ReadOnlyClient(cfg) as client:
        # /version needs only read_api and confirms auth in the same call.
        try:
            data = await client.get(f"{gl_paths.API}/version")
        except ServiceError as exc:
            bad(f"GET {gl_paths.API}/version failed.")
            note(str(exc))
            # Advice, only where it applies. A "check your token" note under a
            # DNS failure sends someone to regenerate a credential that was
            # never the problem - the same mistake as collapsing 401 into 403.
            if isinstance(exc, AuthError):
                note("")
                note("GitLab wants a personal access token with the read_api")
                note("scope, sent as PRIVATE-TOKEN. Do NOT widen it to `api`,")
                note("which grants write.")
            elif isinstance(exc, TransportError):
                note("")
                note("This did not reach GitLab at all. Check the hostname, the")
                note("VPN, and HTTPS_PROXY / NO_PROXY for an internal host.")
            return False

        version = str(data.get("version", "unknown"))
        ok(f"GET {gl_paths.API}/version -> 200")
        note(f"version   {version}")
        note(f"revision  {data.get('revision', 'unknown')}")

        # The MR diffs endpoint reports collapsed/too_large only from 18.4.
        major_minor = _version_tuple(version)
        if major_minor and major_minor < (15, 7):
            warn(f"GitLab {version} predates the /diffs endpoint (15.7).")
            note("gitlab_get_merge_request(include_diff=True) will 404 here.")
            note("Tell me and I will fall back to the deprecated /changes.")
        elif major_minor and major_minor < (18, 4):
            note(f"GitLab {version}: /diffs will not report collapsed/too_large")
            note("(added in 18.4). The shaping already treats them as absent")
            note("rather than false, so nothing is claimed that is not known.")

        # Now the one the docs cannot answer.
        try:
            projects = await client.get(
                gl_paths.PROJECTS, params={"membership": "true", "per_page": 1,
                                           "simple": "true"}
            )
        except ServiceError as exc:
            bad("GET /projects failed.")
            note(str(exc))
            return False

        if not isinstance(projects, list) or not projects:
            warn("Your token can see no projects, so code search cannot be tested.")
            note("That is a permissions answer, not a failure: gitlab_list_projects")
            note("will return the same empty list. Check the token's scopes.")
            return True

        sample = projects[0]
        path = sample.get("path_with_namespace") or sample.get("id")
        ok(f"GET /projects -> 200, sample project {path!r}")

        try:
            hits = await client.get(
                gl_paths.project_search(path),
                params={"scope": "blobs", "search": "a", "per_page": 1},
            )
        except ServiceError as exc:
            warn("Project-scoped code search is NOT available here.")
            note(str(exc))
            note("")
            note("gitlab_search_code will fail. Everything else still works;")
            note("use gitlab_get_file with a path you already know.")
            return True

        ok("Project-scoped blob search works. gitlab_search_code is usable.")
        note(f"sample query returned {len(hits) if isinstance(hits, list) else '?'} hit(s)")
    return True


def _version_tuple(version: str) -> tuple[int, int] | None:
    parts = version.split(".")
    try:
        return int(parts[0]), int(parts[1])
    except (IndexError, ValueError):
        return None


async def probe_jenkins() -> bool:
    """(d) Jenkins: version, then whether the console tail can work here.

    The second question is the one worth asking. jenkins_get_console reads the
    log's size from X-Text-Size and fetches only the tail. If a reverse proxy
    strips that header the server still works - it falls back to /consoleText -
    but every console read becomes a full download of a log that may be
    hundreds of megabytes. Better to know now than to find out on the
    instance's worst job.
    """
    print(f"\n{'─' * 70}\nJENKINS\n{'─' * 70}")
    try:
        cfg = load_config(
            "JENKINS_BASE_URL",
            "Jenkins",
            env_prefix="JENKINS",
            auth_modes=("basic",),
            default_auth_mode="basic",
            wrong_path_hint=jk_paths.WRONG_PATH_HINT,
        )
    except ConfigError as exc:
        bad(f"Configuration: {exc}")
        return False

    ok(f"Config loaded. Base URL {cfg.base_url}, Basic auth as {cfg.username!r}.")
    note(f"CA bundle: {cfg.ca_bundle or 'system default'}")

    async with ReadOnlyClient(cfg) as client:
        try:
            root = await client.get_full(
                jk_paths.ROOT_API, params={"tree": "mode,numExecutors,jobs[name]"}
            )
        except ServiceError as exc:
            bad(f"GET {jk_paths.ROOT_API} failed.")
            note(str(exc))
            if isinstance(exc, AuthError):
                note("")
                note("Jenkins wants your username plus an API token")
                note("(User -> Configure -> API Token), not your password.")
            elif isinstance(exc, TransportError):
                note("")
                note("This did not reach Jenkins at all. Check the hostname, the")
                note("VPN, and HTTPS_PROXY / NO_PROXY for an internal host.")
            else:
                note("")
                note("An HTML body here means an SSO portal is in front of the")
                note("API rather than the API answering.")
            return False

        version = root.headers.get("x-jenkins", "unknown")
        ok(f"GET {jk_paths.ROOT_API} -> 200")
        note(f"X-Jenkins  {version}")
        jobs = root.data.get("jobs") if isinstance(root.data, dict) else None
        count = len(jobs) if isinstance(jobs, list) else 0
        note(f"top-level jobs visible  {count}")

        if not count:
            warn("No jobs visible, so the console probe cannot run.")
            note("That is a permissions answer, not a failure.")
            return True

        # Find a job with at least one build, so the console probe has a target.
        target = None
        for job in jobs[:10]:
            name = job.get("name") if isinstance(job, dict) else None
            if not name:
                continue
            try:
                info = await client.get(
                    jk_paths.job_api(name), params={"tree": "lastBuild[number]"}
                )
            except ServiceError:
                continue
            last = info.get("lastBuild") if isinstance(info, dict) else None
            if isinstance(last, dict) and last.get("number"):
                target = (name, last["number"])
                break

        if target is None:
            warn("No job among the first ten has a build, so the console probe")
            note("could not run. Re-run once something has built.")
            return True

        job_name, build_no = target
        ok(f"Console probe target: {job_name!r} build {build_no}")

        # THE question: does X-Text-Size survive to us?
        probe = await client.get_text(
            jk_paths.progressive_text(job_name, build_no),
            params={"start": 0},
            max_bytes=1,
        )
        size = probe.header_int(jk_paths.TEXT_SIZE_HEADER)
        if size is None:
            warn(f"{jk_paths.TEXT_SIZE_HEADER} is missing from the response.")
            note("jenkins_get_console still works - it falls back to")
            note("/consoleText - but each read downloads the WHOLE log rather")
            note("than its tail. If a reverse proxy sits in front of Jenkins,")
            note(f"ask for {jk_paths.TEXT_SIZE_HEADER} to be passed through.")
        else:
            ok(f"{jk_paths.TEXT_SIZE_HEADER}: {size} - the tail read works.")
            note("jenkins_get_console fetches only the last N bytes of a log.")
    return True


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--jira", action="store_true", help="probe Jira only")
    parser.add_argument("--confluence", action="store_true", help="probe Confluence only")
    parser.add_argument("--gitlab", action="store_true", help="probe GitLab only")
    parser.add_argument("--jenkins", action="store_true", help="probe Jenkins only")
    args = parser.parse_args()

    selected = any((args.jira, args.confluence, args.gitlab, args.jenkins))
    plan = [
        ("jira", args.jira, "JIRA_BASE_URL", probe_jira),
        ("confluence", args.confluence, "CONFLUENCE_BASE_URL", probe_confluence),
        ("gitlab", args.gitlab, "GITLAB_BASE_URL", probe_gitlab),
        ("jenkins", args.jenkins, "JENKINS_BASE_URL", probe_jenkins),
    ]

    print(f"{DIM}Probing. No credential is printed by this script.{RESET}")
    results: list[bool] = []
    skipped: list[str] = []
    for name, asked, var, run in plan:
        if selected and not asked:
            continue
        # Unasked-for and unconfigured is a skip, not a failure. Four servers
        # on one machine does not mean all four are in use, and reporting an
        # unused product as broken buries the one that is.
        if not selected and not os.environ.get(var, "").strip():
            skipped.append(f"{name} ({var} not set)")
            continue
        results.append(await run())

    print(f"\n{'─' * 70}")
    for s in skipped:
        print(f"{DIM}skipped: {s}{RESET}")
    if not results:
        print(f"{YELLOW}Nothing to probe.{RESET} Set at least one BASE_URL. See .env.example.")
        return 1
    if all(results):
        print(f"{GREEN}All probes succeeded.{RESET} The paths match these instances.")
        return 0
    print(f"{RED}One or more probes failed.{RESET} Fix the above before wiring MCP.")
    return 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
