"""Shaping wiki data into what a tool result should carry.

Small on purpose: the wiki is already curated prose, so there is far less to
cut down than a raw Jira payload needs. What lives here is the staleness signal
- the one fact a model consuming the wiki most needs and would otherwise never
learn: the wiki was built from a commit, and the checkout may have moved on
since. A page read as current truth when it is three hundred commits stale is
the failure this whole design is careful about, so every status carries the
commit it came from and lets the caller judge.
"""

from __future__ import annotations

from typing import Any

from .store import Manifest


def manifest_summary(manifest: Manifest | None, current_commit: str | None) -> dict[str, Any]:
    """The wiki's status: whether it exists, when, and whether it may be stale."""
    if manifest is None:
        return {
            "generated": False,
            "pages": 0,
            "note": "No wiki has been generated yet. Call generate_wiki.",
        }
    out: dict[str, Any] = {
        "generated": True,
        "generated_at": manifest.generated_at,
        "model": manifest.model,
        "pages": len(manifest.pages),
        "source_commit": manifest.source_commit,
        "titles": [p.title for p in manifest.pages],
    }
    if manifest.source_commit and current_commit:
        if manifest.source_commit != current_commit:
            out["stale"] = True
            out["current_commit"] = current_commit
            out["stale_note"] = (
                "The workspace has moved past the commit this wiki was built "
                f"from ({manifest.source_commit[:8]} -> {current_commit[:8]}). "
                "Pages may not reflect the current code; regenerate if accuracy "
                "matters for this task."
            )
        else:
            out["stale"] = False
    return out


def page_list(manifest: Manifest | None) -> dict[str, Any]:
    if manifest is None:
        return {"pages": [], "note": "No wiki yet; call generate_wiki."}
    return {
        "pages": [
            {"id": p.id, "title": p.title, "summary": p.summary, "sources": p.sources}
            for p in manifest.pages
        ],
        "returned": len(manifest.pages),
    }
