#!/usr/bin/env python3
"""Standalone connectivity and deployment-type probe. No MCP wiring involved.

Run this FIRST, before trusting anything in ``paths.py``. It answers the four
questions the build environment could not:

  1. Is the instance reachable from this machine (DNS, proxy, VPN)?
  2. Does TLS verify, or is a corporate CA bundle needed?
  3. Is the credential accepted, and in which auth mode?
  4. Is this Data Center or Cloud - which decides every API path we use?

Question 4 is the one that matters most. Cloud and Data Center diverge enough
that a client built for the wrong one fails in confusing ways: Jira Cloud has
retired the offset-paginated ``/rest/api/2/search`` that Data Center still
serves, and Confluence Cloud puts everything behind ``/wiki``. This script
reports which shape answered rather than assuming.

    python probe.py              # probe both products
    python probe.py --jira       # just Jira
    python probe.py --confluence # just Confluence

Exit code is 0 only if every probe requested succeeded.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "src"))

from atlassian_client.config import ConfigError, load_config  # noqa: E402
from atlassian_client.errors import AtlassianError  # noqa: E402
from atlassian_client.http import ReadOnlyClient  # noqa: E402
from atlassian_client.paths import (  # noqa: E402
    CONFLUENCE_PROBE,
    JIRA_SERVER_INFO,
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
        cfg = load_config("JIRA_BASE_URL", "Jira")
    except ConfigError as exc:
        bad(f"Configuration: {exc}")
        return False

    ok(f"Config loaded. Base URL {cfg.base_url}, auth mode {cfg.auth_mode}.")
    note(f"CA bundle: {cfg.ca_bundle or 'system default'}")
    note(f"Proxy: {os.environ.get('HTTPS_PROXY') or 'none'}")

    async with ReadOnlyClient(cfg) as client:
        try:
            data = await client.get(JIRA_SERVER_INFO)
        except AtlassianError as exc:
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
        cfg = load_config("CONFLUENCE_BASE_URL", "Confluence")
    except ConfigError as exc:
        bad(f"Configuration: {exc}")
        return False

    ok(f"Config loaded. Base URL {cfg.base_url}, auth mode {cfg.auth_mode}.")

    async with ReadOnlyClient(cfg) as client:
        try:
            data = await client.get(CONFLUENCE_PROBE, params={"limit": 1})
        except AtlassianError as exc:
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


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--jira", action="store_true", help="probe Jira only")
    parser.add_argument("--confluence", action="store_true", help="probe Confluence only")
    args = parser.parse_args()

    both = not (args.jira or args.confluence)
    results: list[bool] = []

    print(f"{DIM}Probing. No credential is printed by this script.{RESET}")
    if both or args.jira:
        results.append(await probe_jira())
    if both or args.confluence:
        results.append(await probe_confluence())

    print(f"\n{'─' * 70}")
    if all(results):
        print(f"{GREEN}All probes succeeded.{RESET} The paths in paths.py match this instance.")
        return 0
    print(f"{RED}One or more probes failed.{RESET} Fix the above before wiring MCP.")
    return 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
