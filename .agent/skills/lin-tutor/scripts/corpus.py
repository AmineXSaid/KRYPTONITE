#!/usr/bin/env python3
"""
corpus.py - read big HTML files (course pages, Codebeamer exports) without
loading them into the model context.

Standard library only. No bs4, no lxml, no network. Works air-gapped.

Subcommands
-----------
  outline FILE                    list headings (level, number, id, size)
  section FILE "2.2"              print one section as plain text
  grep    FILE "regex"            search, print matches with heading breadcrumb
  tables  FILE [--match str]      dump <table> rows as pipe-separated text
  ids     FILE                    list all element ids (anchor targets)

Examples
--------
  python3 corpus.py outline docs/LIN-COURSE.html
  python3 corpus.py section docs/LIN-COURSE.html "2.3"
  python3 corpus.py grep    docs/*.html "checksum" -C 1
  python3 corpus.py tables  docs/cb_requirements.html --match LIN_576
"""

import argparse
import glob
import html
import os
import re
import sys
from html.parser import HTMLParser

SKIP_TAGS = {"script", "style", "svg", "noscript", "head", "template"}
BLOCK_TAGS = {
    "p", "div", "li", "td", "th", "tr", "section", "article", "figcaption",
    "blockquote", "pre", "dt", "dd", "h1", "h2", "h3", "h4", "h5", "h6",
    "caption", "summary", "details", "hr", "table",
}
HEAD_TAGS = {"h1": 1, "h2": 2, "h3": 3, "h4": 4, "h5": 5, "h6": 6}


