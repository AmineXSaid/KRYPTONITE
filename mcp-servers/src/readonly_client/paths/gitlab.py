"""Every GitLab REST path gitlab-mcp uses, with its provenance.

── VERIFICATION STATUS ──────────────────────────────────────────────────────
Unlike the Atlassian module, these are read off the primary reference: the
``doc/api/`` tree of ``gitlab-org/gitlab`` itself, at master (VERSION
19.4.0-pre) on 2026-08-27. Each entry names the file it came from.

That confirms the SHAPE. It does not confirm your instance, which is a
different and older thing, so each entry still carries a status:

    CONFIRMED     documented and stable across the versions we care about
    VERSION-RISK  documented, but with a behaviour that changed in a named
                  release - read the note before relying on it
    NEEDS-PROBE   depends on how YOUR instance is licensed or configured

``probe.py --gitlab`` resolves the version and tier from the instance and
checks each root.

── AUTH ─────────────────────────────────────────────────────────────────────
doc/api/rest/authentication.md is explicit: a personal, project or group
access token is passed with ``PRIVATE-TOKEN`` (its word is "recommended"), and
OAuth-compliant ``Authorization: Bearer`` is also accepted. ``PRIVATE-TOKEN``
is what this client sends, because it is the documented home for the token
type we actually take, and older self-managed instances have rejected the
Bearer form for a PAT with a 401 indistinguishable from a bad token.

Note the doc's own warning, which shapes the error text: an invalid or missing
credential returns ``401`` with ``{"message": "401 Unauthorized"}``.

── PAGINATION ───────────────────────────────────────────────────────────────
doc/api/rest/_index.md: offset pagination via ``page`` and ``per_page``
(default 20, max 100), with the count in response HEADERS - ``x-total``,
``x-total-pages``, ``x-page``, ``x-per-page``, ``x-next-page``, ``x-prev-page``.

The trap, quoted: "if a query returns more than 10,000 records, GitLab doesn't
return the following headers: x-total, x-total-pages, rel=last link". So a
missing ``x-total`` means "more than ten thousand", never zero, and shaping has
to say so rather than reporting a total of 0 to a model that will then
summarise page one as the whole answer.

── ENCODING ─────────────────────────────────────────────────────────────────
doc/api/rest/_index.md, "Namespaced paths": a project may be addressed by
numeric id or by URL-encoded path, where ``/`` is ``%2F``. The same applies to
a file path, branch or tag containing ``/``. Everything here is encoded with
``quote(value, safe="")`` before it reaches the URL; httpx preserves an
already-encoded segment rather than re-encoding the percent sign.

The docs are internally inconsistent about the dot: the parameter tables on
every file endpoint show ``lib%2Fclass%2Erb``, while the section that exists to
STATE the rule - rest/_index.md, "File path, branches, and tags name" - says
only that ``/`` must be encoded, and its own examples are ``src%2FREADME.md``
and ``path%2Fto%2Ffile.rb`` with the dot left alone. We follow the rule rather
than the tables: a bare ``.`` is unambiguous to every URL decoder and proxy on
the way, whereas ``%2E`` relies on each of them decoding it back before
routing. If a probe against your instance shows a file endpoint 404ing on an
unencoded dot, that is the one line to change.
"""

from __future__ import annotations

from urllib.parse import quote

API = "/api/v4"


def encode(value: str | int) -> str:
    """Encode one path segment, including any ``/`` inside it.

    ``safe=""`` is the whole point: the default leaves ``/`` alone, which would
    turn the project path ``group/sub/repo`` into three path segments and a
    404. Numeric ids pass through unchanged.
    """
    return quote(str(value), safe="")


# ─────────────────────────────── projects ──────────────────────────────────
#
# doc/api/projects.md

# Status: CONFIRMED. Attributes used: search, membership, simple, archived,
# order_by, sort, page, per_page. `simple=true` returns a much smaller record
# and is what a list call wants; the full record is for get_project.
PROJECTS = f"{API}/projects"


def project(ref: str | int) -> str:
    """Status: CONFIRMED. `ref` is a numeric id or a namespaced path."""
    return f"{API}/projects/{encode(ref)}"


# ────────────────────────────── repository ─────────────────────────────────
#
# doc/api/repository_files.md

