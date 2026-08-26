"""Every REST path either server uses, in one place, with its provenance.

Why one module: a path that appears inline at its call site gets copied, and
the copy is what drifts when the instance turns out to be Cloud rather than
Data Center. Centralising them means a wrong assumption is a one-line fix in a
file whose whole job is to be audited, rather than a hunt through two servers.

── VERIFICATION STATUS, HONESTLY ────────────────────────────────────────────
The build environment for this package cannot reach the target instance
(``*.company.internal`` does not resolve outside the corporate network) and its
egress proxy blocks ``developer.atlassian.com`` and ``docs.atlassian.com``. So
the paths below are corroborated from secondary sources, NOT confirmed against
the primary reference or against your instance.

``probe.py`` is what closes that gap. It resolves deployment type and version
from the instance itself and checks each root below. Run it before trusting
anything here. Each entry carries its doc URL and a status:

    CONFIRMED-DC   corroborated as Data Center/Server specific
    NEEDS-PROBE    shape is standard but unverified on your instance

── CLOUD vs DATA CENTER ─────────────────────────────────────────────────────
These diverge enough that a Cloud-shaped client silently fails on DC:

  Jira      DC uses /rest/api/2. v3 is Cloud-only.
            DC search paginates with startAt + maxResults. The Cloud
            nextPageToken / `/rest/api/3/search/jql` model does NOT exist on DC;
            the 2025 Cloud deprecation of /rest/api/2/search does not apply to
            Data Center, which retains the offset-paginated endpoint.
  Confluence DC uses /rest/api with NO /wiki prefix. Cloud uses /wiki/rest/api
            and additionally offers /wiki/api/v2, which does not exist on DC.

Set ATLASSIAN_AUTH_MODE and the base URLs to match whichever the probe reports.
"""

from __future__ import annotations

# ─────────────────────────────── Jira (Data Center) ────────────────────────
#
# Doc: https://developer.atlassian.com/server/jira/platform/rest/v10004/
# API version: 2  (v3 is Cloud-only and 404s on Data Center)

# Status: CONFIRMED-DC. Deployment type and version come from here; this is the
# one endpoint the probe must reach before anything else is meaningful.
JIRA_SERVER_INFO = "/rest/api/2/serverInfo"

# Status: CONFIRMED-DC. Offset pagination via startAt/maxResults.
# GET carries JQL in the query string; POST carries it in a JSON body and is
# the documented way to send a JQL string too long for a URL. POST here is a
# SEARCH, not a mutation - see SEARCH_POST_ALLOWLIST below.
JIRA_SEARCH = "/rest/api/2/search"

# Status: CONFIRMED-DC.
JIRA_ISSUE = "/rest/api/2/issue/{issue_key}"

# Status: CONFIRMED-DC. Returns every project visible to the caller, unpaginated.
#
# Deliberately NOT /rest/api/2/project/search. That path is the paginated Cloud
# form; whether it exists on a given Data Center version is exactly the sort of
# thing this file refuses to guess at. /rest/api/2/project has been present
# across Server and DC for many versions, so we take it and filter client-side.
# The cost is real but bounded: a corporate instance with thousands of projects
# returns one large payload, which we trim hard before it reaches the model.
JIRA_PROJECTS = "/rest/api/2/project"

# Status: CONFIRMED-DC. Every field, system and custom, with the customfield_*
# ids that make the `fields` parameter usable.
JIRA_FIELDS = "/rest/api/2/field"


# ──────────────────────────── Confluence (Data Center) ─────────────────────
#
# Doc: https://developer.atlassian.com/server/confluence/rest/v920/
# API version: rest/api (v1). NO /wiki prefix on Data Center.

# Status: NEEDS-PROBE. Confluence DC has no serverInfo analogue to Jira's, so
# the probe confirms reachability, auth and API root by asking for a single
# space. A 200 here means the root is right and the credential works; a 404
# means the root is wrong (most likely a /wiki prefix, i.e. this is Cloud).
CONFLUENCE_PROBE = "/rest/api/space"

# Status: CONFIRMED-DC. CQL search. Offset pagination via start/limit - note
# the parameter names differ from Jira's startAt/maxResults, which is a genuine
# inconsistency in Atlassian's own APIs rather than a mistake here.
CONFLUENCE_SEARCH = "/rest/api/content/search"

# Status: CONFIRMED-DC.
CONFLUENCE_CONTENT = "/rest/api/content/{page_id}"

# Status: CONFIRMED-DC.
CONFLUENCE_SPACES = "/rest/api/space"


# ─────────────────────────── the read-only surface ─────────────────────────
#
# The HTTP layer refuses every method but GET, with one carve-out: Atlassian's
# JQL search accepts POST so that a long JQL string can travel in a body
# instead of a URL. That is a read operation wearing POST's clothing, and it is
# permitted ONLY against the exact paths listed here.
#
# This is a tuple, and membership is tested by exact match after normalising
# the path, so it cannot be widened by a prefix trick like
# /rest/api/2/search/../issue/KEY-1/transitions.
SEARCH_POST_ALLOWLIST: tuple[str, ...] = (JIRA_SEARCH,)

# Methods the client will build a request for at all. Anything else raises
# before a connection is opened.
ALLOWED_METHODS: frozenset[str] = frozenset({"GET", "POST"})