class Doc(HTMLParser):
    """Flattens HTML into ordered blocks: (kind, level, text, elem_id)."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.blocks = []          # (kind, level, text, id)
        self.tables = []          # list of list-of-rows
        self._buf = []
        self._skip = 0
        self._head = None         # (level, id) while inside a heading
        self._tbl = None          # current table rows
        self._row = None
        self._cell = None

    # -- helpers ---------------------------------------------------------
    def _flush(self, kind="text", level=0, elem_id=""):
        txt = re.sub(r"\s+", " ", "".join(self._buf)).strip()
        self._buf = []
        if txt:
            self.blocks.append((kind, level, txt, elem_id))

    # -- parser callbacks ------------------------------------------------
    def handle_starttag(self, tag, attrs):
        if tag in SKIP_TAGS:
            self._skip += 1
            return
        if self._skip:
            return
        a = dict(attrs)
        if tag in HEAD_TAGS:
            self._flush()
            self._head = (HEAD_TAGS[tag], a.get("id", ""))
        elif tag == "table":
            self._flush()
            self._tbl = []
        elif tag == "tr" and self._tbl is not None:
            self._row = []
        elif tag in ("td", "th") and self._row is not None:
            self._cell = []
        elif tag == "br":
            (self._cell if self._cell is not None else self._buf).append(" ")
        elif tag in BLOCK_TAGS:
            self._flush()
        if a.get("id") and tag not in HEAD_TAGS:
            self.blocks.append(("anchor", 0, a["id"], a["id"]))

    def handle_endtag(self, tag):
        if tag in SKIP_TAGS:
            self._skip = max(0, self._skip - 1)
            return
        if self._skip:
            return
        if tag in HEAD_TAGS and self._head:
            lvl, hid = self._head
            self._flush("head", lvl, hid)
            self._head = None
        elif tag in ("td", "th") and self._cell is not None:
            cell = re.sub(r"\s+", " ", "".join(self._cell)).strip()
            if self._row is not None:
                self._row.append(cell)
            self._cell = None
            self._buf = []
        elif tag == "tr" and self._row is not None:
            if any(self._row):
                self._tbl.append(self._row)
            self._row = None
        elif tag == "table" and self._tbl is not None:
            if self._tbl:
                self.tables.append(self._tbl)
                n = len(self.tables)
                self.blocks.append(("table", 0, f"[table #{n} "
                                                f"- {len(self._tbl)} rows]", ""))
                for row in self._tbl:
                    self.blocks.append(("trow", n, " | ".join(row), ""))
            self._tbl = None
        elif tag in BLOCK_TAGS:
            self._flush()

    def handle_data(self, data):
        if self._skip:
            return
        if self._cell is not None:
            self._cell.append(data)
        else:
            self._buf.append(data)

    def close(self):
        super().close()
        self._flush()


def load(path):
    with open(path, encoding="utf-8", errors="replace") as fh:
        raw = fh.read()
    d = Doc()
    d.feed(raw)
    d.close()
    return d


def norm(s):
    return re.sub(r"\s+", " ", html.unescape(s)).strip()


# -- commands ------------------------------------------------------------
def cmd_outline(d, args):
    heads = [(i, b) for i, b in enumerate(d.blocks) if b[0] == "head"]
    for n, (i, (_, lvl, txt, hid)) in enumerate(heads):
        end = heads[n + 1][0] if n + 1 < len(heads) else len(d.blocks)
        words = sum(len(b[2].split()) for b in d.blocks[i:end]
                    if b[0] in ("text", "trow"))
        if lvl > args.depth:
            continue
        pad = "  " * (lvl - 1)
        anchor = f"  #{hid}" if hid else ""
        print(f"{pad}h{lvl} {txt[:90]}   ({words}w){anchor}")


def _section_range(d, needle):
    heads = [(i, b) for i, b in enumerate(d.blocks) if b[0] == "head"]
    nl = needle.lower()
    hit = None
    for n, (i, (_, lvl, txt, hid)) in enumerate(heads):
        if nl in txt.lower() or (hid and nl == hid.lower()):
            hit = (n, i, lvl, txt)
            break
    if hit is None:
        return None
    n, i, lvl, txt = hit
    end = len(d.blocks)
    for j, (k, (_, l2, _, _)) in enumerate(heads):
        if j > n and l2 <= lvl:
            end = k
            break
    return i, end, txt


def cmd_section(d, args):
    r = _section_range(d, args.query)
    if not r:
        print(f"[no section matching {args.query!r}]")
        return
    i, end, title = r
    print(f"SOURCE: {args._path} § {title}")
    out, size = [], 0
    for kind, lvl, txt, _ in d.blocks[i:end]:
        if kind == "head":
            out.append(("\n" + "#" * lvl + " " + txt) if out else ("#" * lvl + " " + txt))
        elif kind == "table":
            out.append(txt + "  (use: tables --match to dump)")
        elif kind == "text":
            out.append(txt)
        elif kind == "trow":
            continue
        size += len(out[-1]) if out else 0
        if size > args.max_chars:
            out.append(f"... [truncated at {args.max_chars} chars - "
                       f"narrow the query or raise --max-chars]")
            break
    print("\n".join(out))


def cmd_grep(d, args, path):
    try:
        rx = re.compile(args.pattern, 0 if args.case else re.I)
    except re.error as e:
        sys.exit(f"bad regex: {e}")
    crumb, hits = "", 0
    texts = [b for b in d.blocks if b[0] in ("head", "text", "trow")]
    for n, (kind, lvl, txt, _) in enumerate(texts):
        if kind == "head":
            crumb = f"{'#' * lvl} {txt}"
            continue
        if rx.search(txt):
            hits += 1
            where = f"{crumb}  [table #{lvl}]" if kind == "trow" else crumb
            print(f"\nSOURCE: {path} § {crumb.lstrip('# ')}"
                  + ("  [table]" if kind == "trow" else ""))
            lo = max(0, n - args.context)
            hi = min(len(texts), n + args.context + 1)
            for k in range(lo, hi):
                mark = ">" if k == n else " "
                print(f"{mark} {texts[k][2][:args.max_chars]}")
            if hits >= args.limit:
                print(f"\n[stopped at --limit {args.limit}]")
                return
    if not hits:
        print(f"[no match for {args.pattern!r} in {path}]")


def cmd_tables(d, args):
    for n, rows in enumerate(d.tables, 1):
        flat = " ".join(" ".join(r) for r in rows)
        if args.match and args.match.lower() not in flat.lower():
            continue
        print(f"\n=== table #{n}  ({len(rows)} rows)")
        for r in rows[: args.rows]:
            print(" | ".join(c[:80] for c in r))
        if len(rows) > args.rows:
            print(f"... [{len(rows) - args.rows} more rows, raise --rows]")


def cmd_ids(d, args):
    seen = []
    for kind, _, txt, hid in d.blocks:
        if hid and hid not in seen:
            seen.append(hid)
            print(f"#{hid}   {txt[:70] if kind == 'head' else ''}")


def cmd_schema(args):
    path = args.file or os.path.join(
        os.path.dirname(os.path.abspath(__file__)),
        "..", "references", "ascii-schemas.md")
    try:
        with open(path, encoding="utf-8") as fh:
            raw = fh.read()
    except OSError as e:
        sys.exit(f"cannot read schema library: {e}")

    parts = re.split(r"^## ", raw, flags=re.M)
    heads = [("## " + p).rstrip() for p in parts[1:]]

    if args.query in (None, "list"):
        print("Available templates - copy them exactly, fill from the corpus:\n")
        for h in heads:
            print("  " + h.splitlines()[0][3:])
        return

    q = args.query.lower()
    hit = [h for h in heads if q in h.splitlines()[0].lower()]
    if not hit:
        hit = [h for h in heads if q in h.lower()]
    if not hit:
        print(f"[no template matching {args.query!r} - run: schema list]")
        return
    for h in hit[: args.limit]:
        print(h + "\n")


def main():
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    o = sub.add_parser("outline", help="list headings")
    o.add_argument("files", nargs="+")
    o.add_argument("--depth", type=int, default=3)

    s = sub.add_parser("section", help="print one section as text")
    s.add_argument("files", nargs="+")
    s.add_argument("query", help="heading number, text fragment or #id")
    s.add_argument("--max-chars", type=int, default=6000)

    g = sub.add_parser("grep", help="regex search with breadcrumb")
    g.add_argument("files", nargs="+")
    g.add_argument("pattern")
    g.add_argument("-C", "--context", type=int, default=0)
    g.add_argument("--limit", type=int, default=12)
    g.add_argument("--case", action="store_true", help="case sensitive")
    g.add_argument("--max-chars", type=int, default=700)

    t = sub.add_parser("tables", help="dump tables")
    t.add_argument("files", nargs="+")
    t.add_argument("--match", help="only tables containing this string")
    t.add_argument("--rows", type=int, default=40)

    i = sub.add_parser("ids", help="list anchor ids")
    i.add_argument("files", nargs="+")

    sc = sub.add_parser("schema", help="print an ASCII diagram template")
    sc.add_argument("query", nargs="?", default="list",
                    help="template name fragment, or 'list'")
    sc.add_argument("--file", help="path to ascii-schemas.md")
    sc.add_argument("--limit", type=int, default=1)

    args = p.parse_args()

    if args.cmd == "schema":
        cmd_schema(args)
        return

    paths = []
    for f in args.files:
        paths.extend(sorted(glob.glob(f)) or [f])

    for path in paths:
        try:
            d = load(path)
        except OSError as e:
            print(f"[cannot read {path}: {e}]", file=sys.stderr)
            continue
        if len(paths) > 1 and args.cmd != "grep":
            print(f"\n########## {path}")
        args._path = path
        if args.cmd == "outline":
            cmd_outline(d, args)
        elif args.cmd == "section":
            cmd_section(d, args)
        elif args.cmd == "grep":
            cmd_grep(d, args, path)
        elif args.cmd == "tables":
            cmd_tables(d, args)
        elif args.cmd == "ids":
            cmd_ids(d, args)


if __name__ == "__main__":
    try:  # exit quietly when piped into head/less
        from signal import SIGPIPE, SIG_DFL, signal
        signal(SIGPIPE, SIG_DFL)
    except (ImportError, ValueError):
        pass
    main()
