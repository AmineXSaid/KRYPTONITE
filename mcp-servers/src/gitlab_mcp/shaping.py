"""Cutting GitLab payloads down to what a model can actually use.

The problem is not politeness about bandwidth, it is that the raw payloads do
not fit. A single project record from `GET /projects/:id` runs past 100 keys -
`_links`, `namespace`, `owner`, `permissions`, `container_expiration_policy`,
`shared_with_groups`, five URL variants of the same repository - and a list of
forty of them will not leave room for the answer. A merge request diff is
worse: one refactor can carry a megabyte of unified diff across two hundred
files.

Three rules run through everything here.

**Say what was left out.** Every list result carries `returned`, and `total`
where the instance gave one. A model handed twenty merge requests with no
count cannot tell whether it has the answer or the first page of six hundred,
and it will summarise the slice as the whole.

**A missing count is not zero.** GitLab stops sending `x-total` above ten
thousand records (doc/api/rest/_index.md). Reporting that as `total: 0` would
be a lie in the most misleading possible direction, so it is reported as
`total: null` with `total_unavailable` explaining why.

**Absent is not False.** `collapsed` and `too_large` arrived on the diffs
endpoint in GitLab 18.4. On an older instance they are simply not there, and
treating absent as "not truncated" would state something we do not know. They
are only reported when present.
"""

from __future__ import annotations

import base64
from typing import Any, Mapping

#: How much of one file's diff a tool result may carry, before the whole-result
#: budget is applied on top. A single file that big is a generated lockfile or
#: a vendored dependency, and its content is never the answer.
PER_FILE_DIFF_BYTES = 8_000

#: How much diff a single tool result may carry in total.
TOTAL_DIFF_BYTES = 60_000

#: How much of a file `gitlab_get_file` will return.
MAX_FILE_BYTES = 100_000


def _user(u: Any) -> str | None:
    """A user down to the one field worth spending tokens on.

    GitLab nests a full user object - id, name, username, state, locked,
    avatar_url, web_url - everywhere a person appears. `username` is the
    handle that appears in every other tool's output and in the UI, so it is
    the one that lets a model cross-reference.
    """
    if isinstance(u, Mapping):
        return u.get("username") or u.get("name")
    return None


def paginated(
    items: list[dict[str, Any]],
    *,
    total: int | None,
    next_page: int | None,
    page: int | None,
    per_page: int | None,
    key: str = "items",
) -> dict[str, Any]:
    """Wrap a shaped list with the paging facts, honestly.

    ``total=None`` is a real state, not a failure: GitLab omits ``x-total``
    once a query exceeds 10,000 records. It is reported as null with a note
    rather than guessed at.
    """
    out: dict[str, Any] = {
        key: items,
        "returned": len(items),
        "total": total,
        "page": page,
        "per_page": per_page,
        "has_more": next_page is not None,
        "next_page": next_page,
    }
    if total is None:
        out["total_unavailable"] = (
            "GitLab does not report a total for queries returning more than "
            "10,000 records. There are at least this many; narrow the query "
            "if you need an exact count."
        )
    return out


# ─────────────────────────────── projects ──────────────────────────────────


def shape_project(p: Mapping[str, Any], *, full: bool = False) -> dict[str, Any]:
    """A project as an identifier plus the facts you pick one by.

    `path_with_namespace` leads because it is the id every other tool here
    accepts, and the one a human recognises. The numeric `id` is kept because
    it is what a URL from elsewhere in GitLab will carry.
    """
    out: dict[str, Any] = {
        "id": p.get("id"),
        "path": p.get("path_with_namespace"),
        "name": p.get("name"),
        "default_branch": p.get("default_branch"),
        "url": p.get("web_url"),
    }
    desc = p.get("description")
    if desc:
        out["description"] = str(desc)[:400]
    if p.get("archived"):
        # Only when true. An archived repo is a trap - its code looks current
        # and is not - so this is worth a key; "archived: false" on every row
        # is not.
        out["archived"] = True
    if full:
        out["visibility"] = p.get("visibility")
        out["last_activity_at"] = p.get("last_activity_at")
        out["created_at"] = p.get("created_at")
        ns = p.get("namespace")
        if isinstance(ns, Mapping):
            out["namespace"] = ns.get("full_path") or ns.get("name")
        stats = p.get("statistics")
        if isinstance(stats, Mapping) and stats.get("repository_size") is not None:
            out["repository_size"] = stats.get("repository_size")
        for key in ("issues_enabled", "merge_requests_enabled", "empty_repo"):
            if key in p:
                out[key] = p[key]
    return out


