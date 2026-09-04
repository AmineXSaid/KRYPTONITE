"""The DeepWiki pipeline: index -> outline -> write each page -> save.

This is the blueprint the open-source agentic DeepWikis use, adapted to run
through a Genesis endpoint profile rather than a hardcoded cloud model:

  1. **Index** the workspace into an inventory (indexer.py).
  2. **Outline** - hand the model the inventory and ask it to propose the
     wiki's pages: a title, a one-line summary, and the source files each page
     should be grounded in. This is the step that decides the shape of the
     wiki, so it gets the whole repo shape and nothing else.
  3. **Write each page** - for every proposed page, load the bodies of its
     source files (capped) and ask the model to write that page grounded in
     them, with a Mermaid diagram where the structure earns one.
  4. **Save** the manifest and pages to ``.agent/wiki`` (store.py).

The model's outline reply is parsed defensively: models wrap JSON in prose or
fences, so the parser finds the JSON array rather than trusting the whole reply
to be JSON, and a page with no usable title is dropped rather than written as
``page.md``. A generation that yields zero valid pages raises rather than
saving an empty wiki over a good one.
"""

from __future__ import annotations

import json
import re
import subprocess
from dataclasses import dataclass
from typing import Any

from .config import DeepWikiConfig, EndpointConfig
from .endpoint import Endpoint, EndpointError
from .indexer import build_inventory, read_files, render_inventory
from .store import Manifest, PageMeta, WikiStore, now_iso, slug

# How many pages a single generation will write, at most. A wiki is a map, not
# a mirror - past this it stops being navigable, and every page is another
# model call. Overridable per call.
DEFAULT_MAX_PAGES = 12

# How many source files one page may be grounded in. More than this and the
# page prompt stops fitting; the outline is nudged to keep pages focused.
MAX_SOURCES_PER_PAGE = 12


_OUTLINE_SYSTEM = """\
You are a principal engineer writing the outline for a technical wiki of a \
codebase. You are given an inventory of the repository's files. Propose the \
pages the wiki should have: enough to explain the system to a new contributor, \
never one page per file. Cover, where they exist: an architecture overview, \
the main modules or subsystems, key data flows, configuration, and how to run \
or extend it.

Reply with ONLY a JSON array, no prose, no code fences. Each element:
  {
    "title": "Human page title",
    "summary": "One sentence on what this page covers.",
    "sources": ["path/relative/to/repo.ext", ...]
  }
List between 4 and %d pages. Put an "Architecture Overview" page first. In \
each page's "sources", list only real paths from the inventory, at most %d, \
most important first.\
"""

_PAGE_SYSTEM = """\
You are a principal engineer writing ONE page of a codebase wiki. You are given \
the page's title, the files it should be grounded in with their contents, and \
the repository's overall shape for context. Write the page in Markdown.

Rules:
- Ground every claim in the provided files. Do not invent APIs, files, or \
behaviour. If something is unclear from the code, say so plainly.
- Open with a short paragraph on what this part of the system does and why.
- Use ## and ### headings, short paragraphs, and lists where they help.
- Where the structure earns it (a flow, a state machine, a module graph), \
include exactly one Mermaid diagram in a ```mermaid fenced block. Do not force \
one where prose is clearer.
- Reference real files as `path/to/file.ext` so a reader can open them.
- Do not include the page title as an H1; it is added for you. Start at the \
first paragraph.\
"""


@dataclass
class GenerationResult:
    pages_written: int
    titles: list[str]
    model: str
    source_commit: str | None
    warnings: list[str]


def _source_commit(cfg: DeepWikiConfig) -> str | None:
    """The HEAD commit, so the manifest records what the wiki was built from.

    Best-effort: a workspace that is not a git checkout simply records no
    commit rather than failing generation.
    """
    try:
        out = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=str(cfg.workspace),
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    sha = out.stdout.strip()
    return sha or None


