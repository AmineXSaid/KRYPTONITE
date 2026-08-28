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
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, "/opt/pw-browsers"].filter(Boolean);
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

  async function open(width, state) {
    const ctx = await browser.newContext({
      viewport: { width, height: 640 },
      deviceScaleFactor: 2, // 200%, the reference the owner gave
      colorScheme: "dark",
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
               dur: cs.animationDuration, timing: cs.animationTimingFunction };
    });
    ok("it is animated", anim.name === "g-sweep", anim.name);
    ok("and it never stops", anim.count === "infinite", anim.count);
    ok("linearly", anim.timing === "linear", anim.timing);

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