# ──────────────────────────── merge requests ───────────────────────────────


def shape_merge_request(m: Mapping[str, Any], *, full: bool = False) -> dict[str, Any]:
    """A merge request as: which one, what state, whose, and between what.

    `iid` rather than `id`, and labelled as such, because every other GitLab
    tool and every GitLab URL uses the iid. A model that reads `id` off this
    and passes it back gets a different MR or a 404.
    """
    out: dict[str, Any] = {
        "iid": m.get("iid"),
        "title": m.get("title"),
        "state": m.get("state"),
        "author": _user(m.get("author")),
        "source_branch": m.get("source_branch"),
        "target_branch": m.get("target_branch"),
        "updated_at": m.get("updated_at"),
        "url": m.get("web_url"),
    }
    if m.get("draft") or m.get("work_in_progress"):
        out["draft"] = True
    labels = m.get("labels")
    if isinstance(labels, list) and labels:
        out["labels"] = [str(x) for x in labels[:20]]
    if not full:
        return out

    out["created_at"] = m.get("created_at")
    out["merged_at"] = m.get("merged_at")
    out["closed_at"] = m.get("closed_at")
    out["merge_status"] = m.get("detailed_merge_status") or m.get("merge_status")
    out["has_conflicts"] = m.get("has_conflicts")
    out["sha"] = m.get("sha")
    assignees = m.get("assignees")
    if isinstance(assignees, list) and assignees:
        out["assignees"] = [u for u in (_user(a) for a in assignees) if u]
    reviewers = m.get("reviewers")
    if isinstance(reviewers, list) and reviewers:
        out["reviewers"] = [u for u in (_user(r) for r in reviewers) if u]
    desc = m.get("description")
    if desc:
        out["description"] = str(desc)[:4000]
    pipeline = m.get("head_pipeline") or m.get("pipeline")
    if isinstance(pipeline, Mapping):
        # The single most useful fact about an open MR, and the bridge to
        # jenkins-mcp when CI runs there instead.
        out["pipeline"] = {
            "status": pipeline.get("status"),
            "url": pipeline.get("web_url"),
        }
    return out


def shape_diffs(
    entries: list[Mapping[str, Any]],
    *,
    per_file_bytes: int = PER_FILE_DIFF_BYTES,
    total_bytes: int = TOTAL_DIFF_BYTES,
) -> dict[str, Any]:
    """Per-file diffs, capped twice: per file, then over the whole result.

    Two caps rather than one because they fail differently. Without the
    per-file cap, one generated lockfile eats the entire budget and every real
    change is dropped. Without the total cap, two hundred small files still
    add up past what a tool result should carry.

    A file whose diff was cut keeps its entry and its paths - knowing that
    `src/auth.go` changed is most of the value, even when the hunks are gone.
    """
    files: list[dict[str, Any]] = []
    spent = 0
    omitted = 0

    for e in entries:
        if not isinstance(e, Mapping):
            continue
        if spent >= total_bytes:
            omitted += 1
            continue

        row: dict[str, Any] = {
            "old_path": e.get("old_path"),
            "new_path": e.get("new_path"),
        }
        for flag in ("new_file", "renamed_file", "deleted_file", "generated_file"):
            if e.get(flag):
                row[flag] = True
        # 18.4+ only. Absent means the instance does not report it, which is
        # not the same as False, so the key only appears when GitLab sent it.
        for flag in ("collapsed", "too_large"):
            if flag in e:
                row[flag] = bool(e[flag])

        diff = e.get("diff")
        if isinstance(diff, str) and diff:
            budget = min(per_file_bytes, total_bytes - spent)
            if len(diff) > budget:
                row["diff"] = diff[:budget]
                row["diff_truncated"] = True
                row["diff_full_bytes"] = len(diff)
            else:
                row["diff"] = diff
            spent += min(len(diff), budget)
        elif e.get("too_large"):
            row["diff_omitted"] = "GitLab reported this file's diff as too large to return."
        elif e.get("collapsed"):
            row["diff_omitted"] = "GitLab collapsed this file's diff; request the file directly to see it."
        files.append(row)

    out: dict[str, Any] = {"files": files, "returned": len(files)}
    if omitted:
        out["files_omitted"] = omitted
        out["omitted_note"] = (
            f"{omitted} further file(s) were dropped after the {total_bytes}-byte "
            "diff budget was spent. Page through with start_page, or read the "
            "files directly with gitlab_get_file."
        )
    return out