def _parse_outline(reply: str) -> list[dict[str, Any]]:
    """Find and parse the JSON array in a model reply that may wrap it."""
    text = reply.strip()
    # Strip a leading ```json / ``` fence if present.
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\n", "", text)
        text = re.sub(r"\n```\s*$", "", text)
    # Fall back to the first bracketed array anywhere in the reply.
    if not text.lstrip().startswith("["):
        m = re.search(r"\[.*\]", text, re.DOTALL)
        if m:
            text = m.group(0)
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return []
    if not isinstance(data, list):
        return []
    return [d for d in data if isinstance(d, dict)]


def _normalise_pages(
    raw: list[dict[str, Any]], inventory_paths: set[str], max_pages: int
) -> tuple[list[PageMeta], list[str]]:
    """Turn raw outline dicts into deduped PageMeta, dropping the unusable.

    Source paths not in the inventory are dropped (a model can hallucinate a
    path); a page left with no title is dropped entirely. Ids are deduped so
    two pages never fight over one filename.
    """
    metas: list[PageMeta] = []
    warnings: list[str] = []
    seen_ids: set[str] = set()
    for item in raw:
        title = str(item.get("title", "")).strip()
        if not title:
            continue
        base = slug(title)
        page_id = base
        n = 2
        while page_id in seen_ids:
            page_id = f"{base}-{n}"
            n += 1
        seen_ids.add(page_id)

        sources_in = item.get("sources", [])
        sources: list[str] = []
        for s in sources_in if isinstance(sources_in, list) else []:
            s = str(s).strip().lstrip("/")
            if s in inventory_paths and s not in sources:
                sources.append(s)
            if len(sources) >= MAX_SOURCES_PER_PAGE:
                break
        if isinstance(sources_in, list) and not sources and sources_in:
            warnings.append(
                f"Page {title!r}: none of its proposed sources matched real "
                "files; it was written from the repository shape only."
            )
        metas.append(
            PageMeta(
                id=page_id,
                title=title,
                summary=str(item.get("summary", "")).strip(),
                sources=sources,
            )
        )
        if len(metas) >= max_pages:
            break
    return metas, warnings


def _page_user_prompt(
    meta: PageMeta, files: list[Any], inventory_digest: str
) -> str:
    parts = [f"# Page to write: {meta.title}", ""]
    if meta.summary:
        parts += [f"Intended scope: {meta.summary}", ""]
    parts += ["## Repository shape (for context)", inventory_digest[:4000], ""]
    if files:
        parts.append("## Source files to ground this page in")
        for f in files:
            trunc = "  (truncated)" if getattr(f, "truncated", False) else ""
            parts.append(f"\n### `{f.rel}`{trunc}\n```\n{f.text}\n```")
    else:
        parts.append(
            "## Source files\n(No specific files were resolved for this page; "
            "write from the repository shape above and be explicit about what "
            "you cannot see.)"
        )
    return "\n".join(parts)


