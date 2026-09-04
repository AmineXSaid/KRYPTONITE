"""deepwiki-mcp: the parts that must be right without a model in the loop.

A generation call needs an endpoint and is not what these guard. What they
guard is everything around it that decides whether the wiki is correct and
safe: the two wire formats' request/response shapes (get one wrong and every
call 400s in a way that reads like a model fault), the outline parser (models
wrap JSON in prose), the path safety of reading and serving files (a
model-proposed `../` must not escape the repo), and the staleness signal (a
wiki read as current when the checkout has moved on is the failure the whole
design is built to avoid).
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from deepwiki_mcp.config import (
    DeepWikiConfig,
    EndpointConfig,
    load_config,
    resolve_endpoint,
)
from deepwiki_mcp.endpoint import _body, _extract_text, _headers, _target_url
from deepwiki_mcp.generator import _normalise_pages, _parse_outline
from deepwiki_mcp.indexer import build_inventory, read_files
from deepwiki_mcp.shaping import manifest_summary
from deepwiki_mcp.store import Manifest, PageMeta, WikiStore, slug
from readonly_client.config import ConfigError


# ── config: serving starts without an endpoint, generating demands it ────────


def test_load_config_defaults_wiki_under_agent_dir(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("DEEPWIKI_WORKSPACE", str(tmp_path))
    monkeypatch.delenv("DEEPWIKI_WIKI_DIR", raising=False)
    cfg = load_config()
    assert cfg.workspace == tmp_path.resolve()
    assert cfg.wiki_dir == tmp_path / ".agent" / "wiki"
    assert cfg.manifest_path.name == "wiki.json"


def test_load_config_rejects_a_workspace_that_is_not_a_directory(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("DEEPWIKI_WORKSPACE", str(tmp_path / "nope"))
    with pytest.raises(ConfigError) as exc:
        load_config()
    assert "not a directory" in str(exc.value)


def test_resolve_endpoint_names_the_missing_variable(monkeypatch) -> None:
    for var in ("DEEPWIKI_ENDPOINT_URL", "DEEPWIKI_MODEL", "MCP_ENDPOINT_URL"):
        monkeypatch.delenv(var, raising=False)
    with pytest.raises(ConfigError) as exc:
        resolve_endpoint()
    assert "DEEPWIKI_ENDPOINT_URL" in str(exc.value)


def test_resolve_endpoint_kind_seeds_the_token_budget(monkeypatch) -> None:
    monkeypatch.setenv("DEEPWIKI_ENDPOINT_URL", "https://gw.internal/v1")
    monkeypatch.setenv("DEEPWIKI_MODEL", "gpt-x")
    monkeypatch.setenv("DEEPWIKI_ENDPOINT_KIND", "reasoning")
    monkeypatch.delenv("DEEPWIKI_MAX_OUTPUT_TOKENS", raising=False)
    cfg = resolve_endpoint()
    assert cfg.max_output_tokens == 8192  # the reasoning seed
    assert cfg.wire == "openai"  # default


# ── endpoint: the two wire formats, request and response ─────────────────────


def _openai_cfg(**over) -> EndpointConfig:
    base = dict(
        url="https://gw.internal/v1", wire="openai", model="m", api_key="k",
        kind="chat", max_output_tokens=1000, connect_timeout=1, read_timeout=1,
        ca_bundle=None,
    )
    base.update(over)
    return EndpointConfig(**base)  # type: ignore[arg-type]


def test_openai_wire_puts_system_in_a_message_and_bearer_in_the_header() -> None:
    cfg = _openai_cfg()
    body = _body(cfg, "SYS", "USER")
    assert body["messages"][0] == {"role": "system", "content": "SYS"}
    assert body["messages"][1] == {"role": "user", "content": "USER"}
    assert _headers(cfg)["authorization"] == "Bearer k"
    assert _target_url(cfg) == "https://gw.internal/v1/chat/completions"


def test_anthropic_wire_uses_system_field_and_x_api_key() -> None:
    cfg = _openai_cfg(wire="anthropic")
    body = _body(cfg, "SYS", "USER")
    assert body["system"] == "SYS"
    assert body["messages"] == [{"role": "user", "content": "USER"}]
    h = _headers(cfg)
    assert h["x-api-key"] == "k"
    assert h["anthropic-version"]
    assert "authorization" not in h
    assert _target_url(cfg) == "https://gw.internal/v1/v1/messages"


def test_a_full_completions_url_is_used_verbatim() -> None:
    cfg = _openai_cfg(url="https://gw.internal/openai/deployments/x/chat/completions")
    assert _target_url(cfg) == cfg.url


def test_a_missing_key_sends_no_auth_header() -> None:
    cfg = _openai_cfg(api_key=None)
    assert "authorization" not in _headers(cfg)


def test_extract_text_reads_each_wire_and_flags_empty() -> None:
    oai = _openai_cfg()
    assert _extract_text(oai, {"choices": [{"message": {"content": "hi"}}]}) == "hi"
    ant = _openai_cfg(wire="anthropic")
    assert _extract_text(ant, {"content": [{"type": "text", "text": "hi"}]}) == "hi"
    from deepwiki_mcp.endpoint import EndpointError

    with pytest.raises(EndpointError):
        _extract_text(oai, {"choices": []})


# ── generator: the outline parser and the normaliser ─────────────────────────


def test_parse_outline_finds_json_inside_prose_and_fences() -> None:
    fenced = 'Here is the outline:\n```json\n[{"title": "A"}]\n```\n'
    assert _parse_outline(fenced) == [{"title": "A"}]
    prose = 'Sure!\n[{"title": "B", "sources": []}]\nHope that helps.'
    assert _parse_outline(prose) == [{"title": "B", "sources": []}]
    assert _parse_outline("not json at all") == []


def test_normalise_drops_hallucinated_sources_and_untitled_pages() -> None:
    raw = [
        {"title": "Overview", "sources": ["real.py", "ghost.py"]},
        {"title": "", "sources": ["real.py"]},  # dropped: no title
        {"title": "Overview", "sources": []},  # id collision -> -2
    ]
    metas, warnings = _normalise_pages(raw, {"real.py"}, max_pages=10)
    assert [m.id for m in metas] == ["overview", "overview-2"]
    assert metas[0].sources == ["real.py"]  # ghost.py dropped
    assert not warnings  # first page kept a real source


def test_normalise_warns_when_every_source_was_hallucinated() -> None:
    raw = [{"title": "Ghosts", "sources": ["nope.py"]}]
    metas, warnings = _normalise_pages(raw, {"real.py"}, max_pages=10)
    assert metas[0].sources == []
    assert warnings and "matched real files" in warnings[0]


# ── indexer: the walk, the caps, and the path escape guard ───────────────────


def _make_repo(root: Path) -> None:
    (root / "src").mkdir()
    (root / "src" / "main.py").write_text("print('hi')\n")
    (root / "README.md").write_text("# Repo\n")
    (root / "node_modules").mkdir()
    (root / "node_modules" / "junk.js").write_text("x=1\n")
    (root / "logo.png").write_bytes(b"\x89PNG\x00\x00")


def _cfg_for(root: Path) -> DeepWikiConfig:
    return DeepWikiConfig(workspace=root, wiki_dir=root / ".agent" / "wiki")


def test_inventory_prunes_ignored_trees_and_binary_extensions(tmp_path) -> None:
    _make_repo(tmp_path)
    inv = build_inventory(_cfg_for(tmp_path))
    rels = {f.rel for f in inv.files}
    assert "src/main.py" in rels
    assert "README.md" in rels
    assert "node_modules/junk.js" not in rels  # pruned tree
    assert "logo.png" not in rels  # skipped extension


def test_read_files_refuses_to_escape_the_workspace(tmp_path) -> None:
    _make_repo(tmp_path)
    cfg = _cfg_for(tmp_path)
    loaded = read_files(cfg, ["src/main.py", "../../etc/passwd", "/etc/hosts"])
    assert [f.rel for f in loaded] == ["src/main.py"]


def test_read_files_skips_binary_content(tmp_path) -> None:
    _make_repo(tmp_path)
    (tmp_path / "blob.txt").write_bytes(b"text\x00more")
    loaded = read_files(_cfg_for(tmp_path), ["blob.txt"])
    assert loaded == []


# ── store: round-trip, search ranking, orphan cleanup ────────────────────────


def _manifest() -> Manifest:
    return Manifest(
        generated_at="2026-01-01T00:00:00Z",
        model="m",
        source_commit="abc123",
        pages=[
            PageMeta(id="architecture-overview", title="Architecture Overview",
                     summary="How it fits together", sources=["src/main.py"]),
            PageMeta(id="endpoints", title="Endpoints",
                     summary="Profile resolution", sources=[]),
        ],
    )


def test_save_then_read_round_trips_and_search_ranks_titles_first(tmp_path) -> None:
    cfg = _cfg_for(tmp_path)
    store = WikiStore(cfg)
    store.save(
        _manifest(),
        {
            "architecture-overview": "# Architecture Overview\n\nThe endpoints layer...",
            "endpoints": "# Endpoints\n\nEndpoints endpoints endpoints.",
        },
    )
    assert store.exists()
    assert "Architecture" in (store.read_page("architecture-overview") or "")
    # A title hit on "Endpoints" outranks the body-only mentions elsewhere.
    hits = store.search("endpoints")
    assert hits[0]["id"] == "endpoints"


def test_save_removes_orphaned_pages(tmp_path) -> None:
    cfg = _cfg_for(tmp_path)
    store = WikiStore(cfg)
    store.save(_manifest(), {"architecture-overview": "a", "endpoints": "b"})
    # Regenerate with only one page; the other's file must go.
    smaller = Manifest(
        generated_at="2026-01-02T00:00:00Z", model="m", source_commit="def456",
        pages=[PageMeta(id="endpoints", title="Endpoints", summary="", sources=[])],
    )
    store.save(smaller, {"endpoints": "b2"})
    assert not (cfg.pages_dir / "architecture-overview.md").exists()
    assert store.read_page("endpoints") == "b2"


def test_read_page_rejects_a_traversing_id(tmp_path) -> None:
    cfg = _cfg_for(tmp_path)
    WikiStore(cfg).save(_manifest(), {"architecture-overview": "a", "endpoints": "b"})
    # slug() strips the traversal; the resolved path stays inside pages_dir.
    assert WikiStore(cfg).read_page("../../wiki") is None


# ── shaping: the staleness signal ────────────────────────────────────────────


def test_status_flags_stale_when_the_checkout_moved_on() -> None:
    out = manifest_summary(_manifest(), current_commit="zzz999")
    assert out["stale"] is True
    assert out["current_commit"] == "zzz999"
    assert "regenerate" in out["stale_note"]


def test_status_is_not_stale_at_the_same_commit() -> None:
    out = manifest_summary(_manifest(), current_commit="abc123")
    assert out["stale"] is False


def test_status_says_when_nothing_is_generated() -> None:
    out = manifest_summary(None, current_commit="abc123")
    assert out["generated"] is False


def test_slug_is_filesystem_safe() -> None:
    assert slug("Architecture Overview!") == "architecture-overview"
    assert slug("  ") == "page"
