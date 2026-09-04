"""The generated wiki on disk, and the read/search surface over it.

The wiki is plain files in the repo, not a database, because that is the whole
point of doing this locally: it is versioned with the code, diffable in a pull
request, and readable with no server running. The layout is:

    .agent/wiki/
      wiki.json          the manifest - pages, when, from which commit, model
      pages/<id>.md      one Markdown page each, with Mermaid where it earns it

This module owns that layout. `save` writes it, and the read helpers
(`list_pages`, `read_page`, `search`) are what the MCP tools serve from. Search
is deliberately a plain keyword scorer, not an embedding index: an embedding
store is infra an air-gapped box may not be able to build, and it is the exact
"cloud-shaped" dependency this server exists to avoid. Keyword search over a
few dozen curated pages is enough to route a question to the right one, which
is all retrieval has to do here.
"""

from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .config import DeepWikiConfig

# A page id is a filename, so it is constrained to something that cannot escape
# the pages directory or collide across case-insensitive filesystems.
_ID_RE = re.compile(r"[^a-z0-9._-]+")

MANIFEST_VERSION = 1


def slug(text: str) -> str:
    """A filesystem- and URL-safe id from a human title."""
    s = _ID_RE.sub("-", text.strip().lower()).strip("-")
    return s or "page"


@dataclass
class PageMeta:
    """A page's entry in the manifest - everything but its body."""

    id: str
    title: str
    summary: str
    # Workspace-relative source files this page was grounded in, so a reader
    # (human or model) can jump from the prose to the code it describes.
    sources: list[str] = field(default_factory=list)


@dataclass
class Manifest:
    generated_at: str
    model: str
    source_commit: str | None
    pages: list[PageMeta] = field(default_factory=list)
    version: int = MANIFEST_VERSION

    def to_json(self) -> dict[str, Any]:
        d = asdict(self)
        return d

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> "Manifest":
        pages = [
            PageMeta(
                id=str(p.get("id", "")),
                title=str(p.get("title", "")),
                summary=str(p.get("summary", "")),
                sources=[str(s) for s in p.get("sources", []) if isinstance(s, str)],
            )
            for p in data.get("pages", [])
            if isinstance(p, dict)
        ]
        return cls(
            generated_at=str(data.get("generated_at", "")),
            model=str(data.get("model", "")),
            source_commit=data.get("source_commit"),
            pages=pages,
            version=int(data.get("version", MANIFEST_VERSION)),
        )


class WikiStore:
    """Read and write the wiki under a config's ``wiki_dir``."""

    def __init__(self, cfg: DeepWikiConfig) -> None:
        self._cfg = cfg

    def exists(self) -> bool:
        return self._cfg.manifest_path.is_file()

    def load_manifest(self) -> Manifest | None:
        path = self._cfg.manifest_path
        if not path.is_file():
            return None
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        if not isinstance(data, dict):
            return None
        return Manifest.from_json(data)

    def read_page(self, page_id: str) -> str | None:
        page_id = slug(page_id)
        path = self._cfg.pages_dir / f"{page_id}.md"
        try:
            path.resolve().relative_to(self._cfg.pages_dir.resolve())
        except ValueError:
            return None
        if not path.is_file():
            return None
        try:
            return path.read_text(encoding="utf-8")
        except OSError:
            return None

    def search(self, query: str, limit: int = 5) -> list[dict[str, Any]]:
        """Keyword-score pages against a query, best first.

        Scoring weights a title hit above a summary hit above a body hit,
        because a term in a page's title is a far stronger signal that the page
        is *about* that term than one mention buried in its body. Each result
        carries the snippet the match came from, so a caller can decide whether
        to read the whole page without paying for it first.
        """
        manifest = self.load_manifest()
        if manifest is None:
            return []
        terms = [t for t in re.split(r"\s+", query.strip().lower()) if t]
        if not terms:
            return []

        scored: list[tuple[float, dict[str, Any]]] = []
        for meta in manifest.pages:
            body = self.read_page(meta.id) or ""
            body_l = body.lower()
            title_l = meta.title.lower()
            summ_l = meta.summary.lower()
            score = 0.0
            for t in terms:
                score += 5.0 * title_l.count(t)
                score += 2.0 * summ_l.count(t)
                score += 1.0 * min(body_l.count(t), 10)  # cap body spam
            if score <= 0:
                continue
            scored.append(
                (
                    score,
                    {
                        "id": meta.id,
                        "title": meta.title,
                        "summary": meta.summary,
                        "sources": meta.sources,
                        "snippet": _snippet(body, terms),
                        "score": round(score, 1),
                    },
                )
            )
        scored.sort(key=lambda pair: -pair[0])
        return [item for _, item in scored[:limit]]

    def save(self, manifest: Manifest, bodies: dict[str, str]) -> None:
        """Write the manifest and every page body atomically enough.

        Old pages that are no longer in the manifest are removed, so a
        regeneration that produced fewer pages does not leave orphans behind
        that ``search`` would still surface.
        """
        pages_dir = self._cfg.pages_dir
        pages_dir.mkdir(parents=True, exist_ok=True)

        keep = {f"{meta.id}.md" for meta in manifest.pages}
        for existing in pages_dir.glob("*.md"):
            if existing.name not in keep:
                try:
                    existing.unlink()
                except OSError:
                    pass

        for meta in manifest.pages:
            body = bodies.get(meta.id, "")
            (pages_dir / f"{meta.id}.md").write_text(body, encoding="utf-8")

        self._cfg.manifest_path.write_text(
            json.dumps(manifest.to_json(), indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )


def _snippet(body: str, terms: list[str], width: int = 240) -> str:
    """The window of body text around the first matching term."""
    low = body.lower()
    pos = -1
    for t in terms:
        i = low.find(t)
        if i != -1 and (pos == -1 or i < pos):
            pos = i
    if pos == -1:
        return body[:width].strip()
    start = max(0, pos - width // 3)
    end = min(len(body), start + width)
    snippet = body[start:end].strip().replace("\n", " ")
    return ("..." if start > 0 else "") + snippet + ("..." if end < len(body) else "")


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