async def generate_wiki(
    cfg: DeepWikiConfig,
    endpoint_cfg: EndpointConfig,
    *,
    max_pages: int = DEFAULT_MAX_PAGES,
    focus: str | None = None,
) -> GenerationResult:
    """Run the full pipeline and write the wiki. Raises on an empty result."""
    inv = build_inventory(cfg)
    if not inv.files:
        raise EndpointError(
            "The workspace has no indexable source files. Check "
            "DEEPWIKI_WORKSPACE points at the repository root."
        )
    digest = render_inventory(inv)
    inventory_paths = {f.rel for f in inv.files}

    endpoint = Endpoint(endpoint_cfg)
    try:
        outline_system = _OUTLINE_SYSTEM % (max_pages, MAX_SOURCES_PER_PAGE)
        outline_user = digest
        if focus:
            outline_user = (
                f"Focus the wiki on: {focus}\n\n"
                "Still include an architecture overview, but weight the pages "
                "toward that area.\n\n" + digest
            )
        outline_reply = await endpoint.chat(outline_system, outline_user)
        raw_pages = _parse_outline(outline_reply)
        if not raw_pages:
            raise EndpointError(
                "The model's outline could not be parsed as a JSON array of "
                "pages. This usually means the endpoint returned prose; check "
                "that DEEPWIKI_MODEL is an instruction-following model."
            )
        metas, warnings = _normalise_pages(raw_pages, inventory_paths, max_pages)
        if not metas:
            raise EndpointError(
                "The outline contained no usable pages (every entry lacked a "
                "title). Nothing was written; the previous wiki, if any, is "
                "untouched."
            )

        bodies: dict[str, str] = {}
        for meta in metas:
            files = read_files(cfg, meta.sources) if meta.sources else []
            user = _page_user_prompt(meta, files, digest)
            try:
                body = await endpoint.chat(_PAGE_SYSTEM, user)
            except EndpointError as exc:
                warnings.append(f"Page {meta.title!r} failed to generate: {exc}")
                body = (
                    f"_This page could not be generated: {exc}_\n\n"
                    f"Intended scope: {meta.summary}"
                )
            # The H1 is ours; the model was told to start at the first
            # paragraph, so add the title and a source footer.
            header = f"# {meta.title}\n\n"
            footer = ""
            if meta.sources:
                footer = "\n\n---\n\n_Grounded in:_ " + ", ".join(
                    f"`{s}`" for s in meta.sources
                )
            bodies[meta.id] = header + body.strip() + footer
    finally:
        await endpoint.aclose()

    manifest = Manifest(
        generated_at=now_iso(),
        model=endpoint_cfg.model,
        source_commit=_source_commit(cfg),
        pages=metas,
    )
    WikiStore(cfg).save(manifest, bodies)

    return GenerationResult(
        pages_written=len(metas),
        titles=[m.title for m in metas],
        model=endpoint_cfg.model,
        source_commit=manifest.source_commit,
        warnings=warnings,
    )


_ASK_SYSTEM = """\
You are answering a question about a codebase using its wiki. You are given the \
question and the most relevant wiki pages. Answer from the pages. Cite the page \
titles you used. If the pages do not contain the answer, say so and suggest \
which part of the code to read - do not guess.\
"""


async def ask_wiki(
    cfg: DeepWikiConfig,
    endpoint_cfg: EndpointConfig,
    question: str,
    *,
    max_pages: int = 4,
) -> dict[str, Any]:
    """Answer a question by retrieving relevant pages and asking the model.

    This is the one push surface: its whole job is to answer *from* the wiki,
    so here feeding wiki text into the prompt is the point, not a leak of
    generated text into unrelated context.
    """
    store = WikiStore(cfg)
    if not store.exists():
        raise EndpointError(
            "No wiki has been generated yet. Run generate_wiki first."
        )
    hits = store.search(question, limit=max_pages)
    if not hits:
        # Fall back to the first few pages rather than refusing - a question
        # with no keyword overlap can still be answered from the overview.
        manifest = store.load_manifest()
        pages = (manifest.pages[:max_pages] if manifest else [])
        hits = [{"id": p.id, "title": p.title} for p in pages]

    context_parts = []
    used = []
    for hit in hits:
        body = store.read_page(hit["id"])
        if body:
            context_parts.append(body)
            used.append(hit["title"])
    if not context_parts:
        raise EndpointError("The wiki has no readable pages to answer from.")

    user = (
        f"Question: {question}\n\n"
        "=== Relevant wiki pages ===\n\n" + "\n\n---\n\n".join(context_parts)
    )
    endpoint = Endpoint(endpoint_cfg)
    try:
        answer = await endpoint.chat(_ASK_SYSTEM, user)
    finally:
        await endpoint.aclose()
    return {"answer": answer, "pages_used": used}
