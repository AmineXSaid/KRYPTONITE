"""Reading the workspace off disk into something a model can be handed.

The generator needs two different views of the repo and this module builds
both from one walk:

    * an **inventory** - every source file's path, size and language - which is
      cheap, complete, and small enough to send whole. It is what the outline
      step reasons over: "here is the shape of the repo, propose the pages."
    * **file bodies on demand** - the actual text of a named set of files,
      capped per file, which is what a page-writing step is grounded in.

Two caps keep a large repo from blowing either the wall clock or the context
budget, and both are honest about it: a file over the byte cap is listed with
its size but its body is fetched only up to the cap and marked truncated; a
repo over the file cap stops walking and the inventory says it was cut. The
alternative - silently indexing a slice and calling it the repo - is the
failure that produces a confidently wrong wiki.

Binary files are detected by a NUL byte in their head and never read as text.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from .config import ALWAYS_IGNORE_DIRS, DeepWikiConfig

# Extension -> a language label the model recognises. Not exhaustive; an
# unlisted extension is still indexed, just labelled by its bare suffix.
_LANG_BY_EXT = {
    ".py": "Python", ".ts": "TypeScript", ".tsx": "TypeScript (React)",
    ".js": "JavaScript", ".jsx": "JavaScript (React)", ".mjs": "JavaScript",
    ".cjs": "JavaScript", ".go": "Go", ".rs": "Rust", ".java": "Java",
    ".kt": "Kotlin", ".rb": "Ruby", ".php": "PHP", ".c": "C", ".h": "C header",
    ".cc": "C++", ".cpp": "C++", ".hpp": "C++ header", ".cs": "C#",
    ".swift": "Swift", ".scala": "Scala", ".sh": "Shell", ".bash": "Shell",
    ".sql": "SQL", ".css": "CSS", ".scss": "SCSS", ".html": "HTML",
    ".vue": "Vue", ".svelte": "Svelte", ".yaml": "YAML", ".yml": "YAML",
    ".toml": "TOML", ".json": "JSON", ".md": "Markdown", ".rst": "reStructuredText",
    ".proto": "Protobuf", ".graphql": "GraphQL", ".tf": "Terraform",
    ".dockerfile": "Dockerfile",
}

# Files worth indexing for their name even with no useful body, and files that
# anchor a repo's story - a model should always see these exist.
_ANCHOR_NAMES = frozenset(
    {
        "readme.md", "readme.rst", "readme.txt", "package.json", "pyproject.toml",
        "cargo.toml", "go.mod", "pom.xml", "build.gradle", "dockerfile",
        "docker-compose.yml", "makefile", "tsconfig.json", "requirements.txt",
        "setup.py", "setup.cfg", ".gitignore", "license",
    }
)

# Extensions that are never source and only bloat the inventory.
_SKIP_EXT = frozenset(
    {
        ".lock", ".map", ".min.js", ".min.css", ".png", ".jpg", ".jpeg", ".gif",
        ".svg", ".ico", ".webp", ".woff", ".woff2", ".ttf", ".eot", ".otf",
        ".pdf", ".zip", ".gz", ".tar", ".mp4", ".mov", ".mp3", ".wav", ".pyc",
        ".class", ".o", ".so", ".dylib", ".dll", ".exe", ".bin", ".wasm",
    }
)


def language_for(path: Path) -> str:
    name = path.name.lower()
    if name == "dockerfile" or name.endswith(".dockerfile"):
        return "Dockerfile"
    return _LANG_BY_EXT.get(path.suffix.lower(), path.suffix.lstrip(".") or "text")


@dataclass
class FileEntry:
    """One file in the inventory. `rel` is POSIX, workspace-relative, stable."""

    rel: str
    size: int
    language: str


@dataclass
class Inventory:
    """The whole indexed shape of the repo."""

    files: list[FileEntry] = field(default_factory=list)
    truncated: bool = False
    total_bytes: int = 0

    def by_language(self) -> dict[str, int]:
        counts: dict[str, int] = {}
        for f in self.files:
            counts[f.language] = counts.get(f.language, 0) + 1
        return dict(sorted(counts.items(), key=lambda kv: -kv[1]))


def _is_skippable(name: str, suffix: str) -> bool:
    if name in _ANCHOR_NAMES:
        return False
    if suffix in _SKIP_EXT:
        return True
    # Compound suffixes the single-suffix check misses.
    return name.endswith((".min.js", ".min.css", ".d.ts.map"))


def build_inventory(cfg: DeepWikiConfig) -> Inventory:
    """Walk the workspace once, pruning ignored trees, into an Inventory."""
    inv = Inventory()
    root = cfg.workspace
    for dirpath, dirnames, filenames in os.walk(root):
        # Prune in place so os.walk does not descend into ignored trees at all.
        dirnames[:] = [
            d for d in sorted(dirnames)
            if d not in ALWAYS_IGNORE_DIRS and not d.startswith(".cache")
        ]
        for fname in sorted(filenames):
            suffix = Path(fname).suffix.lower()
            if _is_skippable(fname.lower(), suffix):
                continue
            full = Path(dirpath) / fname
            try:
                size = full.stat().st_size
            except OSError:
                continue
            rel = full.relative_to(root).as_posix()
            inv.files.append(FileEntry(rel=rel, size=size, language=language_for(full)))
            inv.total_bytes += size
            if len(inv.files) >= cfg.max_index_files:
                inv.truncated = True
                return inv
    return inv


def _looks_binary(head: bytes) -> bool:
    return b"\x00" in head


@dataclass
class LoadedFile:
    rel: str
    text: str
    truncated: bool
    size: int


def read_files(cfg: DeepWikiConfig, rels: list[str]) -> list[LoadedFile]:
    """Read the named files, capped per file, skipping anything binary/missing.

    Paths are resolved under the workspace and refused if they escape it, so a
    model-proposed path of ``../../etc/passwd`` cannot read outside the repo.
    """
    out: list[LoadedFile] = []
    root = cfg.workspace.resolve()
    for rel in rels:
        rel = rel.strip().lstrip("/")
        if not rel:
            continue
        try:
            full = (root / rel).resolve()
            full.relative_to(root)  # raises if the path escaped the workspace
        except (ValueError, OSError):
            continue
        if not full.is_file():
            continue
        try:
            size = full.stat().st_size
            with full.open("rb") as fh:
                raw = fh.read(cfg.max_file_bytes + 1)
        except OSError:
            continue
        if _looks_binary(raw[:1024]):
            continue
        truncated = len(raw) > cfg.max_file_bytes
        body = raw[: cfg.max_file_bytes].decode("utf-8", errors="replace")
        out.append(
            LoadedFile(rel=full.relative_to(root).as_posix(), text=body,
                       truncated=truncated, size=size)
        )
    return out


def render_inventory(inv: Inventory, *, max_lines: int = 1500) -> str:
    """The inventory as a compact text tree for the outline prompt.

    Capped at `max_lines` paths so a very large repo still fits one prompt; the
    cap is stated in the output so the model knows the listing is partial.
    """
    lines = [f"{f.rel}  [{f.language}, {f.size}B]" for f in inv.files]
    header = [
        f"Repository inventory: {len(inv.files)} files, "
        f"{inv.total_bytes // 1024} KB of source.",
        "Languages: "
        + ", ".join(f"{lang} ({n})" for lang, n in list(inv.by_language().items())[:12]),
        "",
    ]
    if inv.truncated:
        header.insert(1, "(inventory truncated at the file cap; repo is larger)")
    if len(lines) > max_lines:
        shown = lines[:max_lines]
        shown.append(f"... and {len(lines) - max_lines} more files (listing capped)")
        lines = shown
    return "\n".join(header + lines)
