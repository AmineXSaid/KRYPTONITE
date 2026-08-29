/**
 * The panel as it is actually PAINTED, out of the archive we ship, at 200%.
 *
 * Every other UI suite here drives jsdom, which has no layout and no paint. It
 * will happily report that the composer exists, is the right colour and holds
 * the right controls while the shipped panel renders it invisible - which is
 * the bug that shipped: a composer whose floor computed to `transparent` looked
 * correct in every assertion and unreadable on screen.
 *
 * So this suite is deliberately the opposite of the others in three ways.
 *
 *   1. It reads MEDIA FROM THE .vsix, not from media/. A file excluded by a bad
 *      .vscodeignore is present on disk and absent for the user, and the whole
 *      point is to check what the user gets.
 *   2. It asserts COMPUTED and PAINTED values - resolved colours, real boxes,
 *      actual pixels - not the source text that was supposed to produce them.
 *   3. It runs at deviceScaleFactor 2, which is the reference the owner gave
 *      and the scale at which a half-pixel border either survives or does not.
 *
 * SKIPs rather than fails when there is no archive or no browser, matching
 * test/vsix.cjs: a developer without either should not be blocked, and CI has
 * both.
 *
 * Run: npm run package && node test/render.cjs
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const VSIX = path.join(ROOT, `${pkg.name}-${pkg.version}.vsix`);

if (!fs.existsSync(VSIX)) {
  console.log(`SKIP  ${path.basename(VSIX)} not built. Run: npm run package`);
  process.exit(0);
}

let chromium;
try {
  ({ chromium } = require("playwright-core"));
} catch {
  console.log("SKIP  playwright-core is not installed.");
  process.exit(0);
}

/** Where a browser might be. PLAYWRIGHT_BROWSERS_PATH first, then the usual. */
function findBrowser() {
  if (process.env.GENESIS_CHROME && fs.existsSync(process.env.GENESIS_CHROME)) {
    return process.env.GENESIS_CHROME;
  }
  // The default cache is where `npx playwright install` puts a browser when
  // PLAYWRIGHT_BROWSERS_PATH is unset, which is the normal case for a
  // developer and for CI. Without it this suite skipped on every machine that
  // had done nothing unusual - and a gate that always skips is not a gate.
  const home = os.homedir();
  const defaults = process.platform === "darwin"
    ? [path.join(home, "Library/Caches/ms-playwright")]
    : process.platform === "win32"
      ? [path.join(process.env.LOCALAPPDATA || home, "ms-playwright")]
      : [path.join(home, ".cache/ms-playwright")];
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, "/opt/pw-browsers", ...defaults]
    .filter(Boolean);
  for (const r of roots) {
    let names = [];
    try { names = fs.readdirSync(r); } catch { continue; }
    for (const n of names.filter((n) => n.startsWith("chromium")).sort().reverse()) {
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
if (!EXE) {
  console.log("SKIP  no Chromium found. Set GENESIS_CHROME or PLAYWRIGHT_BROWSERS_PATH.");
  process.exit(0);
}

let pass = 0;
const failures = [];
const ok = (label, cond, detail = "") => {
  if (cond) { pass++; return; }
  failures.push(label + (detail ? "  — " + detail : ""));
};

/* ── unpack the media the user actually installs ──────────────────────── */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "genesis-render-"));
execFileSync("unzip", ["-q", "-o", VSIX, "extension/media/*", "-d", tmp]);
const MEDIA = path.join(tmp, "extension/media");

const FONTS = [
  ["IBMPlexSans-Variable.woff2", "IBM Plex Sans", "100 700"],
  ["SpaceMono-Regular.woff2", "Space Mono", "400"],
  ["SpaceMono-Bold.woff2", "Space Mono", "700"],
  ["Michroma-Regular.woff2", "Michroma", "400"],
]
  .map(([f, fam, w]) =>
    `@font-face{font-family:'${fam}';font-style:normal;font-weight:${w};` +
    `font-display:block;src:url('fonts/${f}') format('woff2')}`)
  .join("");

// The workbench colour the panel is designed against. The panel paints NO
// ground of its own on purpose (see --kx-bg in tokens.css), so the harness has
// to supply the container the way VS Code does, or every foreground token is
// measured against white and the whole suite is meaningless.
const GROUND = "#181818";

// Mirrors src/ui/shell.ts. No CSP and no acquireVsCodeApi: the stub below is
// what the surface talks to instead.
const HTML = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<style>${FONTS}</style>
<link rel="stylesheet" href="webview/tokens.css">
<link rel="stylesheet" href="webview/sidebar.css">
<style>
  html { background: ${GROUND}; color-scheme: dark; }
  :root { --vscode-sideBar-background: ${GROUND}; }
</style>
</head><body><div id="root"></div>
<script>
  window.__sent = [];
  window.__kx = { api: { postMessage: function (m) { window.__sent.push(m); },
                         getState: function () { return null; },
                         setState: function () {} },
                  surface: "sidebar" };
