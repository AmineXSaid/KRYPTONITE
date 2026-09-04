"""deepwiki-mcp - generate a codebase wiki through a Genesis endpoint, then
serve it back to any agent that needs to understand the repo.

The tool surface is split by intent, and the descriptions are written for a
model choosing between tools, because that is all it reads:

  READ (no endpoint needed, cheap, safe to call often)
    wiki_status      is there a wiki, from which commit, is it stale
    list_wiki_pages  the table of contents
    read_wiki_page   one page's Markdown
    search_wiki      keyword-rank pages for a topic, with snippets

  ASK / BUILD (needs the endpoint profile)
    ask_wiki         answer a question from the wiki, citing pages
    generate_wiki    (re)build the wiki from the current code

The read tools are the "triggers whenever needed automatically" surface: an
agent working in the repo calls search_wiki / read_wiki_page to ground itself
before editing, and pays no standing context for the wiki the rest of the time.
Generation stays explicit - it costs model calls and rewrites files in the
repo, so it is never a silent side effect of a read.
"""

from __future__ import annotations

import subprocess
import sys
from typing import Any

from readonly_client.config import ConfigError
from readonly_client.errors import ServiceError

from .config import DeepWikiConfig, load_config, resolve_endpoint
from .endpoint import EndpointError
from .generator import ask_wiki as _ask_wiki
from .generator import generate_wiki as _generate_wiki
from readonly_client.mcp_compat import build_server
from .shaping import manifest_summary, page_list
from .store import WikiStore

mcp = build_server(
    "deepwiki-mcp",
    instructions=(
        "A wiki of THIS repository, generated from its own code. Use it to "
        "understand the codebase before answering questions about it or editing "
        "it: search_wiki to find the right page for a topic, read_wiki_page to "
        "read one, ask_wiki for a direct answer. It is generated locally through "
        "the configured model endpoint and lives in the repo under .agent/wiki, "
        "so it works offline once built. Prefer it over re-reading many files "
        "when you need the shape of the system rather than an exact line."
    ),
)

# Resolved at startup by main(). Module-level because the SDK's tool functions
# are plain callables with no dependency-injection seam.
_config: DeepWikiConfig | None = None


def _cfg() -> DeepWikiConfig:
    if _config is None:
        raise ServiceError(
            "deepwiki-mcp is not initialised. This is a bug: main() must run "
            "before any tool is called."
        )
    return _config


def _current_commit() -> str | None:
    try:
        out = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=str(_cfg().workspace),
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return out.stdout.strip() or None


@mcp.tool()
def wiki_status() -> dict[str, Any]:
    """Is there a generated wiki for this repo, and is it current? READ-ONLY.

    Call this first when a task needs repo understanding. It tells you whether a
    wiki exists, how many pages it has, which commit it was built from, and -
    the fact that matters most - whether the checkout has moved past that commit
    so the pages may be stale. Needs no model endpoint.

    Returns the page titles too, so you can often route to the right page from
    this one call without a separate list.
    """
    store = WikiStore(_cfg())
    return manifest_summary(store.load_manifest(), _current_commit())


@mcp.tool()
def list_wiki_pages() -> dict[str, Any]:
    """The wiki's table of contents. READ-ONLY.

    Each entry is a page id, its title, a one-line summary, and the source
    files it was grounded in. Use the id with read_wiki_page. Needs no model
    endpoint.
    """
    return page_list(WikiStore(_cfg()).load_manifest())


@mcp.tool()
def read_wiki_page(page_id: str) -> dict[str, Any]:
    """Read one wiki page's Markdown by its id. READ-ONLY.

    Args:
        page_id: The id from list_wiki_pages or search_wiki (e.g.
            'architecture-overview'). A title works too; it is slugified.

    Returns the page body, including any Mermaid diagram, and the source files
    it cites so you can open the real code. Needs no model endpoint.
    """
    store = WikiStore(_cfg())
    body = store.read_page(page_id)
    if body is None:
        manifest = store.load_manifest()
        known = [p.id for p in manifest.pages] if manifest else []
        raise ServiceError(
            f"No wiki page {page_id!r}. "
            + (f"Known pages: {', '.join(known)}." if known
               else "No wiki has been generated yet; call generate_wiki.")
        )
    meta = None
    manifest = store.load_manifest()
    if manifest:
        meta = next((p for p in manifest.pages if p.id == body_id(page_id)), None)
    return {
        "id": body_id(page_id),
        "title": meta.title if meta else page_id,
        "sources": meta.sources if meta else [],
        "markdown": body,
    }


