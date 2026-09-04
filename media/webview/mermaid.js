/* A mermaid renderer, hand-rolled to stay small and work offline.
 *
 * The model writes ```mermaid blocks, and a non-multimodal model cannot draw a
 * picture - it can only emit the source. This turns that source into an SVG in
 * the transcript, so a diagram reads as a diagram rather than as a wall of
 * arrows nobody parses in their head.
 *
 * Deliberately NOT the mermaid library. Mermaid is ~2.8 MB minified and pulls a
 * layout engine and a parser generator with it; this extension bundles no such
 * thing and renders identically air-gapped, the same reason it drives the
 * browser over raw CDP and highlights code with its own tokenizer. So this is a
 * focused subset covering the diagram types that actually come up:
 *
 *   - `flowchart`/`graph`  - node shapes, labelled edges, `<br/>`, `subgraph`s,
 *                            laid out with a simple longest-path layering;
 *   - `sequenceDiagram`    - participants, the message arrows, activation bars,
 *                            notes, and loop/alt/opt/par fragments;
 *   - `stateDiagram[-v2]`  - states, the `[*]` start/end dot, composites;
 *   - `classDiagram`       - UML compartments and the relation markers;
 *   - `erDiagram`          - entities and crow's-foot cardinality;
 *   - `pie`                - slices with a legend.
 *
 * `render(source)` picks the renderer from the header. Anything it cannot parse
 * throws, and the caller falls back to showing the source as a code block, so an
 * unsupported diagram (a `gantt`, a half-streamed fence) is never worse than it
 * was before.
 *
 * Each SVG carries its own <style> and a ground rect, every rule written as
 * `var(--token, fallback)`, so a diagram tracks the panel theme in the webview
 * and still renders in full colour when the SVG is copied or saved with no
 * stylesheet around it.
 *
 * The one rule that must never bend: every label is UNTRUSTED model output, so
 * every character that reaches the SVG is XML-escaped. The renderer emits only
 * shape and text elements and never a <script>, so a diagram cannot carry code
 * into the transcript.
 *
 * Exposed as `window.KXMermaid.render(source)` for the webview and as a Node
 * module export for the test, the same dual shape crystal.js uses.
 */