# ───────────────────────────── code search ─────────────────────────────────


def shape_blob_hit(h: Mapping[str, Any], *, max_data: int = 2_000) -> dict[str, Any]:
    """One code-search hit: where it is, and enough of it to judge relevance.

    `startline` is kept because it is what makes the hit actionable - it turns
    "somewhere in this file" into a line to open.
    """
    out: dict[str, Any] = {
        "path": h.get("path") or h.get("filename"),
        "basename": h.get("basename"),
        "ref": h.get("ref"),
        "startline": h.get("startline"),
        "project_id": h.get("project_id"),
    }
    data = h.get("data")
    if isinstance(data, str):
        out["match"] = data[:max_data]
        if len(data) > max_data:
            out["match_truncated"] = True
    return {k: v for k, v in out.items() if v is not None}


# ────────────────────────────── file content ───────────────────────────────


class BinaryFile(Exception):
    """Raised for a file whose bytes are not text.

    Not an error condition so much as a refusal with a reason: a model given
    the base64 of a PNG has spent thirty thousand tokens on nothing, and the
    useful answer is "this is a 240 KB binary, here is its size and type".
    """


def decode_file(payload: Mapping[str, Any], *, max_bytes: int = MAX_FILE_BYTES) -> dict[str, Any]:
    """Turn the file envelope into text, or explain why it cannot be.

    GitLab returns `content` base64-encoded with `encoding: "base64"`. The
    envelope is used rather than the `/raw` sibling precisely so that `size`
    is known BEFORE the bytes are decoded, and an oversized or binary file can
    be described rather than dumped.
    """
    size = payload.get("size")
    meta: dict[str, Any] = {
        "path": payload.get("file_path"),
        "ref": payload.get("ref"),
        "size": size,
        "last_commit_id": payload.get("last_commit_id"),
    }

    raw = payload.get("content")
    if not isinstance(raw, str):
        raise BinaryFile("GitLab returned no content for this path.")

    encoding = payload.get("encoding")
    try:
        data = base64.b64decode(raw, validate=False) if encoding == "base64" else raw.encode()
    except Exception:  # noqa: BLE001 - any decode failure means the same thing
        raise BinaryFile("The file content could not be base64-decoded.") from None

    # A NUL byte in the first block is the standard, cheap binary test, and the
    # one git itself uses. Checking the whole file would cost a scan of every
    # large text file to catch a case the first block already settles.
    if b"\x00" in data[:8000]:
        raise BinaryFile(
            f"{meta['path']} is a binary file ({size} bytes). Its bytes are not "
            "useful as text and are not returned."
        )

    truncated = len(data) > max_bytes
    text = data[:max_bytes].decode("utf-8", errors="replace")
    meta["content"] = text
    if truncated:
        meta["truncated"] = True
        meta["returned_bytes"] = max_bytes
        meta["note"] = (
            f"Only the first {max_bytes} bytes of {len(data)} are shown. Use "
            "gitlab_search_code to find the part you need."
        )
    return {k: v for k, v in meta.items() if v is not None}
