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
const MEDIA = path.join(ROOT, "media");
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
          { role: "assistant", content: ANSWER + "\n" + DECISION + "\n" },
        ] },
      },
    });
    await page.waitForTimeout(200);
    await page.screenshot({ path: OUT });
    console.log("\nscreenshot: " + OUT);

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
