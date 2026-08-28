"""Confluence storage format (XHTML) to readable Markdown.

Storage format is XHTML with Confluence's own namespaces bolted on. A modest
page is 15-30 KB of markup for 2 KB of prose, and the markup is not incidental:
macros, layout cells and structured links carry content that is lost if you
naively strip tags, and carry noise that swamps the page if you do not.

Returning it raw is not an option - it is unreadable to a model and costs an
order of magnitude more context than the text it contains. Returning
``re.sub('<[^>]+>', '', html)`` is worse than it looks: it silently concatenates
table cells into run-on sentences, drops the code out of code macros (which
lives in CDATA), and turns a task list into an undifferentiated blob.

So this is a real converter, built on ``html.parser`` from the standard library.
Deliberately not lxml or BeautifulSoup: storage format in the wild is frequently
not well-formed XML (unescaped ampersands from old editors, unclosed ``<br>``),
a strict XML parser rejects those pages outright, and neither dependency earns
its weight for one conversion.

What is deliberately dropped: layout scaffolding (``ac:layout*``), macro
parameters that configure rendering rather than carry content, and empty
structural elements. What is deliberately kept: code bodies, link targets,
image filenames, task state, and table structure.
"""

from __future__ import annotations

import re
from html import unescape
from html.parser import HTMLParser

# Macros whose body is prose and should be inlined with a label. An "info" or
# "warning" panel carries real content; rendering it as a blockquote with its
# label keeps the emphasis the author intended.
_PANEL_MACROS = {
    "info": "INFO",
    "note": "NOTE",
    "warning": "WARNING",
    "tip": "TIP",
    "panel": "PANEL",
    "expand": "EXPAND",
}

# Macros that are pure layout or navigation. Their bodies are generated at
# render time and contain nothing an author wrote.
_SKIP_MACROS = {
    "toc",
    "children",
    "pagetree",
    "recently-updated",
    "contentbylabel",
    "livesearch",
    "gallery",
}

_BLOCK_TAGS = {
    "p", "div", "h1", "h2", "h3", "h4", "h5", "h6",
    "ul", "ol", "li", "table", "tr", "blockquote", "pre", "hr", "br",
}