</script>
<script src="webview/crystal.js"></script>
<script src="webview/sidebar.js"></script>
</body></html>`;

const HTML_PATH = path.join(MEDIA, "__render.html");
fs.writeFileSync(HTML_PATH, HTML);

// The other surface. Same shell, different stylesheet and script - mirrors
// shell() in src/ui/shell.ts, which builds both from one template.
const CC_HTML = HTML
  .replace("webview/sidebar.css", "webview/controlCenter.css")
  .replace("webview/sidebar.js", "webview/controlCenter.js")
  .replace('surface: "sidebar"', 'surface: "cc"');
const CC_PATH = path.join(MEDIA, "__render-cc.html");
fs.writeFileSync(CC_PATH, CC_HTML);

const BASE = {
  workspace: { open: true, name: "repo" },
  running: false,
  phase: "act",
  status: { state: "ok", label: "OK · ACT" },
  endpoint: "gw",
  profiles: [{ id: "gw", status: "ready", active: true, model: "claude-sonnet-4-6",
    wire: "anthropic", baseUrl: "https://x", capabilities: { contextWindow: 200000 } }],
  skills: [], skillWarnings: [], agents: [], agentWarnings: [], activeAgent: "",
  config: { ui: {} }, tlsError: null, rungs: [], tracing: false, todos: [],
  checkpoints: [], sessions: [], selection: null, context: null, changes: [],
  models: [{ group: "gw", models: ["claude-sonnet-4-6"] }], logs: [],
  session: { id: "s1", title: "New chat", messages: [] },
};

/** sRGB channels out of a computed `rgb()` / `rgba()` string. */
function rgb(s) {
  const m = /rgba?\(([^)]+)\)/.exec(s || "");
  if (!m) return null;
  const p = m[1].split(",").map((x) => parseFloat(x));
  return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
}
/** WCAG relative luminance. */
function lum({ r, g, b }) {
  const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
/** Source-over composite of `fg` (possibly translucent) onto opaque `bg`. */
function over(fg, bg) {
  const a = fg.a === undefined ? 1 : fg.a;
  return { r: fg.r * a + bg.r * (1 - a),
           g: fg.g * a + bg.g * (1 - a),
           b: fg.b * a + bg.b * (1 - a), a: 1 };
}
function contrast(a, b) {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });

  async function open(width, state, opts = {}) {
    const ctx = await browser.newContext({
      viewport: { width, height: 640 },
      deviceScaleFactor: 2, // 200%, the reference the owner gave
      colorScheme: "dark",
      // Only the menu-entrance suite passes this. Every other caller runs at
      // the default, so the panel is measured the way it is normally seen.
      ...(opts.reducedMotion ? { reducedMotion: "reduce" } : {}),
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    await page.goto("file://" + HTML_PATH);
    await page.evaluate(
      (s) => window.dispatchEvent(new MessageEvent("message", { data: { type: "stateSync", state: s } })),
      { ...BASE, ...state }
    );
    await page.waitForTimeout(400);
    return { ctx, page, errors };
  }

  /* ── 1. the panel renders at all ───────────────────────────────────── */
  {
    const { ctx, page, errors } = await open(400, {});
    ok("the shipped panel boots with no script error", errors.length === 0, errors.slice(0, 2).join(" | "));

    const header = page.locator(".kx-header");
    ok("the header renders", (await header.count()) === 1);
    const wordmark = await page.locator(".kx-wordmark").first().textContent();
    ok("the wordmark reads GENESIS", /genesis/i.test(wordmark || ""), wordmark);

    // Michroma is the brand face and fails SILENTLY: a missing woff2 falls back
    // to a system sans and the header still reads "GENESIS", just in the wrong
    // typeface. Nothing but a real font stack can catch that.
    const fam = await page.locator(".kx-wordmark").first()
      .evaluate((el) => getComputedStyle(el).fontFamily);
    ok("and is set in the brand face", /michroma/i.test(fam), fam);

    const tabs = await page.locator(".kx-tabs [role='tab'], .kx-tabs button").allTextContents();
    const flat = tabs.join(" ").toUpperCase();
    for (const t of ["SESSION", "MCP", "AGENTS", "DIAGNOSTICS"]) {
      ok(`the ${t} tab is present`, flat.includes(t), flat.trim());
    }
    await ctx.close();
  }

  /* ── 2. the composer has a floor ───────────────────────────────────── */
  {
    const { ctx, page } = await open(400, {});
    const composer = page.locator(".composer").first();
    ok("the composer renders", (await composer.count()) === 1);

    const bg = rgb(await composer.evaluate((el) => getComputedStyle(el).backgroundColor));
    // THE REGRESSION THIS FILE EXISTS FOR. A `background` whose var() fails to
    // resolve is invalid at computed-value time and computes to transparent,
    // so the panel shows straight through the composer. jsdom cannot see it.
    //
    // The floor is deliberately a WASH - a few percent of white over whatever
    // the workbench is painting - so that the panel is one family of one colour
    // in every theme. So the test is not "is it opaque", which would fail the
    // design; it is "does any of it land", and then whether what lands is
    // actually visible once composited over the container.
    ok("and it is not fully transparent", !!bg && bg.a > 0, JSON.stringify(bg));

    const ground = { r: parseInt(GROUND.slice(1, 3), 16),
                     g: parseInt(GROUND.slice(3, 5), 16),
                     b: parseInt(GROUND.slice(5, 7), 16), a: 1 };
    const floor = over(bg, ground);
    ok("and once composited it is a different colour from the ground",
      Math.abs(lum(floor) - lum(ground)) > 0.001,
      `composer ${JSON.stringify(bg)} over ${GROUND} -> rgb(${floor.r.toFixed(0)},${floor.g.toFixed(0)},${floor.b.toFixed(0)})`);

    // The placeholder is the only thing in an empty composer, so if it does not
    // clear the floor the control reads as broken rather than as empty.
    const ph = await page.locator("#draft").evaluate((el) => getComputedStyle(el, "::placeholder").color);
    const phc = rgb(ph);
    if (phc) {
      // Against the COMPOSITED floor, which is what a reader's eye lands on.
      const seen = over(phc, floor);
      ok("the placeholder clears 3:1 against that floor",
        contrast(seen, floor) >= 3, contrast(seen, floor).toFixed(2) + ":1");
    } else ok("the placeholder colour resolves", false, ph);
    await ctx.close();
  }

  /* ── 3. the phase control, as the reference draws it ───────────────── */
  {
    const { ctx, page } = await open(400, {});
    const segs = page.locator("#phaseSeg [data-phase]");
    const labels = (await segs.allTextContents()).map((s) => s.trim().toUpperCase());
    ok("all three phases are offered", labels.join(",") === "ASK,PLAN,ACT", labels.join(","));

    const on = page.locator('#phaseSeg [data-phase][data-on="1"]');
    ok("exactly one is lit", (await on.count()) === 1, String(await on.count()));
    ok("and it is the phase the state named",
      (await on.first().getAttribute("data-phase")) === "act");

    // The lit segment has to differ from its neighbours by more than a label,
    // or the control cannot be read at a glance.
    const litBg = rgb(await on.first().evaluate((el) => getComputedStyle(el).backgroundColor));
    const offBg = rgb(await page.locator('#phaseSeg [data-phase="ask"]')
      .evaluate((el) => getComputedStyle(el).backgroundColor));
    ok("the lit phase is painted differently from an unlit one",
      !!litBg && !!offBg && (litBg.a > 0.5) && JSON.stringify(litBg) !== JSON.stringify(offBg),
      `${JSON.stringify(litBg)} vs ${JSON.stringify(offBg)}`);

    const litFg = rgb(await on.first().evaluate((el) => getComputedStyle(el).color));
    ok("and its label is readable on it",
      !!litFg && !!litBg && contrast(litFg, litBg) >= 4.5,
      litFg && litBg ? contrast(litFg, litBg).toFixed(2) + ":1" : "");
    await ctx.close();
  }

  /* ── 4. the mark turns ─────────────────────────────────────────────── */
  {
    const { ctx, page } = await open(400, {});
    const mark = page.locator(".welcome .crystal").first();
    ok("the welcome mark renders", (await mark.count()) === 1);

    const anim = await mark.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { name: cs.animationName, count: cs.animationIterationCount,
               duration: cs.animationDuration, timing: cs.animationTimingFunction,
               delay: cs.animationDelay };
    });
    // TWO animations now, and the pair is the design: a finite eased entrance
    // in front of the endless linear turn it settles into. These used to read
    // `name === "g-sweep"`, `count === "infinite"` and `timing === "linear"`,
    // which described the mark correctly right up until it grew an arrival -
    // so they are not relaxed here, they are re-aimed at each phase, and the
    // motion itself is measured in section 5f rather than inferred from names.
    // Split on TOP-LEVEL commas only: `cubic-bezier(0.15, 0.45, 0.4, 0.985)`
    // carries three of its own, and a naive split reports five phases.
    const phases = (v) => {
      const out = []; let depth = 0, cur = "";
      for (const ch of String(v || "")) {
        if (ch === "(") depth++;
        else if (ch === ")") depth--;
        if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; continue; }
        cur += ch;
      }
      if (cur.trim()) out.push(cur.trim());
      return out;
    };
    const [entrance, steady] = [phases(anim.name), phases(anim.count)];
    ok("it runs two animations: an entrance and the turn it settles into",
      entrance.length === 2, anim.name);
    ok("the entrance runs exactly once", steady[0] === "1", anim.count);
    ok("and the turn behind it never stops", steady[1] === "infinite", anim.count);
    const timings = phases(anim.timing);
    ok("the entrance is eased, which is what makes it decelerate",
      /cubic-bezier/.test(timings[0] || ""), anim.timing);
    // Linear, still, and for the reason it always was: a curve on an infinite
    // rotation stutters at the wrap where one turn meets the next.
    ok("while the turn it settles into stays linear", timings[1] === "linear", anim.timing);
    const durs = phases(anim.duration || "");
    ok("and that turn is the slow 6s one", durs[1] === "6s", anim.duration);

    // The computed style only says an animation was DECLARED. Whether the mark
    // moves is a question about pixels, and it is the question the owner asked.
    // locator.screenshot() waits for the element to be stable and would time
    // out here, which is why this clips the page instead.
    const box = await mark.boundingBox();
    const shot = async () =>
      (await page.screenshot({ clip: box, animations: "allow" })).toString("base64");
    const a = await shot();
    await page.waitForTimeout(700); // 42 degrees of a 6s turn
    const b = await shot();
    await page.waitForTimeout(700);
    const c = await shot();
    ok("and the painted mark actually moves", a !== b && b !== c, "sampled 3 frames 700ms apart");

    // Same page, motion off: the pixels must settle.
    await ctx.close();
    const ctx2 = await browser.newContext({
      viewport: { width: 400, height: 640 }, deviceScaleFactor: 2,
      colorScheme: "dark", reducedMotion: "reduce",
    });
    const p2 = await ctx2.newPage();
    await p2.goto("file://" + HTML_PATH);
    await p2.evaluate((s) => window.dispatchEvent(new MessageEvent("message",
      { data: { type: "stateSync", state: s } })), BASE);
    await p2.waitForTimeout(400);
    const m2 = p2.locator(".welcome .crystal").first();
    const box2 = await m2.boundingBox();
    const s1 = (await p2.screenshot({ clip: box2, animations: "allow" })).toString("base64");
    await p2.waitForTimeout(700);
    const s2 = (await p2.screenshot({ clip: box2, animations: "allow" })).toString("base64");
    ok("and it holds still for a reader who asked for no motion", s1 === s2);
    await ctx2.close();
  }

  /* ── 5. nothing overflows, at either width ─────────────────────────── */
  {
    // 300px is narrower than the panel is ever likely to be docked, which is
    // the point: it forces the composer's control row to wrap. The reference
    // shows that wrap as two tidy rows, not as a control pushed off-screen.
    for (const width of [400, 300]) {
      const { ctx, page } = await open(width, {});
      const over = await page.evaluate(() => {
        const de = document.documentElement;
        return { scroll: de.scrollWidth, client: de.clientWidth };
      });
      ok(`nothing spills sideways at ${width}px`,
        over.scroll <= over.client + 1, `scrollWidth ${over.scroll} > clientWidth ${over.client}`);

      // Every control in the composer must still be inside the panel.
      const strays = await page.evaluate(() => {
        const w = document.documentElement.clientWidth;
        const out = [];
        document.querySelectorAll(".composer button, .composer .seg, #draft").forEach((el) => {
          const r = el.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) return;
          if (r.left < -1 || r.right > w + 1) out.push((el.id || el.className) + " " + Math.round(r.left) + ".." + Math.round(r.right));
        });
        return out;
      });
      ok(`every composer control is within the panel at ${width}px`,
        strays.length === 0, strays.slice(0, 3).join(", "));
      await ctx.close();
    }
  }

  /* ── 5b. the composer hint survives a narrow dock ──────────────────── */
  {
    // At a narrow dock width the placeholder wraps. It must wrap BEFORE the
    // bracket, carrying the hint to the next line whole - it used to break at
    // any space and leave ")" alone on the second line. The spaces inside the
    // hint are non-breaking, which is what makes it one unbreakable run.
    const { ctx, page } = await open(260, {});
    const ph = await page.locator("#draft").getAttribute("placeholder");
    ok("the composer hint is present", /skills/.test(ph || "") && /files/.test(ph || ""), ph);
    const hint = (ph || "").slice((ph || "").indexOf("("));
    ok("and it contains no breaking space, so it cannot be split",
      hint.length > 0 && !/ /.test(hint), JSON.stringify(hint));
    ok("while the text before it still wraps normally",
      / /.test((ph || "").slice(0, (ph || "").indexOf("("))));

    // The transcript has a deliberate 268px floor and scrolls sideways below
    // it (see the note above #log in sidebar.css). The COMPOSER is explicitly
    // excluded from that floor, because the send button going off-screen was
    // worse than the reflow it prevented. Assert the exclusion holds.
    const send = await page.locator("#sendBtn").boundingBox();
    const cw = await page.evaluate(() => document.documentElement.clientWidth);
    ok("the send button stays on screen below the transcript floor",
      !!send && send.x >= 0 && send.x + send.width <= cw + 1,
      send ? `${Math.round(send.x)}..${Math.round(send.x + send.width)} in ${cw}` : "no box");
    await ctx.close();
  }

  /* ── 5c. what the composer gives up, and in what order ─────────────── */
  {
    // Section 5 asks whether anything escaped the panel. Nothing did, at 280px,
    // and the row was still wrong: the phase segment and the mode button kept
    // the first line while attach and send wrapped to a second one on their
    // own, hugged right, with the whole left half of the composer empty. A
    // control inside the panel can still be in the wrong place, so this asks
    // WHICH item wraps rather than whether one fell off.
    const { ctx, page } = await open(280, {});
    const rows = await page.evaluate(() => {
      const tb = document.querySelector(".toolbar");
      const kids = [...tb.children].filter((e) => getComputedStyle(e).display !== "none");
      // Grouped by the vertical band each sits in, not by `top`: the row is
      // centre-aligned, so a 23px segment and a 30px button on the SAME line
      // have different tops and would otherwise read as two rows.
      const mid = (e) => { const r = e.getBoundingClientRect(); return (r.top + r.bottom) / 2; };
      const bands = [];
      for (const e of kids) {
        const m = mid(e);
        let b = bands.find((x) => Math.abs(x.mid - m) < 8);
        if (!b) bands.push((b = { mid: m, names: [] }));
        b.names.push(e.id || e.className.split(" ")[0]);
      }
      bands.sort((a, b) => a.mid - b.mid);
      return bands.map((b) => b.names);
    });
    // -1 for both sides would make "same row" trivially true, so the probe
    // has to find each control before it can compare them.
    const rowOf = (name) => rows.findIndex((r) => r.includes(name));
    for (const n of ["phaseSeg", "modelBtn", "tb-actions"]) {
      ok(`the toolbar still has ${n} to place`, rowOf(n) >= 0, JSON.stringify(rows));
    }
    ok("the composer toolbar wraps at 280px rather than crushing every control",
      rows.length >= 2, JSON.stringify(rows));
    // The heart of it. `.tb-actions` exists so a wrap does not orphan send by
    // itself; it must not be orphaned as a PAIR either.
    ok("and send and attach stay on the row with the phase segment",
      rowOf("tb-actions") === rowOf("phaseSeg"), JSON.stringify(rows));
    ok("while the model button is what moves to the second row",
      rowOf("modelBtn") > rowOf("phaseSeg"), JSON.stringify(rows));
    ok("which leaves no row carrying nothing but the two action buttons",
      !rows.some((r) => r.length === 1 && r[0] === "tb-actions"), JSON.stringify(rows));
    await ctx.close();
  }
  {
    // The model name at an ordinary dock width, measured as CHARACTERS that
    // actually reach a reader rather than as a box width.
    //
    // It rendered "claud…" here. Every model this extension is pointed at
    // begins that way, so the visible text told two different models apart not
    // at all - and a truncation that stops before the first distinguishing
    // character is the same as showing no name. The bar is therefore not "does
    // it fit" but "is what fits longer than the prefix these ids share".
    const SHARED = "claude-".length;
    for (const width of [360, 400]) {
      const { ctx, page } = await open(width, {});
      const seen = await page.evaluate(() => {
        const el = document.getElementById("modelName");
        const box = el.getBoundingClientRect();
        const text = el.textContent || "";
        // Walk the text node and count the characters whose own box ends
        // inside the element's. Reading `textContent` would count the ones the
        // ellipsis is hiding, which is exactly the mistake being tested for.
        const node = el.firstChild;
        if (!node || node.nodeType !== 3) return { n: text.length, text };
        const r = document.createRange();
        let n = 0;
        for (let i = 1; i <= text.length; i++) {
          r.setStart(node, i - 1); r.setEnd(node, i);
          if (r.getBoundingClientRect().right <= box.right + 0.5) n = i; else break;
        }
        return { n, text };
      });
      ok(`the model name is legible past the shared prefix at ${width}px`,
        seen.n > SHARED,
        `${seen.n} of ${seen.text.length} characters of "${seen.text}" reach the panel`);
      await ctx.close();
    }
  }

  /* ── 5d. the MCP tab at a narrow dock ──────────────────────────────── */
  {
    // Neither of these was catchable from the document's scroll width, which is
    // why section 5's probe reported clean while both were on screen and wrong.
    // `.mcp-wrap` is a scroll container, so a button past its right edge is
    // CLIPPED rather than pushing the page - it simply is not there, with no
    // scrollbar to say it exists. And an overlap costs no width at all.
    const { ctx, page } = await open(280, {
      mcp: { warnings: [], servers: [
        { name: "confluence", state: "ready", command: "confluence-mcp", approval: "ask",
          readOnly: true, toolCount: 5, tools: ["confluence_search", "confluence_get_page"],
          serverInfo: { name: "confluence-mcp", version: "1.0.0" } },
        { name: "gitlab-remote", state: "failed", command: "https://mcp.example.internal/mcp",
          approval: "ask", readOnly: true, toolCount: 0, tools: [],
          error: "connect ECONNREFUSED 10.4.2.9:443" },
      ] },
    });
    await page.click("#tabMcp");
    await page.waitForTimeout(250);

    const mcp = await page.evaluate(() => {
      const wrap = document.querySelector(".mcp-wrap");
      const head = document.querySelector(".mcp-head");
      const edge = Math.min(document.documentElement.clientWidth,
        wrap.getBoundingClientRect().right);
      const clipped = [...head.querySelectorAll(".btn")]
        .filter((b) => b.getBoundingClientRect().right > edge + 0.5)
        .map((b) => b.textContent.trim());
      // A tool count painted on top of a pill. Text over a control, not merely
      // a tight row - and invisible to any width measurement.
      const hits = [];
      document.querySelectorAll(".mcp-row").forEach((row) => {
        const c = row.querySelector(".count");
        if (!c) return;
        const cb = c.getBoundingClientRect();
        row.querySelectorAll(".mcp-pill, .mcp-ro").forEach((p) => {
          const pb = p.getBoundingClientRect();
          if (cb.left < pb.right - 0.5 && cb.right > pb.left + 0.5 &&
              cb.top < pb.bottom - 0.5 && cb.bottom > pb.top + 0.5) {
            hits.push(row.querySelector(".nm").textContent + " over " + p.textContent.trim());
          }
        });
      });
      const cap = document.querySelector(".mcp-cap");
      return { clipped, hits, sideways: wrap.scrollWidth > wrap.clientWidth + 1,
        capH: cap ? Math.round(cap.getBoundingClientRect().height) : -1 };
    });

    ok("both MCP header actions are reachable at 280px",
      mcp.clipped.length === 0, "clipped: " + JSON.stringify(mcp.clipped));
    ok("and the server list does not scroll sideways to hide them", !mcp.sideways);
    ok("no tool count is painted over a status or read-only pill",
      mcp.hits.length === 0, JSON.stringify(mcp.hits));
    // "SERVERS" and "· 4 configured" are one caption. As two flex siblings the
    // phrase broke between the dot and the word, which reads as two facts.
    ok("the servers caption stays on one line", mcp.capH > 0 && mcp.capH < 26,
      "caption height " + mcp.capH);
    await ctx.close();
  }

  /* ── 5e. one right gutter per tab ──────────────────────────────────── */
  {
    // The active-agent bar's stop control sat 8px from the panel edge while
    // "New agent" and every "Open" directly beneath it sat at 14px. Six pixels
    // is small on its own and obvious in a column: three right-aligned
    // controls stacked vertically, one of them out of line.
    const { ctx, page } = await open(360, {
      agents: [
        { name: "reviewer", description: "Reads a diff.", model: "", memory: "",
          tools: ["read_file"], skills: [], allMcp: true, mcp: [],
          file: ".agent/agents/reviewer.md", active: true },
      ],
      activeAgent: "reviewer",
    });
    await page.click("#tabAgents");
    await page.waitForTimeout(250);
    const gutters = await page.evaluate(() => {
      const w = document.documentElement.clientWidth;
      const seen = {};
      // The tab's own controls, PLUS the active-agent bar - which lives in the
      // shell rather than inside #viewAgents, and is precisely the control that
      // was out of line. Selecting only the view would have measured three
      // buttons that already agreed and reported a clean gutter.
      //
      // The panel header's icon buttons are excluded on purpose: they are
      // borderless and carry their own optical inset, which is a different
      // measurement from a bordered control's box.
      document.querySelectorAll("#viewAgents button, .agent-bar button").forEach((b) => {
        const r = b.getBoundingClientRect();
        if (!r.width || !r.height) return;
        const gap = Math.round(w - r.right);
        if (gap > 40) return; // not a right-aligned control
        (seen[gap] = seen[gap] || []).push((b.textContent || b.id).trim().slice(0, 14));
      });
      return seen;
    });
    const values = Object.keys(gutters);
    ok("every right-aligned control on the Agents tab shares one right gutter",
      values.length === 1, JSON.stringify(gutters));
    await ctx.close();
  }

  /* ── 5f. the welcome mark arrives spinning, and settles ────────────── */
  {
    // A motion bug is invisible to a screenshot and to every static
    // assertion, so this samples the real transform matrix over two seconds
    // and reads the angle out of it.
    //
    // The one it exists for actually happened. The steady turn is a second
    // animation layered behind the entrance, and `g-sweep` declares only a
    // `to` - so its implicit start resolved to the entrance's filled 720deg
    // and the mark handed off into rotating BACKWARDS at 120deg/s, forever.
    // Both keyframe sets read as correct on their own; only the composition
    // is wrong, and only a measurement can see it.
    const { ctx, page } = await open(400, {});
    const spin = await page.evaluate(() => new Promise((resolve) => {
      const el = document.querySelector(".welcome .crystal");
      if (!el) return resolve({ err: "no mark on the welcome screen" });
      const anims = el.getAnimations();
      if (!anims.length) return resolve({ err: "the mark is not animated" });
      // Restart from a known zero: the harness has already waited, so the
      // entrance would otherwise be sampled half-finished.
      anims.forEach((a) => { a.cancel(); a.play(); });
      const t0 = performance.now();
      const out = [];
      let turns = 0, prev = null;
      (function tick() {
        const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
        let a = Math.atan2(m.b, m.a) * 180 / Math.PI;
        // atan2 wraps at 180; unwrap so the angle keeps climbing past a turn.
        if (prev !== null && a - prev < -180) turns++;
        prev = a;
        out.push({ t: performance.now() - t0, deg: a + turns * 360 });
        if (performance.now() - t0 < 2100) requestAnimationFrame(tick);
        else resolve({ samples: out });
      })();
    }));

    if (spin.err) {
      ok("the welcome mark is animated", false, spin.err);
    } else {
      const r = spin.samples;
      const at = (ms) => r.reduce((b, x) => (Math.abs(x.t - ms) < Math.abs(b.t - ms) ? x : b), r[0]);
      const vel = (ms, win = 120) =>
        (at(ms + win / 2).deg - at(ms - win / 2).deg) / ((at(ms + win / 2).t - at(ms - win / 2).t) / 1000);

      // THE REGRESSION. Any frame lower than the one before it is the mark
      // going the wrong way; the tolerance is for sampling noise, not for a
      // little reversal being acceptable.
      const back = r.filter((x, i) => i && x.deg < r[i - 1].deg - 1);
      ok("the mark never rotates backwards", back.length === 0,
        back.length ? `${back.length} frames, first at ${Math.round(back[0].t)}ms` : "");

      // Position continuity. The entrance has to end on a whole number of
      // turns or the handoff to the steady turn is a visible jump.
      const landed = at(1000).deg;
      ok("the entrance lands on a whole number of turns",
        Math.abs(landed % 360) < 6 || Math.abs((landed % 360) - 360) < 6,
        `${landed.toFixed(1)}deg after the entrance`);

      // Rate continuity, the other half. The entrance's last measured speed
      // has to be near the steady turn's 60deg/s, or the mark stops dead and
      // starts again.
      const tail = vel(930);
      const steady = vel(1600);
      ok("and hands off at close to the steady rate",
        Math.abs(tail - 60) < 45, `tail ${Math.round(tail)}deg/s vs steady 60`);
      ok("the steady turn afterwards is the 6s one, forwards",
        steady > 40 && steady < 80, `${Math.round(steady)}deg/s`);

      // It is an ENTRANCE: it has to be much faster than what it settles into,
      // or there is no transition to see.
      let peak = 0;
      for (let ms = 50; ms < 500; ms += 25) peak = Math.max(peak, vel(ms));
      ok("the entrance is much faster than the turn it settles into",
        peak > 8 * steady, `peak ${Math.round(peak)}deg/s vs steady ${Math.round(steady)}`);

      // And not SO fast that it aliases. The bezel repeats every 90deg, so a
      // frame that advances it more than 45 reverses its apparent direction -
      // the wagon-wheel effect, which reads as a strobe rather than a spin.
      ok("but slow enough to read as a spin rather than a strobe",
        peak / 60 < 45, `${(peak / 60).toFixed(1)}deg per frame at 60Hz`);
    }
    // ARRIVAL ONLY. `renderWelcome` runs on a data refresh as well as on a
    // real arrival, and a session list landing under the panel used to redraw
    // the whole screen. With an entrance attached that would throw the logo
    // across the screen while the user is reading it - which is exactly why
    // the flag this asserts was removed once and had to come back.
    const refreshed = await page.evaluate(() => {
      window.dispatchEvent(new MessageEvent("message", {
        data: { type: "sessionsListed", sessions: [] },
      }));
      const el = document.querySelector(".welcome .crystal");
      return { present: !!el, spins: !!el && el.classList.contains("spin-in") };
    });
    ok("a session list arriving still redraws the welcome", refreshed.present);
    ok("but does not replay the entrance", !refreshed.spins);
    await ctx.close();
  }

  /* ── 5g. menus arrive, they do not appear ──────────────────────────── */
  {
    // The mode sheet was the only thing in the panel that arrived. The model
    // picker, the / and @ pickers and both header menus flipped from hidden to
    // visible on one frame - and those are the ones opened constantly, so the
    // polish had landed on the least-used surface.
    //
    // Sampled rather than read off the stylesheet, because these are keyframe
    // animations triggered by an element ceasing to be display:none. Whether
    // that actually restarts the animation is a browser behaviour, not a
    // property of the CSS, and a declaration that never runs looks identical
    // to one that does in the computed style.
    const MENUS = [
      ["the model picker", "#qp", async (p) => p.click("#modelBtn")],
      ["the slash picker", "#qp", async (p) => { await p.click("#draft"); await p.type("#draft", "/"); }],
      ["the history menu", "#historyPop", async (p) => p.click("#histBtn")],
      ["the more menu", "#morePop", async (p) => p.click("#moreBtn")],
    ];

    /** Open one menu and watch its top edge and opacity for half a second. */
    async function watch(page, sel, act) {
      await page.evaluate((s) => {
        window.__s = [];
        (function tick() {
          const el = document.querySelector(s);
          if (el && !el.hidden) {
            const r = el.getBoundingClientRect();
            window.__s.push({ top: r.top, op: +getComputedStyle(el).opacity });
          }
          if (window.__s.length < 48) requestAnimationFrame(tick);
        })();
      }, sel);
      await act(page);
      await page.waitForTimeout(450);
      const s = await page.evaluate(() => window.__s);
      if (!s.length) return null;
      const tops = s.map((x) => x.top), ops = s.map((x) => x.op);
      return {
        moved: Math.max(...tops) - Math.min(...tops),
        faded: Math.max(...ops) - Math.min(...ops),
        frames: s.length,
      };
    }

    for (const [name, sel, act] of MENUS) {
      const { ctx, page } = await open(400, {
        sessions: [{ id: "a", title: "an earlier chat", when: "7m ago", count: 4 }],
        skills: [{ name: "review", description: "Review a diff", enabled: true }],
      });
      const m = await watch(page, sel, act);
      ok(`${name} opens at all`, !!m, sel);
      if (m) {
        ok(`${name} travels into place rather than appearing`, m.moved > 2,
          `${m.moved.toFixed(1)}px over ${m.frames} frames`);
        ok(`${name} fades in with it`, m.faded > 0.5, m.faded.toFixed(2));
      }
      await ctx.close();
    }
  }
  {
    // AND THE OVERRIDE ACTUALLY WINS. This is the bug that was nearly shipped:
    // the reduced-motion block was written beside the keyframes, hundreds of
    // lines ABOVE `.qp`'s own rule - and a media query does not raise
    // specificity, so `.qp` kept its travel with motion turned off. Reading
    // the CSS shows a correct-looking block either way; only running it at the
    // setting tells you which rule won.
    const { ctx, page } = await open(400, {}, { reducedMotion: true });
    const m = await page.evaluate(async () => {
      window.__s = [];
      (function tick() {
        const el = document.querySelector("#qp");
        if (el && !el.hidden) {
          const r = el.getBoundingClientRect();
          window.__s.push({ top: r.top, op: +getComputedStyle(el).opacity });
        }
        if (window.__s.length < 48) requestAnimationFrame(tick);
      })();
      document.getElementById("modelBtn").click();
      await new Promise((r) => setTimeout(r, 450));
      const s = window.__s;
      if (!s.length) return null;
      const tops = s.map((x) => x.top), ops = s.map((x) => x.op);
      return { moved: Math.max(...tops) - Math.min(...tops),
               faded: Math.max(...ops) - Math.min(...ops) };
    });
    ok("with motion reduced, the menu still opens", !!m);
    if (m) {
      ok("and does not travel", m.moved < 1.5, `${m.moved.toFixed(1)}px`);
      // Not silence. A menu that materialises with no change at all is the
      // abruptness the entrance exists to remove, and reduced motion asks not
      // to be MOVED rather than not to be shown anything.
      ok("but still fades, so it is not back to appearing", m.faded > 0.5, m.faded.toFixed(2));
    }
    await ctx.close();
  }

  /* ── 5h. the mode sheet is a modal, and behaves like one ───────────── */
  {
    // It renders as role="dialog" aria-modal="true", which promises the rest
    // of the panel is unreachable while it is up. It kept none of that: focus
    // never entered it, 8 of 12 Tabs left it, and Escape did nothing. The
    // first two Tabs landed on attach and send BEHIND the scrim, where Enter
    // posted the message - so a keyboard user sent something they never wrote.
    //
    // Only a real browser can test this. jsdom has no sequential focus
    // navigation, so Tab moves nothing there and every assertion below would
    // pass against a completely broken trap.
    const { ctx, page } = await open(400, {});
    const inCard = () => page.evaluate(() => {
      const card = document.querySelector("#permPop .perm-card");
      return !!(card && document.activeElement && card.contains(document.activeElement));
    });

    await page.click("#permBtn");
    await page.waitForTimeout(450);
    ok("opening the mode sheet moves focus into it", await inCard(),
      await page.evaluate(() => document.activeElement.className || document.activeElement.id));
    // On the mode in force, not on the close button: that is the question the
    // sheet is open to answer.
    ok("and onto the mode currently in force",
      await page.evaluate(() => (document.activeElement.getAttribute("data-on") === "1")));

    // Twelve, because that is more than the sheet holds - a trap that merely
    // has enough members to outlast a short walk is not a trap.
    const trail = [];
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press("Tab");
      trail.push(await inCard());
    }
    ok("and Tab never leaves it", trail.every(Boolean),
      `${trail.filter((x) => !x).length} of 12 landed outside`);

    // Both directions: Shift+Tab off the first member has its own wrap.
    const back = [];
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press("Shift+Tab");
      back.push(await inCard());
    }
    ok("nor does Shift+Tab", back.every(Boolean),
      `${back.filter((x) => !x).length} of 8 landed outside`);

    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);
    ok("Escape closes it", await page.evaluate(() => document.getElementById("permPop").hidden));
    ok("and hands focus back to the button that opened it",
      await page.evaluate(() => document.activeElement.id === "permBtn"),
      await page.evaluate(() => document.activeElement.id));
    await ctx.close();
  }
  {
    // THE CONSEQUENCE, not the mechanism. Every assertion above could be
    // satisfied by a trap that is subtly wrong; this one reproduces what
    // actually went wrong and asserts the harm does not happen.
    const { ctx, page } = await open(400, {});
    await page.click("#draft");
    await page.type("#draft", "a message the user never meant to send");
    await page.evaluate(() => { window.__sent.length = 0; });
    await page.click("#permBtn");
    await page.waitForTimeout(450);
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    const sent = await page.evaluate(() => window.__sent.map((m) => m.type));
    ok("Tab and Enter inside the sheet cannot send the draft",
      !sent.includes("sendMessage"), JSON.stringify(sent));
    // And it is not inert in the other direction: choosing a mode still works.
    ok("while choosing a mode still reaches the host",
      sent.includes("setConfig"), JSON.stringify(sent));
    await ctx.close();
  }

  /* ── 5i. every header glyph actually paints ────────────────────────── */
  {
    // A glyph is drawn as <use href="#i-foo">. If the symbol is missing - a
    // rename that missed a call site, a typo - the browser reports NO error:
    // the shadow tree is simply empty and the button renders as blank space of
    // exactly the right size. Nothing else in the suite can see that, because
    // every layout and contrast assertion still passes over an empty button.
    // getBBox() on the <use> is the instrument that can: it is 0x0 when the
    // reference dangles and the glyph's extent when it does not.
    const { ctx, page } = await open(400, {});

    for (const [id, label] of [["#newBtn", "new chat"], ["#histBtn", "history"], ["#moreBtn", "more"]]) {
      const box = await page.locator(id + " use").evaluate((u) => {
        const b = u.getBBox();
        return { w: b.width, h: b.height, href: u.getAttribute("href") || "" };
      });
      ok(`the ${label} glyph resolves to a defined symbol`,
        box.w > 0 && box.h > 0, `${box.href} drew ${box.w}x${box.h}`);
    }

    // The three glyphs must also differ from each other. Two buttons pointing
    // at the same symbol is the other half of a botched rename, and every
    // reference resolves, so the check above passes clean.
    //
    // Scoped to the three buttons, NOT to `.kx-header use`: the header also
    // contains the crystal mark and both popovers, and the two Export rows
    // there share `i-download` on purpose because they are the same verb.
    const hrefs = await page.locator("#newBtn use, #histBtn use, #moreBtn use").evaluateAll(
      (us) => us.map((u) => u.getAttribute("href")));
    ok("and no two header buttons share a glyph",
      new Set(hrefs).size === hrefs.length, hrefs.join(" "));

    // The distinction the ICON_DEFS comment describes, pinned so that a later
    // "these are both clocks, merge them" cannot quietly undo it. A bare dial
    // means TIME - correct on the queue, which really is waiting. History
    // needs the return arrow, which is what carries "back".
    ok("history is not the plain clock",
      !hrefs.includes("#i-clock"), hrefs.join(" "));

    await ctx.close();
  }

  /* ── 5j. no icon() call names a symbol that does not exist ─────────── */
  {
    // 5i covers the three buttons a rendered panel shows. This covers every
    // other glyph in the file, including those in states this suite never
    // opens - an error box, a queued steer note - where a dangling reference
    // would ship unseen.
    const src = fs.readFileSync(path.join(MEDIA, "webview/sidebar.js"), "utf8");
    // Defs live in BOTH files: crystal.js owns the product mark (`i-kx`) so the
    // two surfaces share one copy of it, and sidebar.js pulls it in via
    // CRYSTAL_DEFS. Scanning only sidebar.js would report the mark as dangling.
    const crystalSrc = fs.readFileSync(path.join(MEDIA, "webview/crystal.js"), "utf8");
    const defined = new Set([...(src + crystalSrc).matchAll(/<symbol id="(i-[a-z0-9-]+)"/g)].map((m) => m[1]));
    const used = new Set([...src.matchAll(/icon\(\s*"(i-[a-z0-9-]+)"/g)].map((m) => m[1]));
    // Ternaries inside an icon() call - icon(x ? "i-up" : "i-clock") - are not
    // matched by the pattern above, so pick up every quoted i-* token too.
    for (const m of src.matchAll(/"(i-[a-z0-9-]+)"/g)) used.add(m[1]);
    const dangling = [...used].filter((n) => !defined.has(n));
    ok("every glyph named in the shipped sidebar.js is defined",
      dangling.length === 0, dangling.join(", "));
    ok("and the defs were actually found", defined.size > 15, String(defined.size));
  }

  /* ── 5k. the section strip never hides the tab you are on ──────────── */
  {
    // The strip scrolls - ten sections have never fitted - and a fade at its
    // right edge says "there is more this way". That mask must not sit on top
    // of the LAST tab once you have scrolled to the end, because then the
    // thing it hides is the tab you just selected. The More menu navigates
    // straight to About, which is last, so this is the ordinary path.
    //
    // jsdom cannot see it: there is no layout and no mask. Only a real engine
    // can say where the tab ends up.
    const ctx = await browser.newContext({
      viewport: { width: 820, height: 700 }, deviceScaleFactor: 2, colorScheme: "dark",
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto("file://" + CC_PATH);
    await page.evaluate(
      (s) => window.dispatchEvent(new MessageEvent("message", { data: { type: "stateSync", state: s } })),
      {
        workspace: { open: true, name: "repo" }, running: false, phase: "act",
        status: { state: "ok", label: "OK" }, endpoint: "", profiles: [],
        skills: [], skillWarnings: [], agents: [], agentWarnings: [], activeAgent: "",
        config: { profileDirectory: ".agent/endpoints", skillsDirectory: ".agent/skills",
                  extensionVersion: "0.0.0", ui: {} },
        tlsError: null, rungs: [], tracing: false, todos: [], checkpoints: [],
        sessions: [], selection: null, context: null, changes: [], models: [], logs: [],
        session: { id: "s", title: "t", messages: [] }, mcp: { servers: [], warnings: [] },
      }
    );
    await page.waitForTimeout(300);
    ok("the control center boots with no script error", errors.length === 0, errors.slice(0, 2).join(" | "));

    // The fade width is read from the stylesheet, not retyped: the padding that
    // clears it and the mask that needs clearing must stay the same number.
    const css = fs.readFileSync(path.join(MEDIA, "webview/controlCenter.css"), "utf8");
    const fade = Number((/mask-image: linear-gradient\(90deg, #000 calc\(100% - (\d+)px\)/.exec(css) || [])[1]);
    ok("the strip's fade width is declared in css", Number.isFinite(fade), String(fade));

    const m = await page.evaluate(() => {
      const s = document.getElementById("strip");
      s.scrollLeft = s.scrollWidth; // all the way to the end of the list
      const tabs = [...s.querySelectorAll("button")];
      const last = tabs[tabs.length - 1];
      return { overflow: s.scrollWidth - s.clientWidth,
               gap: Math.round(s.getBoundingClientRect().right - last.getBoundingClientRect().right),
               label: last.textContent.trim() };
    });
    // The premise: at this width the strip really does scroll. Without it the
    // assertion below would pass for the boring reason.
    ok("the strip overflows at 820px, so the end of it is reachable",
      m.overflow > 0, String(m.overflow));
    ok("and the last tab clears the fade when scrolled to the end",
      m.gap >= fade, `"${m.label}" ends ${m.gap}px from the edge, fade is ${fade}px`);
    await ctx.close();
  }

  /* ── 6. the session list, as the reference draws it ────────────────── */
  {
    const { ctx, page } = await open(400, {
      sessions: [
        { id: "a", title: "why Master is sending 0x3E", when: "7m ago", count: 14 },
        { id: "b", title: "create an svg image editor", when: "4m ago", count: 4, running: true },
      ],
    });
    const text = (await page.locator("body").textContent()) || "";
    ok("a stored conversation is listed by title", text.includes("why Master is sending 0x3E"));
    ok("with how long ago it was touched", /7m ago/.test(text));

    // The design drops the message count from the ROW and keeps it in the
    // row's tooltip, because a thread of one reads the same as a thread of
    // forty from its title alone. Assert where it went, so a later change that
    // simply loses it is caught.
    const tip = await page.locator('.w-row[data-session="a"]').getAttribute("title");
    ok("and the count it drops from the row is kept in the tooltip",
      /14 messages/.test(tip || ""), tip);

    // A conversation working while you look at another one is the one row that
    // has to be distinguishable, and it is marked with the animated mark.
    const live = page.locator('.w-item[data-run="1"]');
    ok("a conversation working in the background is marked", (await live.count()) === 1);
    ok("and the idle one is not", (await page.locator('.w-item[data-run="0"]').count()) === 1);

    // The welcome copy switches once there is something to come back to.
    ok("the welcome copy invites you back rather than introducing itself",
      /Pick up where you left off/.test(text), text.slice(0, 60));
    await ctx.close();
  }

  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });

  if (failures.length) for (const f of failures) console.log("FAIL  " + f);
  console.log(`\n──── ${pass} passed, ${failures.length} failed ────`);
  process.exitCode = failures.length ? 1 : 0;
})().catch((e) => {
  console.log("FAIL  the render harness threw  — " + String((e && e.stack) || e).split("\n").slice(0, 3).join(" "));
  process.exitCode = 1;
});
