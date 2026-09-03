/* A flowchart renderer, hand-rolled to stay small and work offline.
 *
 * The model writes ```mermaid blocks, and a non-multimodal model cannot draw a
 * picture - it can only emit the source. This turns that source into an SVG in
 * the transcript, so a flowchart reads as a flowchart rather than as a wall of
 * arrows nobody parses in their head.
 *
 * Deliberately NOT the mermaid library. Mermaid is ~2.8 MB minified and pulls a
 * layout engine and a parser generator with it; this extension bundles no such
 * thing and renders identically air-gapped, the same reason it drives the
 * browser over raw CDP and highlights code with its own tokenizer. So this is a
 * focused subset - `flowchart`/`graph` with the common node shapes, labelled
 * edges, `<br/>` in labels, and `subgraph` boxes - laid out with a simple
 * longest-path layering. Anything it cannot parse throws, and the caller falls
 * back to showing the source as a code block, so an unsupported diagram is
 * never worse than it was before.
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

  function layout(g) {
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
      n.lines.forEach(function (l) { maxLine = Math.max(maxLine, l.length); });
      var w = Math.max(MINW, Math.round(maxLine * CHAR) + PADX);
      var ht = Math.max(NODE_H, 12 + n.lines.length * LINEH);
      if (n.shape === "circle" || n.shape === "diamond") { w = Math.max(w, ht); }
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

  function render(src) {
    var g = parse(src);
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

    var svg = '<svg class="mm-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' +
      Math.ceil(W) + ' ' + Math.ceil(H) + '" width="' + Math.ceil(W) + '" height="' + Math.ceil(H) + '" role="img">';
    svg += '<defs><marker id="mm-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">' +
      '<path class="mm-arrow" d="M0,0 L10,5 L0,10 z"/></marker></defs>';

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
      svg += shapeSvg(node, p) + textSvg(node, p);
    }

    return svg + "</svg>";
  }

  var api = { render: render, parse: parse };
  root.KXMermaid = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
