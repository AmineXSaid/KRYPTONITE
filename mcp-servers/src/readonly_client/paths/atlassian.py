"""Every Jira and Confluence REST path, in one place, with its provenance.

Why one module per product: a path that appears inline at its call site gets
copied, and the copy is what drifts when the instance turns out to be Cloud
rather than Data Center. Centralising them means a wrong assumption is a
one-line fix in a file whose whole job is to be audited, rather than a hunt
through two servers.

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

from urllib.parse import urlsplit

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

# Attachments are NOT a separate listing endpoint on Jira: they are a field on
# the issue, so listing them is `JIRA_ISSUE` with `fields=attachment` and needs
# no new path at all. Each entry carries a `content` URL that Jira builds
# itself, and following that is what downloads the file.
#
# Status: NEEDS-PROBE, and deliberately unused unless the issue payload gives
# us nothing. The `content` URL is the instance's own answer to "where is this
# file", so it survives a context path, a reverse proxy rewriting /secure, and
# any version that moved the route - none of which a hardcoded path survives.
# This constant exists only so a payload missing `content` produces a request
# rather than a shrug, and `download_url_for` below is what decides.
JIRA_ATTACHMENT_CONTENT = "/secure/attachment/{attachment_id}/{filename}"


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

# Status: NEEDS-PROBE. Attachments are children of a page in Confluence's
# content tree, which is why this is `child/attachment` rather than an
# endpoint of its own. Each result carries `_links.download`, a path relative
# to the instance's context path, and following THAT is how the bytes are
# fetched - see `download_url_for`.
CONFLUENCE_ATTACHMENTS = "/rest/api/content/{page_id}/child/attachment"


def download_url_for(link: object, base_url: str) -> str | None:
    """The download path an Atlassian payload named, or None if there is none
    this client may fetch.

    Both products hand back the location of an attachment's bytes IN the
    metadata: Confluence as ``_links.download`` (a path), Jira as ``content``
    (an absolute URL). Following what the instance said beats building a path
    from a template, and not by a little:

      * A Data Center instance behind a context path serves Confluence at
        ``/confluence/rest/api/...``. Every template in this file is written
        without one, because the base URL carries it - but ``_links.download``
        already includes it, so a template and a payload link cannot both be
        appended to the same base URL. The link wins, and is reduced to a path
        so it is the CLIENT's base URL that it is joined to.
      * The download route is the part of these APIs most likely to have moved
        between versions, and the part this build environment could least
        verify: ``developer.atlassian.com`` is blocked from here, so a
        hardcoded ``/download/attachments/...`` would be a guess dressed as a
        constant. The instance is never guessing.

    Returns a PATH, never a host, so a caller cannot present its credential
    anywhere the base URL does not name. An absolute URL on a DIFFERENT host
    returns None rather than a path: reducing it to a path would quietly
    request that path from the configured instance instead, which 404s with a
    message about the wrong file. Saying "this attachment is served from
    somewhere else" is the true answer.
    """
    if not isinstance(link, str) or not link.strip():
        return None
    raw = link.strip()
    if "://" not in raw:
        return raw if raw.startswith("/") else "/" + raw

    parts = urlsplit(raw)
    base = urlsplit(base_url or "")
    default = {"http": 80, "https": 443}
    same = (
        parts.scheme == base.scheme
        and (parts.hostname or "") == (base.hostname or "")
        and (parts.port or default.get(parts.scheme)) == (base.port or default.get(base.scheme))
    )
    if not same:
        return None
    if not parts.path:
        return None
    return f"{parts.path}?{parts.query}" if parts.query else parts.path


# ─────────────────────────── the read-only surface ─────────────────────────
#
# The HTTP layer refuses every method but GET, with one carve-out: Atlassian's
# JQL search accepts POST so that a long JQL string can travel in a body
# instead of a URL. That is a read operation wearing POST's clothing, and it is
# permitted ONLY against the exact paths listed here.
#
# This tuple is passed to load_config() by the Jira server alone. It is NOT a
# module global the client consults, because that would let Jira's one
# exception apply to a GitLab or Jenkins client that never asked for it.
# Membership is tested by exact match after normalising the path, so it cannot
# be widened by a prefix trick like
# /rest/api/2/search/../issue/KEY-1/transitions.
SEARCH_POST_ALLOWLIST: tuple[str, ...] = (JIRA_SEARCH,)

# Every request carries this. Atlassian DC returns an HTML login page instead
# of a 401 to clients it thinks are browsers; this header is what makes it
# answer with JSON, and without it a bad token surfaces as an unparseable 200.
EXTRA_HEADERS: dict[str, str] = {"X-Atlassian-Token": "no-check"}

# Appended to the HTML-404 message. Named here because this is the file that
# knows how the two deployments differ.
WRONG_PATH_HINT = (
    "Check the deployment type too: Data Center uses /rest/api/2 (Jira) and "
    "/rest/api with no /wiki prefix (Confluence); Cloud uses /rest/api/3 and "
    "/wiki/rest/api."
)
