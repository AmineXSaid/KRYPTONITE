/**
 * A mermaid flowchart, streamed into the REAL panel, becomes a real SVG.
 *
 * `markdown-render.cjs` proves the renderer as string work: given a block, it
 * returns markup containing an `<svg>`. That is not the claim anyone cares
 * about. The claim is that when a model answers with a ```mermaid block, the
 * chat draws a diagram - so this drives the shipped sidebar in a real browser,
 * streams an answer the way the host streams one, and looks at what is on
 * screen afterwards: a laid-out SVG with boxes and arrows, and no source text.
 *
 * Both routes are checked, because they are different code paths and only one
 * of them is the live one:
 *
 *   1. STREAMED - `streamDelta` in chunks, then `turnEnd`. This is what happens
 *      when the model actually answers, and it is the path where a half-arrived
 *      fence must render as code and then become a diagram once it closes.
 *   2. RESTORED - `stateSync` carrying the finished transcript. This is what
 *      happens when the conversation is reopened, and a diagram that only
 *      survives until reload is not a feature.
 *
 * It also writes a screenshot, because "the diagram renders" is a visual claim
 * and a passing assertion about `<svg>` count is not the same as looking at it.
 *
 * SKIPs rather than fails with no browser, matching the other browser suites.
 *
 * Run: node test/mermaid-render.cjs
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
// Defaults to the working tree, but can be pointed at the media unpacked from
// a built .vsix, so the same proof can be run against the archive the user
// actually installs rather than only against the sources it was built from.
const MEDIA = process.env.GENESIS_MEDIA || path.join(ROOT, "media");
// Everything this suite writes goes to a temp directory, never into media/:
// that folder is packaged into the .vsix, and a proof screenshot is not
// something users should be shipped. The page reaches the real assets through
// absolute file:// URLs instead of sitting next to them.
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "genesis-mermaid-"));
const OUT = process.env.GENESIS_MERMAID_SHOT || path.join(WORK, "mermaid-proof.png");
const asset = (rel) => "file://" + path.join(MEDIA, rel);

let chromium;
try { ({ chromium } = require("playwright-core")); }
catch { console.log("SKIP  playwright-core is not installed."); process.exit(0); }

/** The same search the extension itself does, plus the usual dev locations. */
function findBrowser() {
  if (process.env.GENESIS_CHROME && fs.existsSync(process.env.GENESIS_CHROME)) {
    return process.env.GENESIS_CHROME;
  }
  const home = os.homedir();
  const defaults = process.platform === "darwin"
    ? [path.join(home, "Library/Caches/ms-playwright")]
    : process.platform === "win32"
      ? [path.join(process.env.LOCALAPPDATA || home, "ms-playwright")]
      : [path.join(home, ".cache/ms-playwright")];
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, "/opt/pw-browsers", ...defaults].filter(Boolean);
  for (const r of roots) {
    let names = [];
    try { names = fs.readdirSync(r); } catch { continue; }
    for (const n of names.filter((x) => x.startsWith("chromium")).sort().reverse()) {
      for (const rel of ["chrome-linux/chrome", "chrome-linux/headless_shell"]) {
        const p = path.join(r, n, rel);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  for (const p of ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"]) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const EXE = findBrowser();
if (!EXE) { console.log("SKIP  no Chromium found."); process.exit(0); }

let pass = 0;
const failures = [];
const ok = (label, cond, detail = "") => {
  if (cond) { pass++; console.log("PASS  " + label + (detail ? "  — " + detail : "")); return; }
  failures.push(label + (detail ? "  — " + detail : ""));
  console.log("FAIL  " + label + (detail ? "  — " + detail : ""));
};

const GROUND = "#181818";
// Mirrors shell() in src/ui/shell.ts for the sidebar surface, mermaid.js
// included - that script is exactly what is under test here.
const HTML = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<link rel="stylesheet" href="${asset("webview/tokens.css")}">
<link rel="stylesheet" href="${asset("webview/sidebar.css")}">
<style>html{background:${GROUND};color-scheme:dark}:root{--vscode-sideBar-background:${GROUND}}</style>
</head><body><div id="root"></div>
<script>
  window.__sent = [];
  window.__kx = { api: { postMessage: function (m) { window.__sent.push(m); },
                         getState: function(){return null;}, setState: function(){} },
                  surface: "sidebar" };
</script>
<script src="${asset("webview/crystal.js")}"></script>
<script src="${asset("webview/mermaid.js")}"></script>
<script src="${asset("webview/sidebar.js")}"></script>
</body></html>`;
const PAGE = path.join(WORK, "mermaid.html");
fs.writeFileSync(PAGE, HTML);

/* The diagram from the report: a left-to-right flowchart inside a subgraph,
   with <br/> in two of its labels. */
const DIAGRAM = [
  "```mermaid",
  "flowchart LR",
  "    subgraph frame[One LIN diagnostic frame - 8 bytes]",
  "        PID[Protected ID<br/>0x3C or 0x3D] --> PCB[PCI byte<br/>type] --> DATA[payload data]",
  "    end",
  "```",
].join("\n");

const ANSWER =
  "Here is how a LIN diagnostic frame is laid out.\n\n" + DIAGRAM +
  "\n\nThe PCI byte's high nibble is the frame type.\n";

/* A second one with a decision and labelled edges, to prove the shapes and the
   edge labels are drawn rather than only rectangles. */
const DECISION = [
  "```mermaid",
  "flowchart TD",
  "  A[Frame arrives] --> B{PCI type?}",
  "  B -->|single| C([Whole message])",
  "  B -->|first| D[(Buffer it)]",
  "  B -->|invalid| E((Drop))",
  "```",
].join("\n");

/* A sequence diagram: participants on lifelines, messages with a labelled
   solid and a dashed reply, an activation, a note, and an alt fragment. This is
   the second grammar, and the claim is the same - it draws, it does not fall
   back to source. */
const SEQUENCE = [
  "```mermaid",
  "sequenceDiagram",
  "    participant T as Tester",
  "    participant D as DUT / LIN master",
  "    T->>+D: request diagnostic frame",
  "    D-->>-T: response frame",
  "    Note over T,D: one LIN diagnostic exchange",
  "    alt frame valid",
  "        D->>T: ack",
  "    else invalid",
  "        D->>T: nak",
  "    end",
  "```",
].join("\n");

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
  try {
    const ctx = await browser.newContext({
      viewport: { width: 640, height: 900 }, deviceScaleFactor: 2,
    });
    const page = await ctx.newPage();
    const boom = [];
    page.on("pageerror", (e) => boom.push(String(e)));
    await page.goto("file://" + PAGE);

    const STATE = {
      type: "stateSync",
      state: {
        workspace: { open: true, name: "repo" },
        running: false, phase: "act", status: { state: "ok", label: "OK · ACT" },
        endpoint: "gw",
        profiles: [{ id: "gw", status: "ready", active: true, model: "gpt-multimodal",
          wire: "openai", baseUrl: "https://x", capabilities: { contextWindow: 128000 } }],
        skills: [], skillWarnings: [], agents: [], agentWarnings: [], activeAgent: "",
        config: { ui: {} }, tlsError: null, rungs: [], tracing: false, todos: [],
        checkpoints: [], sessions: [], selection: null, context: null, changes: [],
        models: [{ group: "gw", models: ["gpt-multimodal"] }], logs: [],
        session: { id: "s1", title: "LIN frame layout", messages: [
          { role: "user", content: "explain the LIN diagnostic frame layout" },
        ] },
      },
    };
    const send = (m) => page.evaluate((msg) => {
      window.dispatchEvent(new MessageEvent("message", { data: msg }));
    }, m);

    await send(STATE);

    /* ── 1. streamed, in chunks, exactly as the host streams ─────────── */
    console.log("──── streamed from the model ────");
    // Cut into small frames so the fence is open for several of them: a
    // half-arrived diagram must not throw and must not render a broken SVG.
    for (let i = 0; i < ANSWER.length; i += 24) {
      await send({ type: "streamDelta", text: ANSWER.slice(i, i + 24) });
    }
    const midway = await page.evaluate(() => ({
      svgs: document.querySelectorAll("#log .mm-svg").length,
      errors: document.querySelectorAll("#log .err-box").length,
    }));
    ok("a still-arriving diagram does not error", midway.errors === 0);

    await send({ type: "turnEnd" });
    await page.waitForTimeout(120);

    const shot = await page.evaluate(() => {
      const fig = document.querySelector("#log .mermaid-fig");
      const svg = document.querySelector("#log .mermaid-fig svg.mm-svg");
      const box = svg ? svg.getBoundingClientRect() : null;
      return {
        fig: !!fig,
        svg: !!svg,
        w: box ? Math.round(box.width) : 0,
        h: box ? Math.round(box.height) : 0,
        nodes: document.querySelectorAll("#log .mm-node").length,
        edges: document.querySelectorAll("#log .mm-edge").length,
        sub: document.querySelectorAll("#log .mm-sub").length,
        subTitle: (document.querySelector("#log .mm-sub-title") || {}).textContent || "",
        texts: [...document.querySelectorAll("#log .mm-text")].map((t) => t.textContent),
        tspans: document.querySelectorAll("#log .mm-text tspan").length,
        // The source must NOT be sitting in the transcript as visible code.
        visibleSource: [...document.querySelectorAll("#log pre")]
          .filter((p) => p.offsetParent !== null && /flowchart/.test(p.textContent)).length,
        prose: /PCI byte's high nibble/.test(document.getElementById("log").textContent),
      };
    });

    ok("the transcript holds a mermaid figure", shot.fig);
    ok("carrying a real SVG", shot.svg);
    ok("that is actually laid out on screen", shot.w > 200 && shot.h > 40, `${shot.w}x${shot.h}`);
    ok("with one shape per node", shot.nodes === 3, String(shot.nodes));
    ok("and an edge between each pair", shot.edges === 2, String(shot.edges));
    ok("the subgraph is drawn as a box", shot.sub === 1, String(shot.sub));
    ok("titled as the model wrote it",
      /One LIN diagnostic frame/.test(shot.subTitle), shot.subTitle);
    ok("every node label is drawn", shot.texts.length === 3, shot.texts.join(" | "));
    ok("a <br/> label is split across lines", shot.tspans >= 5, String(shot.tspans));
    ok("the mermaid source is NOT left visible as code", shot.visibleSource === 0);
    ok("and the prose around it still renders", shot.prose);

    /* ── 2. a second diagram: shapes and labelled edges ──────────────── */
    console.log("\n──── shapes and edge labels ────");
    await send({ type: "streamDelta", text: "\n\nAnd the decision:\n\n" + DECISION + "\n" });
    await send({ type: "turnEnd" });
    await page.waitForTimeout(120);
    const two = await page.evaluate(() => ({
      figs: document.querySelectorAll("#log .mermaid-fig").length,
      diamonds: document.querySelectorAll("#log polygon.mm-node").length,
      ellipses: document.querySelectorAll("#log ellipse.mm-node").length,
      elabels: [...document.querySelectorAll("#log .mm-elabel")].map((t) => t.textContent),
    }));
    ok("a second diagram renders too", two.figs === 2, String(two.figs));
    ok("a decision is a diamond", two.diamonds >= 1, String(two.diamonds));
    ok("a circle node is an ellipse", two.ellipses >= 1, String(two.ellipses));
    ok("edge labels are drawn", two.elabels.length === 3, two.elabels.join(","));
    ok("and say what the model wrote",
      ["single", "first", "invalid"].every((w) => two.elabels.includes(w)), two.elabels.join(","));

    /* ── 2b. a sequence diagram: the second grammar ─────────────────── */
    console.log("\n──── sequence diagram ────");
    await send({ type: "streamDelta", text: "\n\nAnd the exchange over time:\n\n" + SEQUENCE + "\n" });
    await send({ type: "turnEnd" });
    await page.waitForTimeout(120);
    const seq = await page.evaluate(() => {
      const figs = [...document.querySelectorAll("#log .mermaid-fig svg.mm-svg")];
      const last = figs[figs.length - 1];
      const q = (sel) => last ? last.querySelectorAll(sel).length : 0;
      const box = last ? last.getBoundingClientRect() : { width: 0, height: 0 };
      return {
        figs: document.querySelectorAll("#log .mermaid-fig").length,
        w: Math.round(box.width), h: Math.round(box.height),
        lifelines: q(".mm-lifeline"),
        boxes: q(".mm-node"),
        messages: q("line.mm-msg"),
        activation: q(".mm-activation"),
        notes: q(".mm-note"),
        frags: q(".mm-frag"),
        labels: last ? [...last.querySelectorAll(".mm-msg-label")].map((t) => t.textContent) : [],
        // The source must not be sitting visible as code.
        visibleSource: [...document.querySelectorAll("#log pre")]
          .filter((p) => p.offsetParent !== null && /sequenceDiagram/.test(p.textContent)).length,
      };
    });
    ok("the sequence diagram renders as a figure", seq.figs === 3, String(seq.figs));
    ok("laid out on screen", seq.w > 150 && seq.h > 80, `${seq.w}x${seq.h}`);
    ok("a lifeline for each of the two participants", seq.lifelines === 2, String(seq.lifelines));
    ok("a participant box at the head of each", seq.boxes === 2, String(seq.boxes));
    ok("the messages between them are drawn", seq.messages >= 4, String(seq.messages));
    ok("the + activation is a bar on the lifeline", seq.activation >= 1, String(seq.activation));
    ok("the note over both is drawn", seq.notes === 1, String(seq.notes));
    ok("the alt fragment is a frame", seq.frags === 1, String(seq.frags));
    ok("and the message labels say what the model wrote",
      seq.labels.includes("request diagnostic frame") && seq.labels.includes("ack"), seq.labels.join(" | "));
    ok("the sequence source is NOT left visible as code", seq.visibleSource === 0);

    /* ── 2c. the other diagram types ─────────────────────────────────── */
    console.log("\n──── state, class, ER, pie ────");
    const MORE = [
      "```mermaid", "stateDiagram-v2", "  [*] --> Idle", "  Idle --> Busy : start", "  Busy --> [*]", "```",
      "", "```mermaid", "classDiagram", "  class Node {", "    +int id", "    +run()", "  }", "  Node <|-- Leaf", "```",
      "", "```mermaid", "erDiagram", "  BUS ||--o{ FRAME : carries", "```",
      "", "```mermaid", "pie title Split", "  \"A\" : 60", "  \"B\" : 40", "```",
    ].join("\n");
    await send({ type: "streamDelta", text: "\n\n" + MORE + "\n" });
    await send({ type: "turnEnd" });
    await page.waitForTimeout(150);
    const more = await page.evaluate(() => ({
      figs: document.querySelectorAll("#log .mermaid-fig").length,
      startDot: document.querySelectorAll("#log .mm-startend").length,
      umlTri: [...document.querySelectorAll("#log svg")].some((s) => /mm-tri/.test(s.innerHTML)),
      crow: document.querySelectorAll("#log .mm-er-mark").length,
      slices: document.querySelectorAll("#log .mm-slice").length,
      legend: document.querySelectorAll("#log .mm-legend").length,
      // No fenced source of any of these should be left visible as code.
      visibleSource: [...document.querySelectorAll("#log pre")]
        .filter((p) => p.offsetParent !== null && /(stateDiagram|classDiagram|erDiagram|^pie)/m.test(p.textContent)).length,
    }));
    ok("all four extra diagrams render as figures", more.figs >= 7, String(more.figs));
    ok("the state diagram draws its start/end dots", more.startDot >= 2, String(more.startDot));
    ok("the class diagram draws a UML inheritance marker", more.umlTri);
    ok("the ER diagram draws crow's-foot marks", more.crow >= 1, String(more.crow));
    ok("the pie chart draws slices and a legend", more.slices >= 2 && more.legend >= 2, `slices=${more.slices} legend=${more.legend}`);
    ok("none of them are left as visible source", more.visibleSource === 0);
    /* ── 2b. the arrowheads ──────────────────────────────────────────── */
    console.log("\n──── the arrowheads ────");
    const head = await page.evaluate(() => {
      const m = document.querySelector("#log marker#mm-arrow");
      if (!m) return null;
      const p = m.querySelector("path");
      const d = (p && p.getAttribute("d")) || "";
      // The four y values of the barb, in viewBox units.
      const ys = (d.match(/,(\d+(?:\.\d+)?)/g) || []).map((v) => Number(v.slice(1)));
      const vb = (m.getAttribute("viewBox") || "").split(/\s+/).map(Number);
      return { d, ys, vb, units: m.getAttribute("markerUnits"), pts: (d.match(/L/g) || []).length };
    });
    ok("the edges carry an arrowhead", !!head);
    // Narrowed from both sides: the barb spans less than the full height of its
    // own box, and by the same margin top and bottom.
    if (head) {
      const top = Math.min(...head.ys), bot = Math.max(...head.ys), h = head.vb[3];
      ok("the head is narrowed from the top", top > 0.5, `y=${top} of ${h}`);
      ok("and by the same amount from the bottom", Math.abs((h - bot) - top) < 0.3,
        `top ${top}, bottom gap ${(h - bot).toFixed(2)}`);
      ok("so it is longer than it is wide", head.vb[2] > h, `${head.vb[2]}x${h}`);
      // Three L segments means a notch behind the tip - a swept barb rather
      // than a plain triangle, which has two.
      ok("and swept back to a notch rather than a flat triangle", head.pts === 3, String(head.pts));
      // Fixed size, or a thick edge gets a head three times everyone else's.
      ok("its size does not ride on the line's stroke width",
        head.units === "userSpaceOnUse", String(head.units));
    }

    /* ── 2c. opening a diagram larger ────────────────────────────────── */
    console.log("\n──── the diagram, larger ────");
    const inlineW = await page.evaluate(
      () => Math.round(document.querySelector("#log .mermaid-fig svg.mm-svg").getBoundingClientRect().width));
    ok("every figure offers a way to open it", await page.evaluate(() => {
      const figs = document.querySelectorAll("#log .mermaid-fig").length;
      return figs > 0 && document.querySelectorAll("#log .mermaid-fig [data-mm-zoom]").length === figs;
    }));
    ok("the viewer starts closed", await page.evaluate(() => document.getElementById("mmZoom").hidden));

    await page.click("#log .mermaid-fig [data-mm-zoom]");
    await page.waitForTimeout(120);
    const opened = await page.evaluate(() => {
      const wrap = document.getElementById("mmZoom");
      const svg = document.querySelector("#mmZoomBody svg");
      const b = svg ? svg.getBoundingClientRect() : null;
      return {
        open: !wrap.hidden,
        w: b ? Math.round(b.width) : 0,
        h: b ? Math.round(b.height) : 0,
        pct: document.getElementById("mmZoomPct").textContent,
        nodes: document.querySelectorAll("#mmZoomBody .mm-node").length,
        focused: document.activeElement && document.activeElement.id,
        // The transcript keeps its own copy; the viewer works on a clone.
        stillInLog: document.querySelectorAll("#log .mermaid-fig svg.mm-svg").length,
        figsInLog: document.querySelectorAll("#log .mermaid-fig").length,
      };
    });
    ok("clicking it opens the viewer", opened.open);
    ok("showing the same diagram", opened.nodes === 3, String(opened.nodes));
    ok("BIGGER than it was in the transcript", opened.w > inlineW,
      `${opened.w}px vs ${inlineW}px inline`);
    ok("scaled to fit rather than cropped", opened.h > 0 && opened.h <= 900, `${opened.h}px tall`);
    ok("the zoom level is stated", /%$/.test(opened.pct), opened.pct);
    ok("focus moves into the dialog", opened.focused === "mmZoomClose", String(opened.focused));

    /* THE CARD HAS TO STOP THE TRANSCRIPT BEHIND IT.
       Every --kx-surface-* token is a translucent white meant to layer ON a
       ground rather than to be one, so a card painted with one lets the
       conversation show through the diagram. That is invisible to every
       structural assertion above - it renders, it is the right size, it is in
       the right place - and obvious the moment anyone looks at it. Measured on
       the COMPUTED colour, which is the only thing that knows. */
    const ground = await page.evaluate(() => {
      const bg = getComputedStyle(document.querySelector(".mm-zoom-card")).backgroundColor;
      const m = bg.match(/rgba?\(([^)]+)\)/);
      const parts = m ? m[1].split(",").map((n) => parseFloat(n)) : [];
      return { bg, alpha: parts.length > 3 ? parts[3] : 1 };
    });
    ok("the card is an opaque ground, not a see-through wash",
      ground.alpha >= 0.9, `${ground.bg} (alpha ${ground.alpha})`);
    ok("and the transcript keeps its own copy",
      opened.stillInLog === opened.figsInLog && opened.figsInLog > 0,
      `${opened.stillInLog} of ${opened.figsInLog}`);

    const pctOf = () => page.evaluate(
      () => Number(document.getElementById("mmZoomPct").textContent.replace("%", "")));
    const widthOf = () => page.evaluate(
      () => Math.round(document.querySelector("#mmZoomBody svg").getBoundingClientRect().width));
    const before = await pctOf(), wBefore = await widthOf();
    await page.click('[data-mmz="in"]');
    await page.waitForTimeout(60);
    ok("zoom in enlarges it", (await widthOf()) > wBefore, `${wBefore} -> ${await widthOf()}`);
    ok("and says so", (await pctOf()) > before, `${before}% -> ${await pctOf()}%`);
    await page.click('[data-mmz="out"]');
    await page.waitForTimeout(60);
    // In then out returns exactly, because each step is computed from the
    // scale rather than compounded onto the rendered size.
    ok("zooming out again lands back where it started",
      Math.abs((await pctOf()) - before) <= 1, `${before}% -> ${await pctOf()}%`);

    // Tab wraps inside the card rather than walking out into a transcript the
    // backdrop is covering. aria-modal="true" is a claim; this is the check.
    await page.evaluate(() => document.querySelector('[data-mmz="close"]').focus());
    await page.keyboard.press("Tab");
    const wrapped = await page.evaluate(
      () => document.activeElement && document.activeElement.getAttribute("data-mmz"));
    ok("Tab from the last control wraps to the first", wrapped === "out", String(wrapped));
    await page.keyboard.down("Shift"); await page.keyboard.press("Tab"); await page.keyboard.up("Shift");
    const back = await page.evaluate(
      () => document.activeElement && document.activeElement.getAttribute("data-mmz"));
    ok("and Shift+Tab wraps back the other way", back === "close", String(back));

    // The close button, which lived in the transcript's click listener and so
    // never fired: only Escape used to shut this.
    await page.click('[data-mmz="close"]');
    await page.waitForTimeout(80);
    ok("the close button shuts it", await page.evaluate(
      () => document.getElementById("mmZoom").hidden));

    // The backdrop closes it; the card on top of the backdrop does not.
    await page.click("#log .mermaid-fig [data-mm-zoom]");
    await page.waitForTimeout(100);
    await page.click(".mm-zoom-card .mm-zoom-body", { position: { x: 4, y: 4 } });
    await page.waitForTimeout(60);
    ok("clicking inside the card keeps it open", await page.evaluate(
      () => !document.getElementById("mmZoom").hidden));
    await page.evaluate(() => document.getElementById("mmZoom").click());
    await page.waitForTimeout(60);
    ok("clicking the backdrop closes it", await page.evaluate(
      () => document.getElementById("mmZoom").hidden));

    // Reopen so the Escape path below is exercised from an open viewer.
    await page.click("#log .mermaid-fig [data-mm-zoom]");
    await page.waitForTimeout(100);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(80);
    const closed = await page.evaluate(() => ({
      hidden: document.getElementById("mmZoom").hidden,
      emptied: document.getElementById("mmZoomBody").childElementCount === 0,
      focused: document.activeElement && document.activeElement.hasAttribute("data-mm-zoom"),
    }));
    ok("Escape closes it", closed.hidden);
    ok("the clone is not left in the tree", closed.emptied);
    ok("and focus returns to the button that opened it", closed.focused);

    /* ── 3. restored transcript ──────────────────────────────────────── */
    console.log("\n──── reopened conversation ────");
    await send({
      type: "stateSync",
      state: {
        ...STATE.state,
        session: { id: "s2", title: "LIN frame layout", messages: [
          { role: "user", content: "explain the LIN diagnostic frame layout" },
          { role: "assistant", content: ANSWER },
        ] },
      },
    });
    await page.waitForTimeout(120);
    const restored = await page.evaluate(() => ({
      svg: document.querySelectorAll("#log .mermaid-fig svg.mm-svg").length,
      nodes: document.querySelectorAll("#log .mm-node").length,
    }));
    ok("a reopened conversation still draws the diagram", restored.svg === 1, String(restored.svg));
    ok("with its nodes intact", restored.nodes === 3, String(restored.nodes));

    /* ── 4. nothing threw, anywhere ──────────────────────────────────── */
    ok("no page error was raised at any point", boom.length === 0, boom.join(" | "));

    /* ── the picture ─────────────────────────────────────────────────── */
    // Streamed again so the shot shows the live path, prose and all.
    await send({
      type: "stateSync",
      state: {
        ...STATE.state,
        session: { id: "s3", title: "LIN frame layout", messages: [
          { role: "user", content: "explain the LIN diagnostic frame layout" },
          { role: "assistant", content: ANSWER + "\n" + DECISION + "\n\n" + SEQUENCE + "\n" },
        ] },
      },
    });
    await page.waitForTimeout(200);
    await page.screenshot({ path: OUT });
    console.log("\nscreenshot: " + OUT);

    // And one of the viewer open, because "you can see it bigger" is a visual
    // claim and the inline shot cannot make it.
    const ZOOM_OUT = OUT.replace(/\.png$/, "-zoomed.png");
    await page.click("#log .mermaid-fig [data-mm-zoom]");
    await page.waitForTimeout(220);
    await page.screenshot({ path: ZOOM_OUT });
    console.log("screenshot: " + ZOOM_OUT);
    await page.keyboard.press("Escape");

    await ctx.close();
  } finally {
    await browser.close();
    // The screenshot is the one thing worth keeping, so the directory goes only
    // when it holds nothing else.
    try { fs.unlinkSync(PAGE); } catch { /* best effort */ }
    if (!OUT.startsWith(WORK)) { try { fs.rmSync(WORK, { recursive: true, force: true }); } catch {} }
  }

  if (failures.length) { console.log(""); for (const f of failures) console.log("FAIL  " + f); }
  console.log(`\n──── ${pass} passed, ${failures.length} failed ────`);
  process.exit(failures.length ? 1 : 0);
})();