(function (root) {
  "use strict";

  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /* The drawing carries its own stylesheet, so the SVG is a complete picture on
   * its own - copied out of the panel, saved to a file, or handed to the model
   * as an image, it keeps its colours instead of coming out as black shapes on
   * nothing. Every rule reads `var(--token, fallback)`: inside the webview the
   * theme tokens win, so a diagram tracks light/dark like the rest of the panel;
   * anywhere the tokens are absent, the solid fallbacks below - tuned to sit on
   * the dark ground rect - render a legible, coloured diagram all the same.
   *
   * The fallbacks are opaque because the real tokens are translucent whites that
   * only work over the panel; a standalone SVG has no panel behind it, so it
   * paints its own `.mm-bg` ground first. In the webview that ground resolves to
   * `--kx-mm-ground: transparent` (set in sidebar.css) so nothing changes on
   * screen; standalone it falls back to the dark ink. */
  var MONO = "var(--kx-mono, ui-monospace, Menlo, Consolas, monospace)";
  var MM_STYLE =
    "<style>" +
    ".mm-bg{fill:var(--kx-mm-ground,#1b1b1d)}" +
    ".mm-node{fill:var(--kx-surface-3,#333336);stroke:var(--kx-edge,#75757a);stroke-width:1}" +
    ".mm-node-line{stroke:var(--kx-edge,#75757a);stroke-width:1;fill:none}" +
    ".mm-text{fill:var(--kx-fg,#fbfafd);font-family:" + MONO + ";font-size:12px}" +
    ".mm-edge{stroke:var(--kx-line-2,#8a8a8e);stroke-width:1.5;fill:none}" +
    ".mm-edge.mm-dotted{stroke-dasharray:4 3}" +
    ".mm-edge.mm-thick{stroke-width:3}" +
    ".mm-arrow{fill:var(--kx-line-2,#8a8a8e)}" +
    ".mm-arrow-open{stroke:var(--kx-line-2,#8a8a8e);stroke-width:1.5;fill:none}" +
    ".mm-sub{fill:color-mix(in srgb, var(--kx-line,#4a4a4e) 6%, transparent);stroke:var(--kx-line,#4a4a4e);stroke-width:1;stroke-dasharray:5 3}" +
    ".mm-sub-title{fill:var(--kx-fg-2,#bcbbbf);font-family:" + MONO + ";font-size:11px;font-weight:700}" +
    ".mm-elabel-bg{fill:var(--kx-surface,#242426)}" +
    ".mm-elabel{fill:var(--kx-fg-2,#bcbbbf);font-family:" + MONO + ";font-size:11px}" +
    ".mm-lifeline{stroke:var(--kx-line,#4a4a4e);stroke-width:1;stroke-dasharray:3 3}" +
    ".mm-actor{fill:color-mix(in srgb, var(--kx-accent,#2ea562) 12%, var(--kx-surface-3,#333336))}" +
    ".mm-activation{fill:var(--kx-surface-3,#3f3f43);stroke:var(--kx-edge,#75757a);stroke-width:1}" +
    ".mm-msg{stroke:var(--kx-line-2,#8a8a8e);stroke-width:1.5;fill:none}" +
    ".mm-msg.mm-dotted{stroke-dasharray:4 3}" +
    ".mm-msg-x{stroke:var(--kx-line-2,#8a8a8e);stroke-width:1.5;fill:none}" +
    ".mm-msg-bg{fill:var(--kx-surface,#242426)}" +
    ".mm-msg-label{fill:var(--kx-fg,#fbfafd);font-family:" + MONO + ";font-size:11px}" +
    ".mm-note{fill:color-mix(in srgb, var(--kx-accent,#2ea562) 10%, var(--kx-surface,#242426));stroke:var(--kx-edge,#75757a);stroke-width:1}" +
    ".mm-note-text{fill:var(--kx-fg,#fbfafd);font-family:" + MONO + ";font-size:11px}" +
    ".mm-frag{fill:none;stroke:var(--kx-line,#4a4a4e);stroke-width:1}" +
    ".mm-frag-tab{fill:color-mix(in srgb, var(--kx-line,#4a4a4e) 14%, transparent);stroke:var(--kx-line,#4a4a4e);stroke-width:1}" +
    ".mm-frag-kind{fill:var(--kx-fg-2,#bcbbbf);font-family:" + MONO + ";font-size:10px;font-weight:700}" +
    ".mm-frag-label{fill:var(--kx-fg-2,#bcbbbf);font-family:" + MONO + ";font-size:10px}" +
    ".mm-frag-div{stroke:var(--kx-line,#4a4a4e);stroke-width:1;stroke-dasharray:4 3}" +
    ".mm-startend{fill:var(--kx-fg,#fbfafd);stroke:var(--kx-fg,#fbfafd)}" +
    ".mm-class-name{font-weight:700}" +
    ".mm-member{fill:var(--kx-fg-2,#bcbbbf);font-family:" + MONO + ";font-size:11px}" +
    ".mm-uml-hollow{fill:var(--kx-mm-ground,#1b1b1d);stroke:var(--kx-line-2,#8a8a8e);stroke-width:1}" +
    ".mm-uml-fill{fill:var(--kx-line-2,#8a8a8e);stroke:var(--kx-line-2,#8a8a8e)}" +
    ".mm-er-mark{stroke:var(--kx-line-2,#8a8a8e);stroke-width:1.5;fill:none}" +
    ".mm-slice{stroke:var(--kx-mm-ground,#1b1b1d);stroke-width:2}" +
    ".mm-pie-title{fill:var(--kx-fg,#fbfafd);font-family:" + MONO + ";font-size:13px;font-weight:700}" +
    ".mm-pie-pct{fill:#0d0d0f;font-family:" + MONO + ";font-size:11px;font-weight:600}" +
    ".mm-legend{fill:var(--kx-fg,#fbfafd);font-family:" + MONO + ";font-size:11px}" +
    "</style>";
  var MM_DEFS =
    '<defs>' +
    '<marker id="mm-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="mm-arrow" d="M0,0 L10,5 L0,10 z"/></marker>' +
    '<marker id="mm-open" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path class="mm-arrow-open" d="M0,0 L9,5 L0,10" fill="none"/></marker>' +
    '<marker id="mm-tri" viewBox="0 0 14 12" refX="13" refY="6" markerWidth="14" markerHeight="12" orient="auto-start-reverse"><path class="mm-uml-hollow" d="M0,0 L13,6 L0,12 z"/></marker>' +
    '<marker id="mm-diamond" viewBox="0 0 16 10" refX="15" refY="5" markerWidth="16" markerHeight="10" orient="auto-start-reverse"><path class="mm-uml-fill" d="M0,5 L8,0 L16,5 L8,10 z"/></marker>' +
    '<marker id="mm-odiamond" viewBox="0 0 16 10" refX="15" refY="5" markerWidth="16" markerHeight="10" orient="auto-start-reverse"><path class="mm-uml-hollow" d="M0,5 L8,0 L16,5 L8,10 z"/></marker>' +
    '</defs>';

  /* The opening of every diagram: the sized <svg>, its embedded stylesheet, the
     shared arrow markers, and the ground rect the fallbacks paint onto. */
  function svgOpen(W, H) {
    var w = Math.ceil(W), h = Math.ceil(H);
    return '<svg class="mm-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + w + ' ' + h +
      '" width="' + w + '" height="' + h + '" role="img">' +
      MM_STYLE + MM_DEFS +
      '<rect class="mm-bg" x="0" y="0" width="' + w + '" height="' + h + '"/>';
  }

  function stripQuotes(s) {
    var t = String(s == null ? "" : s).trim();
    if (t.length >= 2 && t[0] === '"' && t[t.length - 1] === '"') t = t.slice(1, -1);
    return t.trim();
  }

  /* `<br>` in a label is a line break the author asked for; everything else is
     text. Split on it first, then each line is escaped where it is drawn. */
  function splitLabel(s) {
    return stripQuotes(s)
      .split(/<br\s*\/?>/i)
      .map(function (l) { return l.trim(); })
      .filter(function (l, i, a) { return l.length > 0 || a.length === 1; });
  }

  var DIRS = { TD: "TB", TB: "TB", BT: "BT", LR: "LR", RL: "RL" };

  /* The bracket pairs mermaid uses for node shapes, longest opener first so
     `[[` is tried before `[` and `((` before `(`. */
  var SHAPES = [
    ["([", "])", "stadium"],
    ["[[", "]]", "subroutine"],
    ["[(", ")]", "cylinder"],
    ["((", "))", "circle"],
    ["{{", "}}", "hexagon"],
    ["[", "]", "rect"],
    ["(", ")", "round"],
    ["{", "}", "diamond"],
    [">", "]", "odd"],
  ];

  function matchShape(str) {
    for (var k = 0; k < SHAPES.length; k++) {
      var open = SHAPES[k][0], close = SHAPES[k][1];
      if (str.slice(0, open.length) === open) {
        var end = str.indexOf(close, open.length);
        if (end === -1) continue;
        return {
          shape: SHAPES[k][2],
          label: str.slice(open.length, end),
          len: end + close.length,
        };
      }
    }
    return null;
  }

  function readTerm(s, i) {
    while (i < s.length && s[i] === " ") i++;
    var m = /^[A-Za-z0-9_]+/.exec(s.slice(i));
    if (!m) return null;
    var id = m[0];
    var j = i + id.length;
    var shape = null, label = null;
    var sh = matchShape(s.slice(j));
    if (sh) { shape = sh.shape; label = sh.label; j += sh.len; }
    return { id: id, shape: shape, label: label, end: j };
  }

  /* An edge, with an optional inline or piped label. The dotted/thick/solid
     variants are each tried with an inline label first, then bare. */
  function readConn(s, i) {
    var r = s.slice(i);
    var m, type = "solid", arrow = true, label = null, len = 0;
    if ((m = /^\s*-\.\s*([^.]*?)\s*\.->/.exec(r))) { type = "dotted"; label = m[1]; len = m[0].length; }
    else if ((m = /^\s*-\.->/.exec(r))) { type = "dotted"; len = m[0].length; }
    else if ((m = /^\s*==+\s*([^=>][^=]*?)\s*==+>/.exec(r))) { type = "thick"; label = m[1]; len = m[0].length; }
    else if ((m = /^\s*==+>/.exec(r))) { type = "thick"; len = m[0].length; }
    else if ((m = /^\s*--+\s*([^->|][^-]*?)\s*--+>/.exec(r))) { type = "solid"; label = m[1]; len = m[0].length; }
    else if ((m = /^\s*<-->/.exec(r))) { type = "solid"; arrow = "both"; len = m[0].length; }
    else if ((m = /^\s*--+>/.exec(r))) { type = "solid"; len = m[0].length; }
    else if ((m = /^\s*--+/.exec(r))) { type = "solid"; arrow = false; len = m[0].length; }
    else return null;
    var lm = /^\s*\|([^|]*)\|/.exec(s.slice(i + len));
    if (lm) { label = lm[1]; len += lm[0].length; }
    return { type: type, arrow: arrow, label: label != null ? stripQuotes(label) : null, len: len };
  }

  function parse(src) {
    var lines = String(src).replace(/\r/g, "").split("\n");
    var dir = "TB", start = -1;
    for (var h = 0; h < lines.length; h++) {
      var t = lines[h].trim();
      if (!t || t.indexOf("%%") === 0) continue;
      var hm = t.match(/^(?:flowchart|graph)\s+([A-Za-z]{2})\b/i);
      if (!hm) throw new Error("not a flowchart");
      dir = DIRS[hm[1].toUpperCase()] || "TB";
      start = h + 1;
      break;
    }
    if (start === -1) throw new Error("no flowchart header");

    var nodes = {}, order = [], edges = [], subgraphs = [], sgStack = [];

    function ensureNode(term) {
      var id = term.id;
      if (!nodes[id]) { nodes[id] = { id: id, shape: "rect", lines: [id] }; order.push(id); }
      var n = nodes[id];
      if (term.label != null) { n.lines = splitLabel(term.label); n.shape = term.shape || n.shape; }
      else if (term.shape) n.shape = term.shape;
      if (sgStack.length) sgStack[sgStack.length - 1].members[id] = true;
      return n;
    }

    var stmts = [];
    for (var i = start; i < lines.length; i++) {
      var raw = lines[i];
      var ci = raw.indexOf("%%");
      if (ci >= 0) raw = raw.slice(0, ci);
      raw.split(";").forEach(function (p) { var s = p.trim(); if (s) stmts.push(s); });
    }

    for (var si = 0; si < stmts.length; si++) {
      var s = stmts[si];
      var mSub = s.match(/^subgraph\b\s*(.*)$/i);
      if (mSub) {
        var rest = mSub[1].trim();
        var sg = { title: "", members: {} };
        var idm = /^[A-Za-z0-9_]+/.exec(rest);
        var sh = idm ? matchShape(rest.slice(idm[0].length).trim()) : null;
        sg.title = sh ? splitLabel(sh.label).join(" ") : stripQuotes(rest);
        subgraphs.push(sg); sgStack.push(sg);
        continue;
      }
      if (/^end$/i.test(s)) { sgStack.pop(); continue; }
      if (/^direction\b/i.test(s)) continue;

      var prev = readTerm(s, 0);
      if (!prev) continue;
      ensureNode(prev);
      var pos = prev.end;
      for (;;) {
        var conn = readConn(s, pos);
        if (!conn) break;
        pos += conn.len;
        var next = readTerm(s, pos);
        if (!next) break;
        ensureNode(next);
        edges.push({ from: prev.id, to: next.id, label: conn.label, type: conn.type, arrow: conn.arrow });
        prev = next;
        pos = next.end;
      }
    }

    return { dir: dir, nodes: nodes, order: order, edges: edges, subgraphs: subgraphs };
  }

  var NODE_H = 42, CHAR = 7.4, PADX = 26, MINW = 56, LINEH = 16, GAP_MAIN = 52, GAP_CROSS = 34;

  /* `sizeHint` (optional) is a map id -> {w,h} of exact box sizes. Class and ER
     diagrams pass it so the layerer packs columns by the real box widths rather
     than guessing from a label the box does not actually lay out as text. */
  function layout(g, sizeHint) {
    var ids = g.order, horizontal = g.dir === "LR" || g.dir === "RL";

    // Longest-path layering: rank a node one past the deepest thing pointing at
    // it. Bounded to |V| passes so a cycle terminates instead of looping.
    var rank = {};
    ids.forEach(function (id) { rank[id] = 0; });
    for (var pass = 0; pass < ids.length; pass++) {
      var changed = false;
      for (var e = 0; e < g.edges.length; e++) {
        var ed = g.edges[e];
        if (rank[ed.to] < rank[ed.from] + 1) { rank[ed.to] = rank[ed.from] + 1; changed = true; }
      }
      if (!changed) break;
    }

    var size = {};
    ids.forEach(function (id) {
      var n = g.nodes[id], maxLine = 0;
      if (sizeHint && sizeHint[id]) { size[id] = { w: sizeHint[id].w, h: sizeHint[id].h }; return; }
      // The start/end pseudostate is a fixed small dot, not a labelled box.
      if (n.shape === "startend") { size[id] = { w: 20, h: 20 }; return; }
      n.lines.forEach(function (l) { maxLine = Math.max(maxLine, l.length); });
      var w = Math.max(MINW, Math.round(maxLine * CHAR) + PADX);
      var ht = Math.max(NODE_H, 12 + n.lines.length * LINEH);
      // A diamond and a circle only offer their full width along the centre
      // line and taper to a point at the corners, so a box sized as though it
      // were a rectangle puts the label across the edge. Both are widened until
      // the text sits inside the shape rather than through it.
      if (n.shape === "diamond") {
        w = Math.max(Math.round(w * 1.6), ht * 2);
        ht = ht + 10;
      } else if (n.shape === "circle") {
        w = Math.max(Math.round(w * 1.25), ht);
        ht = Math.max(ht, Math.round(w * 0.72));
      }
      size[id] = { w: w, h: ht };
    });

    var layers = [];
    ids.forEach(function (id) { (layers[rank[id]] = layers[rank[id]] || []).push(id); });

    // Main axis: one coordinate per layer, spaced by the thickest node in it.
    var layerMain = [], acc = 24;
    for (var r = 0; r < layers.length; r++) {
      var thick = 0;
      (layers[r] || []).forEach(function (id) { thick = Math.max(thick, horizontal ? size[id].w : size[id].h); });
      layerMain[r] = acc + thick / 2;
      acc += thick + GAP_MAIN;
    }

    // Cross axis: pack each layer, then centre every layer on the widest one so
    // the diagram is balanced rather than left-piled.
    var layerCross = [], crossMax = 0;
    for (var r2 = 0; r2 < layers.length; r2++) {
      var c = 0, list = [];
      (layers[r2] || []).forEach(function (id) {
        var cs = horizontal ? size[id].h : size[id].w;
        list.push({ id: id, c: c + cs / 2 });
        c += cs + GAP_CROSS;
      });
      layerCross[r2] = { list: list, width: Math.max(0, c - GAP_CROSS) };
      crossMax = Math.max(crossMax, layerCross[r2].width);
    }

    var pos = {};
    for (var r3 = 0; r3 < layers.length; r3++) {
      var off = 24 + (crossMax - layerCross[r3].width) / 2;
      layerCross[r3].list.forEach(function (it) {
        var mainC = layerMain[r3], crossC = it.c + off;
        pos[it.id] = horizontal
          ? { x: mainC, y: crossC, w: size[it.id].w, h: size[it.id].h }
          : { x: crossC, y: mainC, w: size[it.id].w, h: size[it.id].h };
      });
    }

    var mainTotal = acc;
    if (g.dir === "BT" || g.dir === "RL") {
      ids.forEach(function (id) {
        if (g.dir === "BT") pos[id].y = mainTotal - pos[id].y;
        else pos[id].x = mainTotal - pos[id].x;
      });
    }
    return { pos: pos, size: size };
  }

  /* Where a line leaving `p` toward (tx,ty) crosses p's box, so an arrow lands
     on the border rather than under the node. */
  function border(p, tx, ty) {
    var dx = tx - p.x, dy = ty - p.y;
    if (dx === 0 && dy === 0) return { x: p.x, y: p.y };
    var hw = p.w / 2, hh = p.h / 2;
    var sx = dx === 0 ? Infinity : hw / Math.abs(dx);
    var sy = dy === 0 ? Infinity : hh / Math.abs(dy);
    var s = Math.min(sx, sy);
    return { x: p.x + dx * s, y: p.y + dy * s };
  }

  function shapeSvg(n, p) {
    var x = p.x - p.w / 2, y = p.y - p.h / 2, w = p.w, h = p.h, cls = ' class="mm-node"';
    switch (n.shape) {
      case "startend":
        return '<circle class="mm-startend" cx="' + p.x + '" cy="' + p.y + '" r="' + (Math.min(w, h) / 2) + '"/>';
      case "round":
      case "stadium":
        return '<rect' + cls + ' x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="' + (h / 2) + '" ry="' + (h / 2) + '"/>';
      case "circle":
        return '<ellipse' + cls + ' cx="' + p.x + '" cy="' + p.y + '" rx="' + (w / 2) + '" ry="' + (h / 2) + '"/>';
      case "diamond":
        return '<polygon' + cls + ' points="' + p.x + ',' + y + ' ' + (x + w) + ',' + p.y + ' ' + p.x + ',' + (y + h) + ' ' + x + ',' + p.y + '"/>';
      case "hexagon": {
        var inset = Math.min(16, w / 4);
        return '<polygon' + cls + ' points="' +
          (x + inset) + ',' + y + ' ' + (x + w - inset) + ',' + y + ' ' + (x + w) + ',' + p.y + ' ' +
          (x + w - inset) + ',' + (y + h) + ' ' + (x + inset) + ',' + (y + h) + ' ' + x + ',' + p.y + '"/>';
      }
      case "subroutine":
        return '<rect' + cls + ' x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="2"/>' +
          '<line class="mm-node-line" x1="' + (x + 6) + '" y1="' + y + '" x2="' + (x + 6) + '" y2="' + (y + h) + '"/>' +
          '<line class="mm-node-line" x1="' + (x + w - 6) + '" y1="' + y + '" x2="' + (x + w - 6) + '" y2="' + (y + h) + '"/>';
      case "cylinder": {
        var ry = 6;
        return '<path' + cls + ' d="M' + x + ',' + (y + ry) + ' A' + (w / 2) + ',' + ry + ' 0 0 1 ' + (x + w) + ',' + (y + ry) +
          ' L' + (x + w) + ',' + (y + h - ry) + ' A' + (w / 2) + ',' + ry + ' 0 0 1 ' + x + ',' + (y + h - ry) + ' Z"/>' +
          '<path class="mm-node-line" fill="none" d="M' + x + ',' + (y + ry) + ' A' + (w / 2) + ',' + ry + ' 0 0 0 ' + (x + w) + ',' + (y + ry) + '"/>';
      }
      default:
        return '<rect' + cls + ' x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="4" ry="4"/>';
    }
  }

  function textSvg(n, p) {
    var lines = n.lines.length ? n.lines : [n.id];
    var startY = p.y - ((lines.length - 1) * LINEH) / 2;
    var out = '<text class="mm-text" x="' + p.x + '" y="' + startY + '" text-anchor="middle" dominant-baseline="central">';
    for (var i = 0; i < lines.length; i++) {
      out += '<tspan x="' + p.x + '" dy="' + (i === 0 ? 0 : LINEH) + '">' + esc(lines[i]) + '</tspan>';
    }
    return out + "</text>";
  }

  /* Lay out and draw a parsed node/edge graph. Shared by flowcharts and state
     diagrams, which differ only in how they read the source into this shape. */
  function drawGraph(g) {
    var n = g.order.length;
    if (!n) throw new Error("no nodes in diagram");
    if (n > 80 || g.edges.length > 160) throw new Error("diagram too large to render inline");

    var L = layout(g);
    var pos = L.pos;

    // Subgraph boxes: the bounding box of their members plus room for a title.
    var boxes = [];
    for (var b = 0; b < g.subgraphs.length; b++) {
      var sg = g.subgraphs[b];
      var mem = Object.keys(sg.members).filter(function (id) { return pos[id]; });
      if (!mem.length) continue;
      var minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
      mem.forEach(function (id) {
        var p = pos[id];
        minx = Math.min(minx, p.x - p.w / 2); miny = Math.min(miny, p.y - p.h / 2);
        maxx = Math.max(maxx, p.x + p.w / 2); maxy = Math.max(maxy, p.y + p.h / 2);
      });
      boxes.push({ title: sg.title, x: minx - 14, y: miny - 30, w: (maxx - minx) + 28, h: (maxy - miny) + 44 });
    }

    // Shift everything positive: a subgraph title can push above the topmost
    // node, and negative coordinates would clip in the viewBox.
    var minX = 0, minY = 0;
    boxes.forEach(function (bx) { minX = Math.min(minX, bx.x); minY = Math.min(minY, bx.y); });
    var ox = minX < 8 ? 8 - minX : 0, oy = minY < 8 ? 8 - minY : 0;
    if (ox || oy) {
      g.order.forEach(function (id) { pos[id].x += ox; pos[id].y += oy; });
      boxes.forEach(function (bx) { bx.x += ox; bx.y += oy; });
    }

    var W = 0, H = 0;
    g.order.forEach(function (id) { var p = pos[id]; W = Math.max(W, p.x + p.w / 2); H = Math.max(H, p.y + p.h / 2); });
    boxes.forEach(function (bx) { W = Math.max(W, bx.x + bx.w); H = Math.max(H, bx.y + bx.h); });
    W += 16; H += 16;

    var svg = svgOpen(W, H);

    // Subgraph frames first, behind the nodes they enclose.
    for (var bi = 0; bi < boxes.length; bi++) {
      var box = boxes[bi];
      svg += '<rect class="mm-sub" x="' + box.x + '" y="' + box.y + '" width="' + box.w + '" height="' + box.h + '" rx="6"/>';
      if (box.title) {
        svg += '<text class="mm-sub-title" x="' + (box.x + 10) + '" y="' + (box.y + 16) + '">' + esc(box.title) + "</text>";
      }
    }

    // Edges under the nodes, so an arrow tucks beneath the box it points at.
    for (var ei = 0; ei < g.edges.length; ei++) {
      var ed = g.edges[ei], a = pos[ed.from], z = pos[ed.to];
      if (!a || !z) continue;
      var p1 = border(a, z.x, z.y), p2 = border(z, a.x, a.y);
      var cls = "mm-edge mm-" + ed.type;
      var marker = ' marker-end="url(#mm-arrow)"' + (ed.arrow === "both" ? ' marker-start="url(#mm-arrow)"' : "");
      if (ed.arrow === false) marker = "";
      svg += '<line class="' + cls + '" x1="' + p1.x + '" y1="' + p1.y + '" x2="' + p2.x + '" y2="' + p2.y + '"' + marker + "/>";
      if (ed.label) {
        var mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
        var lw = ed.label.length * 6.6 + 8;
        svg += '<rect class="mm-elabel-bg" x="' + (mx - lw / 2) + '" y="' + (my - 9) + '" width="' + lw + '" height="18" rx="3"/>';
        svg += '<text class="mm-elabel" x="' + mx + '" y="' + my + '" text-anchor="middle" dominant-baseline="central">' + esc(ed.label) + "</text>";
      }
    }

    for (var ni = 0; ni < g.order.length; ni++) {
      var id = g.order[ni], node = g.nodes[id], p = pos[id];
      svg += shapeSvg(node, p) + (node.shape === "startend" ? "" : textSvg(node, p));
    }

    return svg + "</svg>";
  }

  function renderFlowchart(src) { return drawGraph(parse(src)); }

  /* ─────────────────────────── state diagrams ───────────────────────────
   *
   * stateDiagram / stateDiagram-v2. States are rounded boxes, `[*]` is the
   * start/end pseudostate (a small filled dot), transitions are `A --> B : ev`,
   * and `state Name { ... }` nests as a composite - all of which map onto the
   * same node/edge graph the flowchart draws, so this only parses. */
  function parseState(src) {
    var lines = String(src).replace(/\r/g, "").split("\n");
    var nodes = {}, order = [], edges = [], subgraphs = [], sgStack = [];
    var startN = 0, endN = 0;

    function ensure(id, shape) {
      if (!nodes[id]) { nodes[id] = { id: id, shape: shape || "round", lines: [id] }; order.push(id); }
      if (sgStack.length) sgStack[sgStack.length - 1].members[id] = true;
      return nodes[id];
    }
    // `[*]` is a pseudostate; give each occurrence a fresh dot so a start and an
    // end do not collapse into one node.
    function star(where) {
      var id = "__" + where + "_" + (where === "start" ? ++startN : ++endN);
      nodes[id] = { id: id, shape: "startend", lines: [] }; order.push(id);
      if (sgStack.length) sgStack[sgStack.length - 1].members[id] = true;
      return id;
    }
    function term(tok) { return tok === "[*]" ? star : null; }

    var start = -1;
    for (var h = 0; h < lines.length; h++) {
      var t0 = lines[h].trim();
      if (!t0 || t0.indexOf("%%") === 0) continue;
      if (!/^stateDiagram(-v2)?\b/i.test(t0)) throw new Error("not a state diagram");
      start = h + 1; break;
    }
    if (start === -1) throw new Error("no stateDiagram header");

    // Pending end-dot ids to attach when a transition targets `[*]`.
    for (var i = start; i < lines.length; i++) {
      var raw = lines[i];
      var ci = raw.indexOf("%%"); if (ci >= 0) raw = raw.slice(0, ci);
      var s = raw.trim();
      if (!s) continue;
      var m;

      if ((m = /^state\s+"([^"]*)"\s+as\s+([A-Za-z0-9_]+)\s*$/i.exec(s))) {
        ensure(m[2]).lines = splitLabel(m[1]); continue;
      }
      if ((m = /^state\s+([A-Za-z0-9_]+)\s*\{$/i.exec(s)) || (m = /^state\s+"([^"]*)"\s+as\s+([A-Za-z0-9_]+)\s*\{$/i.exec(s))) {
        var sid = m[m.length - 1], sg = { title: m.length > 2 ? m[1] : sid, members: {} };
        ensure(sid); subgraphs.push(sg); sgStack.push(sg); continue;
      }
      if ((m = /^state\s+([A-Za-z0-9_]+)\s*$/i.exec(s))) { ensure(m[1]); continue; }
      if (/^\}$/.test(s)) { sgStack.pop(); continue; }
      if (/^(direction|note)\b/i.test(s)) continue;

      // A transition, with an optional `: label`.
      m = /^(\[\*\]|[A-Za-z0-9_]+)\s*-->\s*(\[\*\]|[A-Za-z0-9_]+)\s*(?::\s*(.*))?$/.exec(s);
      if (m) {
        var from = m[1] === "[*]" ? star("start") : ensure(m[1]).id;
        var to = m[2] === "[*]" ? star("end") : ensure(m[2]).id;
        edges.push({ from: from, to: to, label: m[3] != null ? stripQuotes(m[3]) : null, type: "solid", arrow: true });
        continue;
      }
      // `State : description` sets or extends the label.
      if ((m = /^([A-Za-z0-9_]+)\s*:\s*(.*)$/.exec(s))) { ensure(m[1]).lines = splitLabel(m[2]); continue; }
    }

    return { dir: "TB", nodes: nodes, order: order, edges: edges, subgraphs: subgraphs };
  }

  function renderState(src) { return drawGraph(parseState(src)); }

  /* ───────────────────────── sequence diagrams ─────────────────────────
   *
   * A second grammar, the same deal as the flowchart above: a hand-rolled
   * subset, no library, every label XML-escaped, and a throw on anything it
   * cannot parse so the caller falls back to the source. Time runs downward;
   * participants are columns with a lifeline each. Supported: participant/actor
   * (with `as` aliases), the message arrows (`->`, `-->`, `->>`, `-->>`, `-x`,
   * `--x`, `-)`, `--)`), activation bars (explicit and the `+`/`-` shorthand),
   * notes (left of / right of / over one or two participants), the ordering
   * fragments (loop / alt+else / opt / par+and / break / critical), and
   * autonumber. */

  var SEQ = {
    PBOX_H: 32, LINEH: 16, CH: 7.4, PADX: 26, MINW: 64,
    MARGIN: 16, TOP: 8, HEAD_GAP: 26, MSG_GAP: 40,
    ACT_W: 10, ACT_SHIFT: 4, SELF_W: 46, SELF_H: 30,
    FRAG_TOP: 30, FRAG_ALT: 24, FRAG_BOTTOM: 12, NOTE_PAD: 8,
  };

  /* The message connectors, longest first so `-->>` wins over `->>`. Two
     leading dashes mean a dotted line; the tail picks the head. */
  var SEQ_ARROWS = [
    ["-->>", true, "arrow"], ["->>", false, "arrow"],
    ["--x", true, "cross"], ["-x", false, "cross"],
    ["--)", true, "open"], ["-)", false, "open"],
    ["-->", true, "none"], ["->", false, "none"],
  ];

  function parseSequence(src) {
    var lines = String(src).replace(/\r/g, "").split("\n");
    var parts = [], index = {}, events = [], autonumber = false, title = "";

    function reg(id, label, actor) {
      if (index[id] == null) {
        index[id] = parts.length;
        parts.push({ id: id, label: label != null ? label : id, actor: !!actor });
      } else {
        var p = parts[index[id]];
        if (label != null) p.label = label;
        if (actor) p.actor = true;
      }
      return index[id];
    }

    var start = -1;
    for (var h = 0; h < lines.length; h++) {
      var t0 = lines[h].trim();
      if (!t0 || t0.indexOf("%%") === 0) continue;
      if (!/^sequenceDiagram\b/i.test(t0)) throw new Error("not a sequence diagram");
      start = h + 1; break;
    }
    if (start === -1) throw new Error("no sequenceDiagram header");

    for (var i = start; i < lines.length; i++) {
      var raw = lines[i];
      var ci = raw.indexOf("%%");
      if (ci >= 0) raw = raw.slice(0, ci);
      var s = raw.trim();
      if (!s) continue;
      var m;

      if (/^autonumber\b/i.test(s)) { autonumber = true; continue; }
      if ((m = /^title\s*:?\s*(.+)$/i.exec(s))) { title = stripQuotes(m[1]); continue; }

      if ((m = /^(participant|actor)\s+(.+)$/i.exec(s))) {
        var isActor = /^actor$/i.test(m[1]);
        var body = m[2].trim(), am = /^(.+?)\s+as\s+(.+)$/i.exec(body);
        if (am) reg(am[1].trim(), stripQuotes(am[2]), isActor);
        else reg(body, null, isActor);
        continue;
      }

      if ((m = /^note\s+(left of|right of|over)\s+(.+?)\s*:\s*([\s\S]*)$/i.exec(s))) {
        var pos = m[1].toLowerCase().replace(/\s*of$/, "");
        var ids = m[2].split(",").map(function (x) { return x.trim(); }).filter(Boolean);
        ids.forEach(function (id) { reg(id, null); });
        events.push({ t: "note", pos: pos, ids: ids, lines: splitLabel(m[3]) });
        continue;
      }

      if ((m = /^(de)?activate\s+([A-Za-z0-9_]+)/i.exec(s))) {
        reg(m[2], null);
        events.push({ t: m[1] ? "deactivate" : "activate", id: m[2] });
        continue;
      }

      if ((m = /^(loop|opt|alt|par|break|critical|rect)\b\s*(.*)$/i.exec(s))) {
        events.push({ t: "frag", kind: m[1].toLowerCase(), label: stripQuotes(m[2] || "") });
        continue;
      }
      if ((m = /^(else|and|option)\b\s*(.*)$/i.exec(s))) {
        events.push({ t: "fragAlt", label: stripQuotes(m[2] || "") });
        continue;
      }
      if (/^end\b/i.test(s)) { events.push({ t: "fragEnd" }); continue; }

      // A message: id, connector, optional +/- activation marker, id, : label.
      var mm = /^([A-Za-z0-9_]+)\s*(-->>|->>|--x|-x|--\)|-\)|-->|->)\s*([+-])?\s*([A-Za-z0-9_]+)\s*(?::\s*([\s\S]*))?$/.exec(s);
      if (mm) {
        var conn = mm[2], spec = null;
        for (var k = 0; k < SEQ_ARROWS.length; k++) {
          if (SEQ_ARROWS[k][0] === conn) { spec = SEQ_ARROWS[k]; break; }
        }
        reg(mm[1], null); reg(mm[4], null);
        events.push({
          t: "msg", from: mm[1], to: mm[4],
          dotted: spec[1], head: spec[2], act: mm[3] || "",
          label: mm[5] != null ? stripQuotes(mm[5]) : "",
        });
        continue;
      }
      // Anything unrecognised is skipped rather than fatal, so one odd line
      // does not drop the whole diagram back to source.
    }

    return { parts: parts, index: index, events: events, autonumber: autonumber, title: title };
  }

  function renderSequence(src) {
    var doc = parseSequence(src), P = doc.parts, K = SEQ;
    if (!P.length) throw new Error("no participants in diagram");
    if (P.length > 40 || doc.events.length > 400) throw new Error("diagram too large to render inline");

    // Participant box sizing, and the widest message label sets the column gap
    // so labels sit between lifelines rather than across them.
    var headMax = 0, labelMax = 0;
    P.forEach(function (p) {
      p.lines = splitLabel(p.label);
      var maxL = 0;
      p.lines.forEach(function (l) { maxL = Math.max(maxL, l.length); });
      p.w = Math.max(K.MINW, Math.round(maxL * K.CH) + K.PADX);
      p.h = Math.max(K.PBOX_H, 10 + p.lines.length * K.LINEH);
      headMax = Math.max(headMax, p.h);
    });
    doc.events.forEach(function (e) {
      if (e.t === "msg" && e.label) labelMax = Math.max(labelMax, e.label.length * 6.6 + 18);
    });
    var GAP = Math.max(72, Math.min(labelMax, 240));

    var x = K.MARGIN;
    P.forEach(function (p) { p.cx = x + p.w / 2; x += p.w + GAP; });
    var lifeTop = K.TOP + headMax, y = lifeTop + K.HEAD_GAP;

    var frags = [], acts = [], notes = [], msgs = [], selfs = [];
    var open = {}, stack = [], maxX = x - GAP + K.MARGIN, num = 0;
    P.forEach(function (p) { open[p.id] = []; });

    function cx(id) { return P[doc.index[id]].cx; }
    function actHalf(id, incoming) {
      var d = open[id].length + (incoming ? 1 : 0);
      return d > 0 ? K.ACT_W / 2 + (d - 1) * K.ACT_SHIFT : 0;
    }

    doc.events.forEach(function (e) {
      if (e.t === "frag") {
        var f = { kind: e.kind, label: e.label, top: y, alts: [] };
        stack.push(f); frags.push(f); y += K.FRAG_TOP;
      } else if (e.t === "fragAlt") {
        var top = stack[stack.length - 1];
        if (top) { top.alts.push({ y: y - 4, label: e.label }); y += K.FRAG_ALT; }
      } else if (e.t === "fragEnd") {
        var done = stack.pop();
        if (done) { done.bottom = y + 2; done.depth = stack.length; y += K.FRAG_BOTTOM; }
      } else if (e.t === "activate") {
        open[e.id].push({ y0: y, depth: open[e.id].length });
      } else if (e.t === "deactivate") {
        var a = open[e.id].pop();
        if (a) acts.push({ id: e.id, y0: a.y0, y1: y, depth: a.depth });
      } else if (e.t === "note") {
        var lines = e.lines, nh = Math.max(28, 10 + lines.length * K.LINEH);
        var tw = 0; lines.forEach(function (l) { tw = Math.max(tw, l.length * K.CH + 24); });
        var nx, nw;
        if (e.pos === "over") {
          var cs = e.ids.map(function (id) { return cx(id); });
          var lo = Math.min.apply(null, cs), hi = Math.max.apply(null, cs);
          nw = Math.max(tw, (hi - lo) + P[doc.index[e.ids[0]]].w);
          nx = (lo + hi) / 2 - nw / 2;
        } else if (e.pos === "left") {
          nw = tw; nx = cx(e.ids[0]) - P[doc.index[e.ids[0]]].w / 2 - 10 - nw;
        } else {
          nw = tw; nx = cx(e.ids[0]) + P[doc.index[e.ids[0]]].w / 2 + 10;
        }
        notes.push({ x: nx, y: y, w: nw, h: nh, lines: lines });
        maxX = Math.max(maxX, nx + nw + K.MARGIN);
        if (nx < K.MARGIN) { /* clamp left overflow into the margin below */ }
        y += nh + 14;
      } else if (e.t === "msg") {
        num++;
        var label = e.label;
        if (doc.autonumber && label) label = num + ". " + label;
        else if (doc.autonumber) label = String(num);
        if (e.from === e.to) {
          var bx = cx(e.from) + actHalf(e.from, false);
          selfs.push({ x: bx, y: y, dotted: e.dotted, head: e.head, label: label });
          maxX = Math.max(maxX, bx + K.SELF_W + (label ? label.length * 6.6 + 12 : 0) + K.MARGIN);
          y += K.SELF_H + 10;
        } else {
          var right = cx(e.to) > cx(e.from), dir = right ? 1 : -1;
          var x1 = cx(e.from) + dir * actHalf(e.from, false);
          var incoming = e.act === "+";
          var x2 = cx(e.to) - dir * actHalf(e.to, incoming);
          msgs.push({ x1: x1, x2: x2, y: y, dotted: e.dotted, head: e.head, label: label });
          y += K.MSG_GAP;
        }
        if (e.act === "+") open[e.to].push({ y0: e.from === e.to ? y - K.SELF_H - 10 : y - K.MSG_GAP, depth: open[e.to].length });
        else if (e.act === "-") { var d = open[e.from].pop(); if (d) acts.push({ id: e.from, y0: d.y0, y1: y - K.MSG_GAP, depth: d.depth }); }
      }
    });

    // Close anything still open and any unbalanced fragments at the bottom.
    var lifeBottom = y + 4;
    P.forEach(function (p) {
      while (open[p.id].length) { var a = open[p.id].pop(); acts.push({ id: p.id, y0: a.y0, y1: lifeBottom, depth: a.depth }); }
    });
    while (stack.length) { var f = stack.pop(); f.bottom = lifeBottom; f.depth = stack.length; }

    var W = maxX, H = lifeBottom + 12;
    var out = svgOpen(W, H);

    // Fragment frames sit behind everything, deepest inset by nesting depth.
    frags.forEach(function (f) {
      var pad = 8 + (f.depth || 0) * 7;
      var fx = pad, fw = W - pad * 2, ft = f.top, fh = (f.bottom || lifeBottom) - f.top;
      out += '<rect class="mm-frag" x="' + fx + '" y="' + ft + '" width="' + Math.max(40, fw) + '" height="' + Math.max(20, fh) + '" rx="4"/>';
      var kind = f.kind.toUpperCase();
      var tag = kind + (f.label ? " " + f.label : "");
      var tw = tag.length * 6.2 + 14;
      out += '<path class="mm-frag-tab" d="M' + fx + ',' + ft + ' h' + tw + ' v10 l-8,8 h-' + (tw - 8) + ' z"/>';
      out += '<text class="mm-frag-kind" x="' + (fx + 6) + '" y="' + (ft + 13) + '">' + esc(kind) + "</text>";
      if (f.label) out += '<text class="mm-frag-label" x="' + (fx + 12 + kind.length * 6.6) + '" y="' + (ft + 13) + '">' + esc(f.label) + "</text>";
      f.alts.forEach(function (alt) {
        out += '<line class="mm-frag-div" x1="' + fx + '" y1="' + alt.y + '" x2="' + (fx + Math.max(40, fw)) + '" y2="' + alt.y + '"/>';
        if (alt.label) out += '<text class="mm-frag-label" x="' + (fx + 8) + '" y="' + (alt.y - 4) + '">[' + esc(alt.label) + "]</text>";
      });
    });

    // Lifelines, then activation bars over them.
    P.forEach(function (p) {
      out += '<line class="mm-lifeline" x1="' + p.cx + '" y1="' + lifeTop + '" x2="' + p.cx + '" y2="' + lifeBottom + '"/>';
    });
    acts.forEach(function (a) {
      var ax = cx(a.id) - K.ACT_W / 2 + a.depth * K.ACT_SHIFT;
      out += '<rect class="mm-activation" x="' + ax + '" y="' + a.y0 + '" width="' + K.ACT_W + '" height="' + Math.max(6, a.y1 - a.y0) + '"/>';
    });

    // Notes.
    notes.forEach(function (nt) {
      out += '<rect class="mm-note" x="' + nt.x + '" y="' + nt.y + '" width="' + nt.w + '" height="' + nt.h + '" rx="2"/>';
      var sy = nt.y + nt.h / 2 - ((nt.lines.length - 1) * K.LINEH) / 2;
      out += '<text class="mm-note-text" x="' + (nt.x + nt.w / 2) + '" text-anchor="middle" dominant-baseline="central">';
      nt.lines.forEach(function (l, li) {
        out += '<tspan x="' + (nt.x + nt.w / 2) + '" y="' + (sy + li * K.LINEH) + '">' + esc(l) + "</tspan>";
      });
      out += "</text>";
    });

    // Messages: the line, its head, then a labelled band above it.
    function head(kind, x2, y2, dir) {
      if (kind === "cross") {
        var r = 4, s = dir >= 0 ? -1 : 1;
        return '<path class="mm-msg-x" d="M' + (x2 + s * r) + ',' + (y2 - r) + ' l' + (-s * 2 * r) + ',' + (2 * r) +
          ' M' + (x2 + s * r) + ',' + (y2 + r) + ' l' + (-s * 2 * r) + ',' + (-2 * r) + '"/>';
      }
      return "";
    }
    function msgMarker(kind) {
      if (kind === "arrow") return ' marker-end="url(#mm-arrow)"';
      if (kind === "open") return ' marker-end="url(#mm-open)"';
      return "";
    }
    msgs.forEach(function (mg) {
      var dir = mg.x2 >= mg.x1 ? 1 : -1;
      var x2 = mg.head === "cross" ? mg.x2 - dir * 5 : mg.x2;
      out += '<line class="mm-msg' + (mg.dotted ? " mm-dotted" : "") + '" x1="' + mg.x1 + '" y1="' + mg.y + '" x2="' + x2 + '" y2="' + mg.y + '"' + msgMarker(mg.head) + "/>";
      out += head(mg.head, mg.x2, mg.y, dir);
      if (mg.label) {
        var mx = (mg.x1 + mg.x2) / 2, lw = mg.label.length * 6.6 + 10;
        out += '<rect class="mm-msg-bg" x="' + (mx - lw / 2) + '" y="' + (mg.y - 20) + '" width="' + lw + '" height="16" rx="3"/>';
        out += '<text class="mm-msg-label" x="' + mx + '" y="' + (mg.y - 12) + '" text-anchor="middle" dominant-baseline="central">' + esc(mg.label) + "</text>";
      }
    });

    // Self messages: a small loop back to the same lifeline.
    selfs.forEach(function (sm) {
      var x0 = sm.x, top = sm.y, bot = sm.y + K.SELF_H, rx = x0 + K.SELF_W;
      out += '<path class="mm-msg' + (sm.dotted ? " mm-dotted" : "") + '" fill="none" d="M' + x0 + ',' + top + ' H' + rx + ' V' + bot + ' H' + x0 + '"' + msgMarker(sm.head) + "/>";
      out += head(sm.head, x0, bot, -1);
      if (sm.label) {
        out += '<text class="mm-msg-label" x="' + (rx + 6) + '" y="' + (top + K.SELF_H / 2) + '" dominant-baseline="central">' + esc(sm.label) + "</text>";
      }
    });

    // Participant boxes on top, at the head of each lifeline.
    P.forEach(function (p) {
      var bx = p.cx - p.w / 2, by = K.TOP + (headMax - p.h) / 2;
      out += '<rect class="mm-node' + (p.actor ? " mm-actor" : "") + '" x="' + bx + '" y="' + by + '" width="' + p.w + '" height="' + p.h + '" rx="4"/>';
      var sy = by + p.h / 2 - ((p.lines.length - 1) * K.LINEH) / 2;
      out += '<text class="mm-text" x="' + p.cx + '" text-anchor="middle" dominant-baseline="central">';
      p.lines.forEach(function (l, li) {
        out += '<tspan x="' + p.cx + '" y="' + (sy + li * K.LINEH) + '">' + esc(l) + "</tspan>";
      });
      out += "</text>";
    });

    return out + "</svg>";
  }

  /* ───────────────────────────── pie charts ─────────────────────────────
   *
   * `pie [showData] [title ...]` then `"Label" : value` rows. A ring of slices
   * from a fixed categorical palette, with a legend naming each and its share.
   * The palette is data colour, not theme colour, so it is written straight
   * onto the slices and stays put wherever the SVG is opened. */
  var PIE_COLORS = [
    "#4f9cf0", "#2ea562", "#e0a13a", "#d9645f", "#9b6ad4", "#3fb6bf",
    "#d98cc2", "#8bbf4a", "#5a6cd6", "#cf7d3c", "#57b894", "#b0555f",
  ];

  function firstLine(src) {
    var lines = String(src).replace(/\r/g, "").split("\n");
    for (var i = 0; i < lines.length; i++) {
      var t = lines[i].trim();
      if (t && t.indexOf("%%") !== 0) return t;
    }
    return "";
  }

  function parsePie(src) {
    var lines = String(src).replace(/\r/g, "").split("\n");
    var title = "", items = [], start = -1, m;
    for (var h = 0; h < lines.length; h++) {
      var t0 = lines[h].trim();
      if (!t0 || t0.indexOf("%%") === 0) continue;
      m = /^pie\b\s*(.*)$/i.exec(t0);
      if (!m) throw new Error("not a pie chart");
      var rest = m[1] || "";
      var tm = /title\s+(.+)$/i.exec(rest);
      if (tm) title = stripQuotes(tm[1]);
      start = h + 1; break;
    }
    if (start === -1) throw new Error("no pie header");
    for (var i = start; i < lines.length; i++) {
      var raw = lines[i], ci = raw.indexOf("%%");
      if (ci >= 0) raw = raw.slice(0, ci);
      var s = raw.trim();
      if (!s) continue;
      if ((m = /^title\s+(.+)$/i.exec(s))) { title = stripQuotes(m[1]); continue; }
      if (/^showdata\b/i.test(s)) continue;
      if ((m = /^(?:"([^"]*)"|([^:]+?))\s*:\s*(-?[0-9]+(?:\.[0-9]+)?)\s*$/.exec(s))) {
        items.push({ label: (m[1] != null ? m[1] : m[2]).trim(), value: parseFloat(m[3]) });
      }
    }
    return { title: title, items: items };
  }

  function renderPie(src) {
    var doc = parsePie(src), items = doc.items;
    if (!items.length) throw new Error("no slices in pie chart");
    var total = 0; items.forEach(function (it) { total += Math.max(0, it.value); });
    if (total <= 0) throw new Error("pie chart has no positive values");

    var R = 94, cxp = 12 + R, top = doc.title ? 30 : 12, cyp = top + R;
    var legendX = cxp + R + 24, lineH = 22;
    var legendW = 0;
    items.forEach(function (it) {
      var t = it.label + "  " + Math.round(it.value / total * 100) + "%";
      legendW = Math.max(legendW, 22 + t.length * 6.8);
    });
    var W = legendX + legendW + 12;
    var H = Math.max(cyp + R + 12, top + items.length * lineH + 12);

    var out = svgOpen(W, H);
    if (doc.title) out += '<text class="mm-pie-title" x="' + cxp + '" y="18" text-anchor="middle">' + esc(doc.title) + "</text>";

    var ang = -Math.PI / 2; // start at 12 o'clock
    items.forEach(function (it, i) {
      var frac = Math.max(0, it.value) / total, a2 = ang + frac * 2 * Math.PI;
      var color = PIE_COLORS[i % PIE_COLORS.length];
      if (frac >= 0.9999) {
        out += '<circle class="mm-slice" fill="' + color + '" cx="' + cxp + '" cy="' + cyp + '" r="' + R + '"/>';
      } else if (frac > 0) {
        var x1 = cxp + R * Math.cos(ang), y1 = cyp + R * Math.sin(ang);
        var x2 = cxp + R * Math.cos(a2), y2 = cyp + R * Math.sin(a2);
        var large = frac > 0.5 ? 1 : 0;
        out += '<path class="mm-slice" fill="' + color + '" d="M' + cxp + ',' + cyp + ' L' + x1.toFixed(2) + ',' + y1.toFixed(2) +
          ' A' + R + ',' + R + ' 0 ' + large + ' 1 ' + x2.toFixed(2) + ',' + y2.toFixed(2) + ' Z"/>';
        if (frac > 0.05) {
          var mid = (ang + a2) / 2, lr = R * 0.62;
          out += '<text class="mm-pie-pct" x="' + (cxp + lr * Math.cos(mid)).toFixed(1) + '" y="' + (cyp + lr * Math.sin(mid)).toFixed(1) +
            '" text-anchor="middle" dominant-baseline="central">' + Math.round(frac * 100) + "%</text>";
        }
      }
      ang = a2;
      var ly = top + i * lineH;
      out += '<rect class="mm-slice" fill="' + color + '" x="' + legendX + '" y="' + ly + '" width="13" height="13" rx="2"/>';
      out += '<text class="mm-legend" x="' + (legendX + 20) + '" y="' + (ly + 7) + '" dominant-baseline="central">' +
        esc(it.label) + "  " + Math.round(frac * 100) + "%</text>";
    });
    return out + "</svg>";
  }

  /* ──────────────────────────── class diagrams ───────────────────────────
   *
   * `classDiagram` with `class X { +members }` boxes and relation lines whose
   * ends carry the UML markers - a hollow triangle for inheritance/realization,
   * a filled or open diamond for composition/aggregation, an arrow for an
   * association. Boxes are laid out by the shared layerer, then drawn with the
   * three UML compartments. */
  var CLASS_RELS = [
    ["<|--", "tri", "none", false], ["--|>", "none", "tri", false],
    ["<|..", "tri", "none", true], ["..|>", "none", "tri", true],
    ["*--", "diamond", "none", false], ["--*", "none", "diamond", false],
    ["o--", "odiamond", "none", false], ["--o", "none", "odiamond", false],
    ["<--", "arrow", "none", false], ["-->", "none", "arrow", false],
    ["<..", "arrow", "none", true], ["..>", "none", "arrow", true],
    ["--", "none", "none", false], ["..", "none", "none", true],
  ];

  function parseClass(src) {
    var lines = String(src).replace(/\r/g, "").split("\n");
    var classes = {}, order = [], rels = [], start = -1, cur = null;

    function ensure(id) {
      id = id.replace(/~.*~/g, "").trim();
      if (!classes[id]) { classes[id] = { id: id, attrs: [], methods: [] }; order.push(id); }
      return classes[id];
    }
    function member(cls, text) {
      text = text.trim(); if (!text) return;
      if (/[()]/.test(text)) cls.methods.push(text); else cls.attrs.push(text);
    }

    for (var h = 0; h < lines.length; h++) {
      var t0 = lines[h].trim();
      if (!t0 || t0.indexOf("%%") === 0) continue;
      if (!/^classDiagram(-v2)?\b/i.test(t0)) throw new Error("not a class diagram");
      start = h + 1; break;
    }
    if (start === -1) throw new Error("no classDiagram header");

    for (var i = start; i < lines.length; i++) {
      var raw = lines[i], ci = raw.indexOf("%%");
      if (ci >= 0) raw = raw.slice(0, ci);
      var s = raw.trim();
      if (!s) continue;
      var m;

      if (cur) { // inside a class body
        if (/^\}$/.test(s)) { cur = null; continue; }
        member(cur, s); continue;
      }
      if ((m = /^class\s+([A-Za-z0-9_~]+)\s*\{$/i.exec(s))) { cur = ensure(m[1]); continue; }
      if ((m = /^class\s+([A-Za-z0-9_~]+)\s*$/i.exec(s))) { ensure(m[1]); continue; }
      if (/^(direction|note|namespace|<<)/i.test(s)) continue;

      // A relation between two classes.
      m = /^([A-Za-z0-9_~]+)\s*(?:"([^"]*)")?\s*(<\|--|--\|>|<\|\.\.|\.\.\|>|\*--|--\*|o--|--o|<--|-->|<\.\.|\.\.>|--|\.\.)\s*(?:"([^"]*)")?\s*([A-Za-z0-9_~]+)\s*(?::\s*(.*))?$/.exec(s);
      if (m) {
        var spec = null;
        for (var k = 0; k < CLASS_RELS.length; k++) if (CLASS_RELS[k][0] === m[3]) { spec = CLASS_RELS[k]; break; }
        ensure(m[1]); ensure(m[5]);
        rels.push({
          from: m[1].replace(/~.*~/g, "").trim(), to: m[5].replace(/~.*~/g, "").trim(),
          fromCard: m[2] || "", toCard: m[4] || "", label: m[6] != null ? stripQuotes(m[6]) : "",
          startMark: spec[1], endMark: spec[2], dashed: spec[3],
        });
        continue;
      }
      // `X : +member` inline form.
      if ((m = /^([A-Za-z0-9_~]+)\s*:\s*(.*)$/.exec(s))) { member(ensure(m[1]), m[2]); continue; }
    }
    return { classes: classes, order: order, rels: rels };
  }

  function renderClass(src) {
    var doc = parseClass(src), order = doc.order;
    if (!order.length) throw new Error("no classes in diagram");
    if (order.length > 60) throw new Error("diagram too large to render inline");

    var CH = 7.4, HEAD = 24, ROW = 17;
    var nodes = {}, edges = [], hint = {};
    order.forEach(function (id) {
      var c = doc.classes[id], all = [id].concat(c.attrs, c.methods), maxL = id.length;
      all.forEach(function (l) { maxL = Math.max(maxL, l.length); });
      c.w = Math.max(72, Math.round(maxL * CH) + 20);
      c.h = HEAD + (c.attrs.length + c.methods.length) * ROW + (c.attrs.length || c.methods.length ? 10 : 0);
      nodes[id] = { id: id, shape: "rect", lines: [id] };
      hint[id] = { w: c.w, h: c.h };
    });
    doc.rels.forEach(function (r) { edges.push({ from: r.from, to: r.to }); });

    var g = { dir: "TB", nodes: nodes, order: order, edges: edges, subgraphs: [] };
    var L = layout(g, hint);
    var pos = L.pos;

    var W = 0, H = 0;
    order.forEach(function (id) { var p = pos[id]; W = Math.max(W, p.x + p.w / 2); H = Math.max(H, p.y + p.h / 2); });
    W += 16; H += 16;
    var out = svgOpen(W, H);

    // Relations under the boxes.
    function endMark(kind) {
      if (kind === "tri") return "url(#mm-tri)";
      if (kind === "diamond") return "url(#mm-diamond)";
      if (kind === "odiamond") return "url(#mm-odiamond)";
      if (kind === "arrow") return "url(#mm-arrow)";
      return "";
    }
    doc.rels.forEach(function (r) {
      var a = pos[r.from], z = pos[r.to];
      if (!a || !z) return;
      var p1 = border(a, z.x, z.y), p2 = border(z, a.x, a.y);
      var ms = endMark(r.startMark), me = endMark(r.endMark);
      out += '<line class="mm-edge' + (r.dashed ? " mm-dotted" : "") + '" x1="' + p1.x + '" y1="' + p1.y + '" x2="' + p2.x + '" y2="' + p2.y + '"' +
        (ms ? ' marker-start="' + ms + '"' : "") + (me ? ' marker-end="' + me + '"' : "") + "/>";
      if (r.label) {
        var mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2, lw = r.label.length * 6.6 + 8;
        out += '<rect class="mm-elabel-bg" x="' + (mx - lw / 2) + '" y="' + (my - 9) + '" width="' + lw + '" height="18" rx="3"/>';
        out += '<text class="mm-elabel" x="' + mx + '" y="' + my + '" text-anchor="middle" dominant-baseline="central">' + esc(r.label) + "</text>";
      }
      if (r.fromCard) out += '<text class="mm-elabel" x="' + (p1.x + (p2.x > p1.x ? 6 : -6)) + '" y="' + (p1.y - 6) + '" text-anchor="middle">' + esc(r.fromCard) + "</text>";
      if (r.toCard) out += '<text class="mm-elabel" x="' + (p2.x + (p1.x > p2.x ? 6 : -6)) + '" y="' + (p2.y - 6) + '" text-anchor="middle">' + esc(r.toCard) + "</text>";
    });

    // Class boxes with their compartments.
    order.forEach(function (id) {
      var c = doc.classes[id], p = pos[id], x = p.x - p.w / 2, y = p.y - p.h / 2;
      out += '<rect class="mm-node" x="' + x + '" y="' + y + '" width="' + p.w + '" height="' + p.h + '" rx="3"/>';
      out += '<text class="mm-text mm-class-name" x="' + p.x + '" y="' + (y + HEAD / 2 + 2) + '" text-anchor="middle" dominant-baseline="central">' + esc(id) + "</text>";
      var yy = y + HEAD;
      if (c.attrs.length || c.methods.length) {
        out += '<line class="mm-node-line" x1="' + x + '" y1="' + yy + '" x2="' + (x + p.w) + '" y2="' + yy + '"/>';
        yy += 6;
        c.attrs.forEach(function (a) { out += '<text class="mm-member" x="' + (x + 8) + '" y="' + (yy + 4) + '" dominant-baseline="central">' + esc(a) + "</text>"; yy += ROW; });
        if (c.attrs.length && c.methods.length) { out += '<line class="mm-node-line" x1="' + x + '" y1="' + yy + '" x2="' + (x + p.w) + '" y2="' + yy + '"/>'; yy += 6; }
        c.methods.forEach(function (mth) { out += '<text class="mm-member" x="' + (x + 8) + '" y="' + (yy + 4) + '" dominant-baseline="central">' + esc(mth) + "</text>"; yy += ROW; });
      }
    });
    return out + "</svg>";
  }

  /* ───────────────────────────── ER diagrams ─────────────────────────────
   *
   * `erDiagram` with `A <card>--<card> B : label` relationships in crow's-foot
   * notation, and optional `A { type name }` attribute blocks. Entities are
   * boxes laid out by the shared layerer; each relationship end draws the
   * crow's-foot glyph for its cardinality. */
  function parseER(src) {
    var lines = String(src).replace(/\r/g, "").split("\n");
    var ents = {}, order = [], rels = [], start = -1, cur = null;
    function ensure(id) {
      id = stripQuotes(id);
      if (!ents[id]) { ents[id] = { id: id, attrs: [] }; order.push(id); }
      return ents[id];
    }
    for (var h = 0; h < lines.length; h++) {
      var t0 = lines[h].trim();
      if (!t0 || t0.indexOf("%%") === 0) continue;
      if (!/^erDiagram\b/i.test(t0)) throw new Error("not an ER diagram");
      start = h + 1; break;
    }
    if (start === -1) throw new Error("no erDiagram header");

    for (var i = start; i < lines.length; i++) {
      var raw = lines[i], ci = raw.indexOf("%%");
      if (ci >= 0) raw = raw.slice(0, ci);
      var s = raw.trim();
      if (!s) continue;
      var m;
      if (cur) {
        if (/^\}$/.test(s)) { cur = null; continue; }
        var parts = s.split(/\s+/);
        if (parts.length >= 2) cur.attrs.push({ type: parts[0], name: parts[1] });
        else cur.attrs.push({ type: parts[0], name: "" });
        continue;
      }
      if ((m = /^([A-Za-z0-9_-]+|"[^"]+")\s*\{$/.exec(s))) { cur = ensure(m[1]); continue; }
      // Relationship: E1 <lcard><line><rcard> E2 : label
      m = /^([A-Za-z0-9_-]+|"[^"]+")\s*(\|o|\|\||\}o|\}\|)(--|\.\.)(o\||\|\||o\{|\|\{)\s*([A-Za-z0-9_-]+|"[^"]+")\s*:\s*(.*)$/.exec(s);
      if (m) {
        ensure(m[1]); ensure(m[5]);
        rels.push({
          from: stripQuotes(m[1]), to: stripQuotes(m[5]),
          fromCard: m[2], toCard: m[4], dashed: m[3] === "..",
          label: stripQuotes(m[6] || ""),
        });
        continue;
      }
      if ((m = /^([A-Za-z0-9_-]+|"[^"]+")\s*$/.exec(s))) { ensure(m[1]); continue; }
    }
    return { ents: ents, order: order, rels: rels };
  }

  /* The crow's-foot glyph for one cardinality token, drawn at (x,y) pointing
     back along direction (ux,uy) (the unit vector into the entity). */
  function crowFoot(card, x, y, ux, uy) {
    var many = /\{|\}/.test(card), zero = /o/.test(card), one = /\|/.test(card);
    var px = -uy, py = ux; // perpendicular
    var g = 9, sp = 6, out = "";
    function pt(d, s) { return (x + ux * d + px * s).toFixed(1) + "," + (y + uy * d + py * s).toFixed(1); }
    if (many) {
      out += '<path class="mm-er-mark" d="M' + pt(g, 0) + ' L' + pt(0, sp) + ' M' + pt(g, 0) + ' L' + pt(0, -sp) + ' M' + pt(g, 0) + ' L' + pt(0, 0) + '"/>';
    }
    var barD = many ? g + 4 : g;
    if (one) out += '<line class="mm-er-mark" x1="' + (x + ux * barD + px * sp).toFixed(1) + '" y1="' + (y + uy * barD + py * sp).toFixed(1) + '" x2="' + (x + ux * barD - px * sp).toFixed(1) + '" y2="' + (y + uy * barD - py * sp).toFixed(1) + '"/>';
    if (zero) out += '<circle class="mm-er-mark" fill="none" cx="' + (x + ux * (barD + 5)).toFixed(1) + '" cy="' + (y + uy * (barD + 5)).toFixed(1) + '" r="4"/>';
    return out;
  }

  function renderER(src) {
    var doc = parseER(src), order = doc.order;
    if (!order.length) throw new Error("no entities in diagram");
    if (order.length > 60) throw new Error("diagram too large to render inline");

    var CH = 7.4, HEAD = 26, ROW = 17;
    var nodes = {}, edges = [];
    order.forEach(function (id) {
      var e = doc.ents[id], maxL = id.length;
      e.attrs.forEach(function (a) { maxL = Math.max(maxL, (a.type + " " + a.name).length); });
      e.w = Math.max(80, Math.round(maxL * CH) + 22);
      e.h = HEAD + e.attrs.length * ROW + (e.attrs.length ? 6 : 0);
    });
    doc.rels.forEach(function (r) { edges.push({ from: r.from, to: r.to }); });
    var g = { dir: "LR", nodes: {}, order: order, edges: edges, subgraphs: [] }, hint = {};
    order.forEach(function (id) { g.nodes[id] = { id: id, shape: "rect", lines: [id] }; hint[id] = { w: doc.ents[id].w, h: doc.ents[id].h }; });
    var L = layout(g, hint);
    var pos = L.pos;
    // The shared layerer packs columns tightly; a relationship needs room for
    // its label and both crow's-foot glyphs, so spread the columns apart.
    var minPx = Infinity;
    order.forEach(function (id) { minPx = Math.min(minPx, pos[id].x); });
    var maxLabel = 0;
    doc.rels.forEach(function (r) { maxLabel = Math.max(maxLabel, (r.label || "").length * 6.8 + 60); });
    var spread = Math.max(1.7, maxLabel / 80);
    order.forEach(function (id) { pos[id].x = minPx + (pos[id].x - minPx) * spread; });

    var W = 0, H = 0;
    order.forEach(function (id) { var p = pos[id]; W = Math.max(W, p.x + p.w / 2); H = Math.max(H, p.y + p.h / 2); });
    W += 16; H += 16;
    var out = svgOpen(W, H);

    doc.rels.forEach(function (r) {
      var a = pos[r.from], z = pos[r.to];
      if (!a || !z) return;
      var p1 = border(a, z.x, z.y), p2 = border(z, a.x, a.y);
      var dx = p2.x - p1.x, dy = p2.y - p1.y, len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len;
      out += '<line class="mm-edge' + (r.dashed ? " mm-dotted" : "") + '" x1="' + p1.x + '" y1="' + p1.y + '" x2="' + p2.x + '" y2="' + p2.y + '"/>';
      out += crowFoot(r.fromCard, p1.x, p1.y, ux, uy);
      out += crowFoot(r.toCard, p2.x, p2.y, -ux, -uy);
      if (r.label) {
        var mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2, lw = r.label.length * 6.6 + 8;
        out += '<rect class="mm-elabel-bg" x="' + (mx - lw / 2) + '" y="' + (my - 9) + '" width="' + lw + '" height="18" rx="3"/>';
        out += '<text class="mm-elabel" x="' + mx + '" y="' + my + '" text-anchor="middle" dominant-baseline="central">' + esc(r.label) + "</text>";
      }
    });

    order.forEach(function (id) {
      var e = doc.ents[id], p = pos[id], x = p.x - p.w / 2, y = p.y - p.h / 2;
      out += '<rect class="mm-node" x="' + x + '" y="' + y + '" width="' + p.w + '" height="' + p.h + '" rx="3"/>';
      out += '<text class="mm-text mm-class-name" x="' + p.x + '" y="' + (y + HEAD / 2 + 1) + '" text-anchor="middle" dominant-baseline="central">' + esc(id) + "</text>";
      if (e.attrs.length) {
        out += '<line class="mm-node-line" x1="' + x + '" y1="' + (y + HEAD) + '" x2="' + (x + p.w) + '" y2="' + (y + HEAD) + '"/>';
        var yy = y + HEAD + 4;
        e.attrs.forEach(function (a) {
          out += '<text class="mm-member" x="' + (x + 8) + '" y="' + (yy + 4) + '" dominant-baseline="central">' + esc(a.type + (a.name ? " " + a.name : "")) + "</text>";
          yy += ROW;
        });
      }
    });
    return out + "</svg>";
  }

  /* The public entry point: pick a renderer from the header. Each throws on a
     diagram it cannot parse, and the caller falls back to showing the source,
     so an unsupported type is never worse than the fence it arrived in. */
  function render(src) {
    var head = firstLine(src);
    if (/^sequenceDiagram\b/i.test(head)) return renderSequence(src);
    if (/^stateDiagram(-v2)?\b/i.test(head)) return renderState(src);
    if (/^classDiagram(-v2)?\b/i.test(head)) return renderClass(src);
    if (/^erDiagram\b/i.test(head)) return renderER(src);
    if (/^pie\b/i.test(head)) return renderPie(src);
    return renderFlowchart(src);
  }

  var api = {
    render: render, parse: parse,
    renderFlowchart: renderFlowchart, renderSequence: renderSequence, parseSequence: parseSequence,
    renderState: renderState, parseState: parseState,
    renderClass: renderClass, parseClass: parseClass,
    renderER: renderER, parseER: parseER,
    renderPie: renderPie, parsePie: parsePie,
  };
  root.KXMermaid = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