def file(project_ref: str | int, path: str) -> str:
    """Status: CONFIRMED.

    Returns a JSON envelope, not the file: `content` is base64 and `encoding`
    says so. `ref` is REQUIRED per the doc - "Name of branch, tag, or commit.
    Use HEAD to automatically use the default branch" - so the tool always
    sends one rather than hoping the default applies.

    There is a sibling `/raw` path that returns the bytes directly. This one is
    used instead because the envelope carries `size` and `file_name`, which is
    what lets a binary or oversized file be refused with a description rather
    than by streaming megabytes of it into a model's context.
    """
    return f"{API}/projects/{encode(project_ref)}/repository/files/{encode(path)}"


# ──────────────────────────── merge requests ───────────────────────────────
#
# doc/api/merge_requests.md

def merge_requests(project_ref: str | int) -> str:
    """Status: CONFIRMED. state=opened|closed|merged|locked|all, plus
    source_branch, target_branch, author_username, labels, order_by, sort."""
    return f"{API}/projects/{encode(project_ref)}/merge_requests"


def merge_request(project_ref: str | int, iid: int) -> str:
    """Status: CONFIRMED. `iid` is the per-project number in the MR's URL, NOT
    the global `id` field - passing `id` here silently returns a different MR
    or a 404, and both are hard to spot in a tool result."""
    return f"{API}/projects/{encode(project_ref)}/merge_requests/{encode(iid)}"


def merge_request_diffs(project_ref: str | int, iid: int) -> str:
    """Status: VERSION-RISK.

    This is the replacement for `/changes`, which doc/api/rest/deprecations.md
    lists as deprecated in favour of "list merge request diffs". `/changes`
    returns every file in one unpaginated envelope; `/diffs` paginates, which
    is what makes a large MR readable at all.

    The version risk is in the RESPONSE, not the path: `collapsed` and
    `too_large` were "introduced in GitLab 18.4" per the endpoint's own history
    block. On an older instance those keys are simply absent, so shaping must
    treat absent as "not flagged" and never as False-with-confidence.
    """
    return f"{API}/projects/{encode(project_ref)}/merge_requests/{encode(iid)}/diffs"


# ─────────────────────────────── search ────────────────────────────────────
#
# doc/api/search.md
#
# THE IMPORTANT DISTINCTION, and it is not a detail:
#
#   Instance-wide  GET /search?scope=blobs      Premium/Ultimate, and needs
#                                               advanced search or exact code
#                                               search to be enabled.
#   Project-scoped GET /projects/:id/search     no tier note on the `blobs`
#                  ?scope=blobs                 scope, and it takes a `ref`.
#
# So project-scoped code search is the one that works on a Free self-managed
# instance with nothing extra switched on, and it is what gitlab_search_code
# uses by default. Instance-wide search is offered, but the tool says plainly
# what it needs rather than returning an empty list that reads like "no
# matches" when the real answer is "this instance cannot do that".

# Status: NEEDS-PROBE - depends on tier and on advanced search being enabled.
SEARCH = f"{API}/search"


def project_search(project_ref: str | int) -> str:
    """Status: CONFIRMED for scope=blobs. Filters `filename:`, `path:` and
    `extension:` go inside the search string, and `*` globs."""
    return f"{API}/projects/{encode(project_ref)}/search"


# Scopes doc/api/search.md lists for a project search. `blobs` is code.
PROJECT_SEARCH_SCOPES: tuple[str, ...] = (
    "blobs",
    "commits",
    "issues",
    "merge_requests",
    "milestones",
    "notes",
    "users",
    "wiki_blobs",
)

# ───────────────────────── the read-only surface ───────────────────────────
#
# There is deliberately NO allowlist here. Every GitLab call this server makes
# is a GET, so the config names none and the client can POST nowhere at all.
# The absence is the design, which is why it is written down.

EXTRA_HEADERS: dict[str, str] = {}

WRONG_PATH_HINT = (
    "GitLab's REST API lives under /api/v4 on the instance root, so the base "
    "URL should stop at the hostname (plus a relative-URL prefix if the "
    "instance is served from a subdirectory)."
)

# doc/api/rest/_index.md: per_page defaults to 20 and its maximum is 100.
MAX_PER_PAGE = 100