class _StorageToMarkdown(HTMLParser):
    """Streaming converter. One pass, no tree built."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.out: list[str] = []

        self._list_stack: list[str] = []      # "ul" | "ol"
        self._ol_counters: list[int] = []
        self._in_code = False                  # inside ac:plain-text-body
        self._code_lang: str | None = None
        self._macro_stack: list[str] = []      # ac:name of open structured-macros
        self._param_name: str | None = None    # currently open ac:parameter
        self._pending_lang: str | None = None
        self._skip_depth = 0                   # inside a _SKIP_MACROS body
        self._table_row: list[str] = []
        self._cell: list[str] | None = None
        self._table_rows: list[tuple[list[str], bool]] = []
        self._in_table = 0
        self._header_row = False
        self._link_target: str | None = None
        self._link_text: list[str] | None = None
        self._task_state: str | None = None

    # ── helpers ────────────────────────────────────────────────────────────

    def _emit(self, text: str) -> None:
        if self._skip_depth:
            return
        if self._cell is not None:
            self._cell.append(text)
        elif self._link_text is not None:
            self._link_text.append(text)
        else:
            self.out.append(text)

    def _newline(self, count: int = 1) -> None:
        if self._skip_depth or self._cell is not None:
            return
        # Never open with blank lines, and never stack more than two.
        while self.out and self.out[-1] == "\n" and count > 0:
            existing = 0
            for chunk in reversed(self.out):
                if chunk != "\n":
                    break
                existing += 1
            if existing >= 2:
                return
            break
        self.out.extend("\n" * count)

    # ── tag handling ───────────────────────────────────────────────────────

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        a = {k.lower(): (v or "") for k, v in attrs}

        if tag == "ac:structured-macro":
            name = a.get("ac:name", "").lower()
            self._macro_stack.append(name)
            if name in _SKIP_MACROS:
                self._skip_depth += 1
            elif name in _PANEL_MACROS:
                self._newline(2)
                self._emit(f"> **{_PANEL_MACROS[name]}** ")
            return

        if tag == "ac:parameter":
            self._param_name = a.get("ac:name", "").lower()
            return

        if tag == "ac:plain-text-body":
            # The body of a code macro. Its content arrives as CDATA, which
            # html.parser surfaces through handle_data like ordinary text.
            self._in_code = True
            self._newline(2)
            self._emit(f"```{self._pending_lang or ''}\n")
            return

        if tag in ("ac:link", "ac:image"):
            self._link_target = None
            self._link_text = []
            return

        # Structured link/image targets carry their destination in attributes.
        if tag == "ri:page":
            self._link_target = a.get("ri:content-title") or self._link_target
            return
        if tag == "ri:attachment":
            self._link_target = a.get("ri:filename") or self._link_target
            return
        if tag == "ri:url":
            self._link_target = a.get("ri:value") or self._link_target
            return
        if tag == "ri:user":
            self._link_target = a.get("ri:username") or a.get("ri:userkey") or "user"
            return

        if tag == "ac:task-list":
            self._newline(2)
            return
        if tag == "ac:task":
            self._task_state = None
            return
        if tag == "ac:task-status":
            self._task_state = ""
            return

        if self._skip_depth:
            return

        if tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
            self._newline(2)
            self._emit("#" * int(tag[1]) + " ")
        elif tag == "p":
            self._newline(2)
        elif tag == "br":
            self._emit("\n")
        elif tag == "hr":
            self._newline(2)
            self._emit("---")
            self._newline(2)
        elif tag in ("ul", "ol"):
            nested = bool(self._list_stack)
            self._list_stack.append(tag)
            if tag == "ol":
                self._ol_counters.append(0)
            # A nested list emits nothing here: the <li> that follows emits its
            # own newline, and both together open a blank line mid-list.
            if not nested:
                self._newline(2)
        elif tag == "li":
            depth = max(0, len(self._list_stack) - 1)
            indent = "  " * depth
            if self._list_stack and self._list_stack[-1] == "ol":
                self._ol_counters[-1] += 1
                marker = f"{self._ol_counters[-1]}."
            else:
                marker = "-"
            self._newline()
            self._emit(f"{indent}{marker} ")
        elif tag in ("strong", "b"):
            self._emit("**")
        elif tag in ("em", "i"):
            self._emit("*")
        elif tag == "code":
            self._emit("`")
        elif tag == "pre":
            self._newline(2)
            self._emit("```\n")
        elif tag == "blockquote":
            self._newline(2)
            self._emit("> ")
        elif tag == "a":
            self._link_target = a.get("href")
            self._link_text = []
        elif tag == "table":
            self._in_table += 1
            self._table_rows = []
        elif tag == "tr":
            self._table_row = []
            self._header_row = False
        elif tag in ("td", "th"):
            self._cell = []
            if tag == "th":
                self._header_row = True

    def handle_endtag(self, tag: str) -> None:
        if tag == "ac:structured-macro":
            name = self._macro_stack.pop() if self._macro_stack else ""
            if name in _SKIP_MACROS:
                self._skip_depth = max(0, self._skip_depth - 1)
            elif name in _PANEL_MACROS:
                self._newline(2)
            self._pending_lang = None
            return

        if tag == "ac:parameter":
            self._param_name = None
            return

        if tag == "ac:plain-text-body":
            self._in_code = False
            self._emit("\n```")
            self._newline(2)
            return

        if tag in ("ac:link", "ac:image"):
            text = "".join(self._link_text or []).strip()
            target = (self._link_target or "").strip()
            self._link_text = None
            if tag == "ac:image":
                self._emit(f"[image: {target or 'attachment'}]")
            elif target:
                # An internal link's target is a page TITLE, not a URL. Saying
                # so stops a model treating it as a fetchable address.
                self._emit(f"[{text or target}](confluence page: {target})")
            elif text:
                self._emit(text)
            self._link_target = None
            return

        if tag == "ac:task":
            self._task_state = None
            return
        if tag == "ac:task-status":
            done = (self._task_state or "").strip().lower() == "complete"
            self._newline()
            self._emit(f"- [{'x' if done else ' '}] ")
            self._task_state = None
            return

        if self._skip_depth:
            return

        if tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
            self._newline(2)
        elif tag == "p":
            self._newline(2)
        elif tag in ("ul", "ol"):
            if self._list_stack:
                popped = self._list_stack.pop()
                if popped == "ol" and self._ol_counters:
                    self._ol_counters.pop()
            if not self._list_stack:
                self._newline(2)
        elif tag in ("strong", "b"):
            self._emit("**")
        elif tag in ("em", "i"):
            self._emit("*")
        elif tag == "code":
            self._emit("`")
        elif tag == "pre":
            self._emit("\n```")
            self._newline(2)
        elif tag == "blockquote":
            self._newline(2)
        elif tag == "a":
            text = "".join(self._link_text or []).strip()
            self._link_text = None
            target = self._link_target
            self._link_target = None
            if target and text:
                self._emit(f"[{text}]({target})")
            elif text:
                self._emit(text)
        elif tag in ("td", "th"):
            cell = " ".join("".join(self._cell or []).split())
            self._cell = None
            self._table_row.append(cell)
        elif tag == "tr":
            if self._table_row:
                self._table_rows.append((self._table_row, self._header_row))
            self._table_row = []
        elif tag == "table":
            self._in_table = max(0, self._in_table - 1)
            self._flush_table()

    def _flush_table(self) -> None:
        if not self._table_rows:
            return
        rows = self._table_rows
        self._table_rows = []
        width = max(len(r) for r, _ in rows)
        self._newline(2)
        first_is_header = rows[0][1]
        for idx, (cells, _) in enumerate(rows):
            padded = cells + [""] * (width - len(cells))
            # Escape pipes so a cell containing one cannot break the table.
            safe = [c.replace("|", "\\|") for c in padded]
            self.out.append("| " + " | ".join(safe) + " |\n")
            if idx == 0 and first_is_header:
                self.out.append("|" + "|".join([" --- "] * width) + "|\n")
        self._newline(1)

    def handle_data(self, data: str) -> None:
        if self._in_code:
            # Code is emitted verbatim - stripping or collapsing whitespace
            # here would destroy the indentation that makes it code.
            self._emit(data)
            return
        if self._param_name is not None:
            value = data.strip()
            if self._param_name in ("language", "lang") and value:
                self._pending_lang = value
            elif self._param_name == "title" and value:
                self._emit(f"**{value}** ")
            # Every other parameter configures rendering, not content.
            return
        if self._task_state is not None:
            self._task_state += data
            return
        if self._skip_depth:
            return
        if not data.strip():
            # Collapse inter-tag whitespace to a single space so words do not
            # run together across element boundaries.
            if self.out and not self.out[-1].endswith((" ", "\n")):
                self._emit(" ")
            return
        self._emit(re.sub(r"\s+", " ", data))

    # html.parser routes CDATA through handle_data only after this is set.
    def unknown_decl(self, data: str) -> None:
        if data.startswith("CDATA["):
            self._emit(data[6:])


def storage_to_markdown(storage: str) -> str:
    """Convert Confluence storage-format XHTML to Markdown.

    Never raises on malformed input: a page that fails to parse cleanly still
    returns whatever text was recovered, because a partial page is far more
    useful to a caller than an exception.
    """
    if not storage or not storage.strip():
        return ""
    parser = _StorageToMarkdown()
    try:
        parser.feed(storage)
        parser.close()
    except Exception:
        # Best effort: keep whatever was converted before the parser gave up.
        pass

    text = "".join(parser.out)
    text = unescape(text)
    text = _tidy_whitespace(text)
    return text.strip()


def _tidy_whitespace(text: str) -> str:
    """Collapse the blank-line noise the block handlers produce.

    Done line by line rather than with one global regex, because the two things
    that must survive are both leading whitespace: the indentation inside a
    fenced code block, and the indent that makes a nested list nested. A global
    ``[ \t]{2,} -> ' '`` destroys them, which is a silent corruption of the
    content rather than a formatting nit.
    """
    out: list[str] = []
    in_fence = False
    blank_run = 0

    for line in text.split("\n"):
        if line.lstrip().startswith("```"):
            in_fence = not in_fence
            out.append(line.rstrip())
            blank_run = 0
            continue

        if in_fence:
            # Verbatim. Not even trailing-space stripping: trailing whitespace
            # can be significant in the languages people paste here.
            out.append(line)
            continue

        stripped = line.strip()
        if not stripped:
            blank_run += 1
            if blank_run <= 1:
                out.append("")
            continue
        blank_run = 0
        # Preserve the leading indent, collapse only interior runs of spaces.
        indent = line[: len(line) - len(line.lstrip(" \t"))]
        out.append(indent + re.sub(r"[ \t]{2,}", " ", stripped))

    return "\n".join(out)


_TAG_RE = re.compile(r"<[^>]+>")


def html_excerpt(fragment: str, limit: int = 300) -> str:
    """Flatten a search-result excerpt to plain text.

    Confluence returns excerpts with ``@@@hl@@@``/``@@@endhl@@@`` highlight
    markers around matched terms. They are noise in a tool result, so they go.
    """
    if not fragment:
        return ""
    text = _TAG_RE.sub(" ", fragment)
    text = text.replace("@@@hl@@@", "").replace("@@@endhl@@@", "")
    text = unescape(text)
    text = re.sub(r"\s+", " ", text).strip()
    return text[: limit - 1] + "…" if len(text) > limit else text