@mcp.tool()
def search_wiki(query: str, max_results: int = 5) -> dict[str, Any]:
    """Find the wiki pages most relevant to a topic. READ-ONLY.

    This is the tool to reach for when you have a question about how this repo
    works and want the right page fast. It keyword-ranks pages (title matches
    beat summary matches beat body matches) and returns each with a snippet, so
    you can pick one to read in full. Needs no model endpoint.

    Args:
        query: What you are trying to understand, e.g. 'how are endpoint
            profiles resolved' or 'session persistence'.
        max_results: How many pages to return. Default 5.

    Returns ranked hits with id, title, summary, snippet and score. Empty
    `hits` means no page matched - try list_wiki_pages, or ask_wiki.
    """
    if not query or not query.strip():
        raise ServiceError("query is required, e.g. 'authentication flow'.")
    hits = WikiStore(_cfg()).search(query, limit=max(1, min(int(max_results or 5), 20)))
    out: dict[str, Any] = {"hits": hits, "returned": len(hits)}
    if not hits:
        out["note"] = (
            "No page matched. Either the wiki does not cover this yet "
            "(list_wiki_pages to see what it does), or it needs regenerating."
        )
    return out


@mcp.tool()
async def ask_wiki(question: str) -> dict[str, Any]:
    """Answer a question about this repo from its wiki. Needs the model endpoint.

    Use this for a direct answer rather than reading pages yourself. It finds
    the relevant pages and has the model answer from them, citing which pages it
    used. If the wiki does not cover the answer, it says so instead of guessing.

    Args:
        question: A natural-language question about the codebase.

    Requires DEEPWIKI_ENDPOINT_URL / _MODEL to be configured; the error names
    what is missing. For pure navigation, search_wiki + read_wiki_page need no
    endpoint and are cheaper.
    """
    if not question or not question.strip():
        raise ServiceError("question is required.")
    endpoint_cfg = resolve_endpoint()  # raises ConfigError naming the fix
    return await _ask_wiki(_cfg(), endpoint_cfg, question)


@mcp.tool()
async def generate_wiki(max_pages: int = 12, focus: str | None = None) -> dict[str, Any]:
    """(Re)build the wiki from the current code. Needs the model endpoint.

    This indexes the workspace, asks the model to outline the wiki, writes each
    page grounded in real files, and saves it to .agent/wiki (overwriting any
    previous wiki). It makes one model call per page, so it is the expensive
    tool - call it when the wiki is missing or wiki_status reports it stale, not
    on every question.

    Args:
        max_pages: Upper bound on pages to write. Default 12.
        focus: Optional area to weight the wiki toward, e.g. 'the endpoint and
            transport layer'. Omit for a whole-repo wiki.

    Requires DEEPWIKI_ENDPOINT_URL / _MODEL. Returns the pages written, the
    model and commit recorded, and any per-page warnings.
    """
    endpoint_cfg = resolve_endpoint()  # raises ConfigError naming the fix
    result = await _generate_wiki(
        _cfg(), endpoint_cfg,
        max_pages=max(1, min(int(max_pages or 12), 40)),
        focus=focus,
    )
    return {
        "pages_written": result.pages_written,
        "titles": result.titles,
        "model": result.model,
        "source_commit": result.source_commit,
        "wiki_dir": str(_cfg().wiki_dir),
        "warnings": result.warnings,
    }


def body_id(page_id: str) -> str:
    from .store import slug

    return slug(page_id)


def main() -> int:
    """Start the server, or refuse and say what is wrong with the workspace.

    Only the serving configuration is validated here; the endpoint profile is
    resolved lazily so the read tools work with no model configured at all.
    """
    global _config
    try:
        _config = load_config()
    except ConfigError as exc:
        # stderr, not stdout: stdout is the MCP transport.
        print(f"deepwiki-mcp: configuration error\n  {exc}", file=sys.stderr)
        return 2

    mcp.run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
