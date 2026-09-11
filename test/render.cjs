/**
 * The panel as it is actually PAINTED, out of the archive we ship, at 200%.
 *
 * @requires-package - it reads MEDIA FROM THE .vsix rather than from media/,
 * which is the whole point of it, so the archive has to exist first. Run it
 * with `npm run test:package`.
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

// Read from src/ui/shell.ts rather than restated here. This table used to be a
// hand-kept copy, and when the design moved to one family it silently went on
// declaring three faces that no longer ship - so the harness loaded NOTHING and
// every type measurement below was quietly against a platform fallback. The
// suite is supposed to test the shipped panel; it cannot do that from a stale
// copy of the shipped panel's font list.
const FONTS = (() => {
  const shell = fs.readFileSync(path.join(ROOT, "src/ui/shell.ts"), "utf8");
  const decls = [...shell.matchAll(/file:\s*"([^"]+\.woff2?)",\s*family:\s*"([^"]+)",\s*weight:\s*"([^"]+)"/g)];
  if (!decls.length) throw new Error("no @font-face table found in src/ui/shell.ts");
  return decls
    .map((m) => `@font-face{font-family:'${m[2]}';font-style:normal;font-weight:${m[3]};` +
                `font-display:block;src:url('fonts/${m[1]}') format('woff2')}`)
    .join("");
})();

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
<script src="webview/mermaid.js"></script>
<script src="webview/sidebar.js"></script>
</body></html>`;

const HTML_PATH = path.join(MEDIA, "__render.html");
fs.writeFileSync(HTML_PATH, HTML);

// The same panel in a LIGHT workbench, which is a different document and was
// never rendered anywhere.
//
// `body` paints no ground on purpose, so a docked view takes the colour of the
// container beside it - and in a light workbench that container is light, which
// would put the panel's near-white foregrounds onto near-white. sidebar.css:51
// is the answer: `body.vscode-light` makes the sheet paint --kx-bg itself. That
// rule is load-bearing and nothing exercised it, so a change that dropped it
// would ship an unreadable panel to every user on a light theme and no suite
// here would have noticed.
//
// So this document does what the editor does: stamps the class, and leaves the
// container light instead of supplying GROUND.
const LIGHT_HTML = HTML
  .replace(`html { background: ${GROUND}; color-scheme: dark; }`,
           "html { background: #ffffff; color-scheme: light; }")
  .replace(`:root { --vscode-sideBar-background: ${GROUND}; }`,
           ":root { --vscode-sideBar-background: #ffffff; }")
  .replace("<body>", '<body class="vscode-light">');
const LIGHT_PATH = path.join(MEDIA, "__render-light.html");
fs.writeFileSync(LIGHT_PATH, LIGHT_HTML);

// The other surface. Same shell, different stylesheet and script - mirrors
// shell() in src/ui/shell.ts, which builds both from one template.
const CC_HTML = HTML
  .replace("webview/sidebar.css", "webview/controlCenter.css")
  .replace("webview/sidebar.js", "webview/controlCenter.js")
  // The flowchart renderer is loaded for the sidebar only, because only the
  // transcript draws diagrams. shell() makes the same distinction, so the
  // harness has to, or this page would be a shell the extension never serves.
  .replace('<script src="webview/mermaid.js"></script>\n', "")
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
      colorScheme: opts.light ? "light" : "dark",
      // Only the menu-entrance suite passes this. Every other caller runs at
      // the default, so the panel is measured the way it is normally seen.
      ...(opts.reducedMotion ? { reducedMotion: "reduce" } : {}),
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    await page.goto("file://" + (opts.light ? LIGHT_PATH : HTML_PATH));
    await page.evaluate(
      (s) => window.dispatchEvent(new MessageEvent("message", { data: { type: "stateSync", state: s } })),
      { ...BASE, ...state }
    );
    await page.waitForTimeout(400);
    /* ── HAND OFF, THE WAY A USER DOES ─────────────────────────────────────
     * An empty conversation opens on the welcome terminal, and the composer is
     * deliberately not there yet: translated away, `visibility: hidden` and out
     * of the tab order until you commit to typing. That is the feature, so a
     * test that wants to drive the composer has to get there the way a person
     * does rather than by reaching past the screen in front of it.
     *
     * Every caller that touches `#draft`, the palette or the send button gets
     * the hand-off; the handful that are ABOUT the welcome pass
     * `welcome: true` and are left on it. */
    if (!opts.welcome) {
      const term = page.locator(".welcome .boot-go");
      if (await term.count()) {
        await term.click();
        await page.waitForTimeout(320);   // the rise, plus the focus that follows it
      }
    }
    return { ctx, page, errors };
  }

  /* ── 1. the panel renders at all ───────────────────────────────────── */
  {
    const { ctx, page, errors } = await open(400, {}, { welcome: true });
    ok("the shipped panel boots with no script error", errors.length === 0, errors.slice(0, 2).join(" | "));

    const header = page.locator(".kx-header");
    ok("the header renders", (await header.count()) === 1);
    /* The header carries no wordmark and no brand mark - it opens straight on
       the tabs - and the WELCOME no longer carries one either: it is a terminal
       now, and it opens `$ genesis init`. Between the tab strip, that command
       and the report's own `workspace` row, a wordmark was the product's name
       said a fourth time on one screen. The claim is unchanged - the panel says
       which assistant this is - so it is read where it is now said. */
    const wordmark = await page.locator(".welcome .boot-line.echo").first().textContent();
    ok("the welcome names the product", /genesis/i.test(wordmark || ""), wordmark);

    // The brand face fails SILENTLY: a missing woff2 falls back to a platform
    // face and the header still reads "GENESIS", just in the wrong typeface.
    //
    // The family name is read from tokens.css rather than typed here, so a
    // change of face does not need this line edited - it needs the token
    // edited, which is the point.
    const brandFam = (() => {
      const css = fs.readFileSync(path.join(MEDIA, "webview/tokens.css"), "utf8");
      const m = /--kx-brand:\s*'([^']+)'/.exec(css);
      return m ? m[1] : "";
    })();
    ok("tokens.css names a brand face", brandFam.length > 0, brandFam);
    // The command line is the mono surface the welcome now leads with, so it is
    // what proves the brand face reaches the screen.
    const fam = await page.locator(".welcome .boot-line.echo").first()
      .evaluate((el) => getComputedStyle(el).fontFamily);
    ok("and the welcome's mono is set in it", fam.includes(brandFam), fam);

    // getComputedStyle reports the DECLARED stack whether or not the file
    // loaded, so the check above cannot see a dropped woff2 - the failure its
    // own comment describes. This can: FontFaceSet only holds a face the
    // document actually has, and only reports "loaded" once the bytes parsed.
    const faceState = await page.evaluate(async (family) => {
      await document.fonts.ready;
      await document.fonts.load(`700 11px "${family}"`).catch(() => {});
      const faces = [...document.fonts].filter((f) => f.family.replace(/["']/g, "") === family);
      return { count: faces.length, statuses: faces.map((f) => f.status) };
    }, brandFam);
    ok(`the ${brandFam} face is really loaded, not falling back`,
      faceState.count > 0 && faceState.statuses.includes("loaded"),
      JSON.stringify(faceState));

    const tabs = await page.locator(".kx-tabs [role='tab'], .kx-tabs button").allTextContents();
    const flat = tabs.join(" ").toUpperCase();
    for (const t of ["SESSION", "MCP", "AGENTS", "DIAGNOSTICS"]) {
      ok(`the ${t} tab is present`, flat.includes(t), flat.trim());
    }
    await ctx.close();
  }

  /* ── 1b. and it is readable in a LIGHT workbench ───────────────────── */
  //
  // The panel is drawn in near-white foregrounds and paints no ground of its
  // own, because a docked view is supposed to take the colour of the container
  // beside it. In a dark workbench that is what makes it look native. In a
  // light one it would be white on white, and the single rule that prevents
  // that - `body.vscode-light { background: var(--kx-bg) }` - had no test.
  // Deleting it breaks nothing anywhere else in this suite.
  {
    const { ctx, page, errors } = await open(400, {}, { light: true });
    ok("the panel boots in a light workbench too", errors.length === 0, errors.slice(0, 2).join(" | "));

    // The ground it actually paints, which is the whole rule.
    const bodyBg = rgb(await page.locator("body").evaluate((e) => getComputedStyle(e).backgroundColor));
    ok("body paints its own ground rather than staying transparent",
      !!bodyBg && bodyBg.a > 0, JSON.stringify(bodyBg));

    // And it is dark, not the light container. A rule that painted the
    // container's own colour would satisfy the check above and still be
    // white on white.
    const painted = bodyBg ? over(bodyBg, { r: 255, g: 255, b: 255, a: 1 }) : null;
    ok("and that ground is dark, not the light container showing through",
      !!painted && lum(painted) < 0.2,
      painted ? `luminance ${lum(painted).toFixed(3)}` : "none");

    // Then the thing a user would actually report: can you read it.
    // The welcome's command line, not a wordmark: the header and tab strip were
    // merged into one bar and the header's wordmark went with the row it cost,
    // and the welcome became a terminal that names the product in what it ran.
    for (const [label, sel] of [["the welcome's command", ".welcome .boot-line.echo"], ["a tab", ".kx-tab"]]) {
      const el = page.locator(sel).first();
      if (!(await el.count())) { ok(`${label} renders in light`, false); continue; }
      const fg = rgb(await el.evaluate((e) => getComputedStyle(e).color));
      const ratio = fg && painted ? contrast(over(fg, painted), painted) : 0;
      ok(`${label} clears 4.5:1 against the panel's own ground`, ratio >= 4.5,
        `${ratio.toFixed(2)}:1`);
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

  /* ── 3. the phase, as the chatbox design draws it ─────────────────── */
  {
    /* THE SEGMENT IS ONE WORD. The design states the phase in force and says
       nothing about the two that are not, so "all three are offered" is no
       longer a question this row answers. What it must still answer: the phase
       is written rather than only coloured, it is the phase the state named,
       and its hue is that phase's own - the same three tokens the segment
       filled itself with. */
    const { ctx, page } = await open(400, {});
    const word = page.locator("#phaseWord");
    ok("the phase in force is named on the row", (await word.count()) === 1);
    ok("in words, not colour alone",
      (await word.textContent()).trim().toUpperCase() === "ACT",
      await word.textContent());
    ok("and it is the phase the state named",
      (await word.getAttribute("data-phase")) === "act");
    // Its accessible name carries the sentence the radiogroup used to speak,
    // because three letters cannot say what the phase permits.
    const aria = await word.getAttribute("aria-label");
    ok("with the full sentence in its accessible name",
      /act/i.test(aria || "") && (aria || "").length > 12, aria);

    // Each phase paints in its own hue, so the word is readable at a glance
    // the way the filled segment was.
    const actColour = rgb(await word.evaluate((el) => getComputedStyle(el).color));
    await page.evaluate(() => window.dispatchEvent(new MessageEvent("message",
      { data: { type: "phaseChanged", phase: "ask" } })));
    await page.waitForTimeout(120);
    const askColour = rgb(await word.evaluate((el) => getComputedStyle(el).color));
    ok("and a different phase is painted differently",
      !!actColour && !!askColour && JSON.stringify(actColour) !== JSON.stringify(askColour),
      `${JSON.stringify(actColour)} vs ${JSON.stringify(askColour)}`);
    ok("with the word changing too, not just the hue",
      (await word.textContent()).trim().toUpperCase() === "ASK",
      await word.textContent());
    await ctx.close();
  }

  /* ── 4. the welcome shows no foreground mark ───────────────
     The masthead turning crystal and the header bar mark were both removed:
     the only logo on the welcome is the background watermark (section 5t). */
  {
    const { ctx, page } = await open(400, {}, { welcome: true });
    // The terminal is what the welcome renders now; the wordmark it used to
    // carry was the product's name said a fourth time on one screen.
    ok("the welcome terminal renders",
      (await page.locator(".welcome .boot-term").count()) === 1);
    ok("and there is no foreground mark beside it",
      (await page.locator(".welcome .crystal").count()) === 0);
    ok("and the header bar carries no mark either",
      (await page.locator(".kx-mark").count()) === 0);
    await ctx.close();
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
    for (const n of ["picks", "phaseWord", "tb-actions"]) {
      ok(`the toolbar still has ${n} to place`, rowOf(n) >= 0, JSON.stringify(rows));
    }
    /* IT NO LONGER HAS TO WRAP, and that is the design paying for itself: the
       phase segment and the model button were the two widest things on this
       row and both moved into the palette, so at 280px what is left fits on
       one line. The rule this replaces - "wrap rather than crush" - still
       holds underneath it: what must never happen is a control being squeezed
       out of the panel, which the overflow check below is what actually
       guards. */
    ok("the composer toolbar fits on one row at 280px, rather than wrapping",
      rows.length === 1, JSON.stringify(rows));
    // The heart of it. `.tb-actions` exists so a wrap does not orphan send by
    // itself; it must not be orphaned as a PAIR either.
    ok("and send stays on the row with the phase",
      rowOf("tb-actions") === rowOf("phaseWord"), JSON.stringify(rows));
    /* THE MODEL BUTTON WAS THE CONTROL THAT BROKE AWAY, and it no longer
       exists to break: the model is a palette row now. What is left on the row
       is a group of glyphs, one word and the actions - and the rule that
       replaces "the model goes alone" is that the glyph tray never splits from
       the + that closes it, because the tray is one object. */
    ok("the glyph tray stays whole",
      rowOf("picks") >= 0 && rows[rowOf("picks")].includes("picks"), JSON.stringify(rows));
    ok("which leaves no row carrying nothing but the two action buttons",
      !rows.some((r) => r.length === 1 && r[0] === "tb-actions"), JSON.stringify(rows));
    await ctx.close();
  }
  {
    /* THE TRUNCATION IS GONE, and so is the bug it guarded.
     *
     * The model name used to be measured and cut to fit a button sharing the
     * control row; it rendered "claud…" at an ordinary dock width, which told
     * two models apart not at all. The design moves the model into the
     * palette, where the row is the panel's full width and the name is the
     * FAMILY rather than the id - so there is nothing left to truncate.
     *
     * What is pinned instead is the property the truncation was protecting:
     * whatever reaches the reader has to be more than the prefix every model
     * here shares. Measured as characters that are actually inside their box,
     * not as `textContent`, which counts what an ellipsis is hiding. */
    for (const width of [300, 360, 420, 520]) {
      const { ctx, page } = await open(width, {});
      const seen = await page.evaluate(() => {
        const el = document.querySelector('#cmdPal [data-pal="model"] .cp-val');
        if (!el) return { missing: true };
        const box = el.getBoundingClientRect();
        const text = el.textContent || "";
        const node = el.firstChild;
        if (!node || node.nodeType !== 3) return { n: text.length, text };
        const r = document.createRange();
        let n = 0;
        for (let i = 1; i <= text.length; i++) {
          r.setStart(node, i - 1); r.setEnd(node, i);
          const cr = r.getBoundingClientRect();
          if (cr.right <= box.right + 0.5) n++;
        }
        return { n, text };
      });
      /* The bar used to be "longer than the prefix every model shares",
         because the id was printed in full and cut. The row prints the FAMILY
         instead, which is shorter than that prefix by design - so the property
         is simply that something identifying is there and none of it is lost.
         That two families never collapse into one word is section 5s. */
      ok(`the model name reaches the reader at ${width}px`,
        !seen.missing && seen.n > 0, JSON.stringify(seen));
      ok(`and nothing of it is cut off at ${width}px`,
        !seen.missing && seen.n === (seen.text || "").length, JSON.stringify(seen));
      await ctx.close();
    }
  }

  /* ── 5c2. the composer placeholder stays on one line ───────────────── */
  {
    // The design is set in a monospace, where every character is a full
    // advance and there is no narrow "l" or "i" to absorb a long string. The
    // placeholder went to two lines the moment the family changed, which grew
    // the empty composer by 50px in a panel whose own comments call vertical
    // space the scarce resource. Nothing asserted it, so nothing saw it.
    //
    // Measured against the textarea's content box with the REAL font, because
    // the whole point is that this is font-dependent.
    const { ctx, page } = await open(400, {});
    const fit = await page.evaluate(async () => {
      await document.fonts.ready;
      const t = document.getElementById("draft");
      const cs = getComputedStyle(t);
      // The PLACEHOLDER's own computed style, not the textarea's. The two can
      // differ - ::placeholder is styled separately here - and measuring the
      // element's font reports a width the placeholder never renders at.
      const ps = getComputedStyle(t, "::placeholder");
      const probe = document.createElement("span");
      probe.style.cssText = `position:absolute;left:-9999px;white-space:pre;font:${ps.font || cs.font}`;
      probe.textContent = t.placeholder;
      document.body.appendChild(probe);
      const needs = probe.getBoundingClientRect().width;
      probe.remove();
      const have = t.getBoundingClientRect().width
        - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      return { needs: Math.round(needs), have: Math.round(have), text: t.placeholder };
    });
    ok("the composer placeholder fits on one line at 400px",
      fit.needs <= fit.have, `needs ${fit.needs}px, has ${fit.have}px for "${fit.text}"`);
    await ctx.close();
  }

  /* ── 5c3. the phase word carries its own hue ───────────────────────── */
  {
    /* The segmented control is gone: the design states the phase in force as
       one word rather than offering three. Its own rule still has to exist, or
       the word is body text that happens to be clickable - and each phase's
       hue has to come from that phase's token, so the word cannot drift from
       the rail painted from the same state. */
    const { ctx, page } = await open(400, {});
    const m = await page.evaluate(() => {
      const w = document.getElementById("phaseWord");
      const cs = getComputedStyle(w);
      return { weight: cs.fontWeight, size: cs.fontSize, spacing: cs.letterSpacing,
               transform: cs.textTransform, family: cs.fontFamily };
    });
    ok("the phase word is set in the mono face", /mono|jetbrains/i.test(m.family), m.family);
    ok("small, bold and letter-spaced, as the design sets it",
      parseInt(m.size, 10) <= 10 && Number(m.weight) >= 700 && parseFloat(m.spacing) > 0,
      JSON.stringify(m));
    ok("and uppercase", m.transform === "uppercase", m.transform);
    await ctx.close();
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
      document.querySelectorAll("#viewAgents button").forEach((b) => {
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

  /* ── 5f. a data refresh still redraws the welcome ─────────────
     The turning masthead mark is gone, so there is no entrance to replay; what
     still matters is that a session list landing under the panel redraws the
     welcome rather than blanking it. Keyed on the terminal now, not the wordmark. */
  {
    const { ctx, page } = await open(400, {}, { welcome: true });
    ok("the welcome renders", (await page.locator(".welcome .boot-term").count()) === 1);
    const refreshed = await page.evaluate(() => {
      window.dispatchEvent(new MessageEvent("message", {
        data: { type: "sessionsListed", sessions: [] },
      }));
      return !!document.querySelector(".welcome .boot-term");
    });
    ok("a session list arriving still redraws the welcome", refreshed);
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
      // The palette has to be up before one of its rows can be clicked: it is
      // `hidden` at rest, and a hidden row is not an actionable target.
      ["the model picker", "#qp", async (p) => {
        await p.keyboard.press("Control+k");
        await p.click('#cmdPal [data-pal="model"]');
      }],
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
      document.querySelector('#cmdPal [data-pal="model"]').click();
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

    await page.evaluate(() => window.dispatchEvent(new MessageEvent("message",
      { data: { type: "configChanged",
        config: { approvalMode: "edits-auto", activeProfile: "", caBundlePath: "", ui: {} } } })));
    await page.waitForTimeout(120);
    await page.click('.pick[data-pick="perm"]');
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
      await page.evaluate(() => document.activeElement.id === "draft"),
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
    await page.evaluate(() => window.dispatchEvent(new MessageEvent("message",
      { data: { type: "configChanged",
        config: { approvalMode: "edits-auto", activeProfile: "", caBundlePath: "", ui: {} } } })));
    await page.waitForTimeout(120);
    await page.click('.pick[data-pick="perm"]');
    await page.waitForTimeout(450);
    /* SHIFT+TAB, not Tab. The sheet lands on the mode IN FORCE, and the plate
       that opens it only exists once the mode is off its default - so this
       fixture starts on "Accept edits" and one Tab FORWARD lands on full-auto,
       which arms on the first press rather than committing. That would measure
       the confirmation step instead of the trap this section exists for.
       Stepping back reaches Manual, which commits on one press. */
    await page.keyboard.press("Shift+Tab");
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
  {
    /* THE ONE MODE THAT TAKES TWO PRESSES, IN A REAL BROWSER.
     *
     * jsdom asserts the mechanism; this asserts that a real click lands on a
     * real element and that the armed state actually paints - full-auto was a
     * single click on a row of the same weight as the other two, so browsing
     * the sheet to see what the modes were could hand the agent unattended
     * shell access. */
    const { ctx, page } = await open(400, {});
    await page.evaluate(() => window.dispatchEvent(new MessageEvent("message",
      { data: { type: "configChanged",
        config: { approvalMode: "edits-auto", activeProfile: "", caBundlePath: "", ui: {} } } })));
    await page.waitForTimeout(120);
    await page.click('.pick[data-pick="perm"]');
    await page.waitForTimeout(450);
    await page.evaluate(() => { window.__sent.length = 0; });
    await page.click('#permPop [data-perm="full-auto"]');
    await page.waitForTimeout(120);
    ok("the first press on Auto sends nothing",
      !(await page.evaluate(() => window.__sent.some((m) => m.type === "setConfig"))));
    ok("and the row says it is waiting for a second",
      /press again/i.test(await page.evaluate(
        () => document.querySelector('#permPop [data-perm="full-auto"] .m').textContent)));
    // The armed row has to be visibly different, or "press again" is a sentence
    // in a row that looks exactly like the two beside it.
    const armedBg = await page.evaluate(() => getComputedStyle(
      document.querySelector('#permPop [data-perm="full-auto"]')).backgroundColor);
    const plainBg = await page.evaluate(() => getComputedStyle(
      document.querySelector('#permPop [data-perm="edits-auto"]')).backgroundColor);
    ok("and is painted unlike its neighbours", armedBg !== plainBg, `${armedBg} vs ${plainBg}`);
    await page.click('#permPop [data-perm="full-auto"]');
    await page.waitForTimeout(120);
    ok("the second press commits it",
      await page.evaluate(() => window.__sent.some(
        (m) => m.type === "setConfig" && m.value === "full-auto")));
    await ctx.close();
  }

  /* ── 5j. the message menu stays inside a narrow panel ──────────────── */
  {
    /* jsdom asserts the clamp arithmetic with a supplied width, because it has
       no layout. This is the case that arithmetic exists for, measured: the
       menu is `position: fixed`, it is wider than the panel at its narrowest,
       and a right-click near the right edge is where it would hang off the
       side of the workbench with nothing to stop it. 200px is roughly the
       floor VS Code allows a side bar to be dragged to. */
    const { ctx, page } = await open(200, {});
    await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", {
      data: { type: "steerAccepted", text: "a question worth right-clicking", files: [] },
    })));
    await page.waitForTimeout(120);

    const box = await page.locator(".msg-user").first().boundingBox();
    ok("there is a message to right-click", !!box);
    // As far right and as far down inside the message as it goes.
    await page.locator(".msg-user").first().click({
      button: "right",
      position: { x: Math.max(1, box.width - 2), y: Math.max(1, box.height - 2) },
    });
    await page.waitForTimeout(200);

    const menu = page.locator("#msgMenu");
    ok("the menu opened", (await menu.count()) === 1 && await menu.isVisible());
    const m = await menu.boundingBox();
    ok("its right edge is inside the panel", m && m.x + m.width <= 200 + 0.5,
      m && `x ${m.x.toFixed(1)} + w ${m.width.toFixed(1)}`);
    ok("its left edge is too", m && m.x >= -0.5, m && `x ${m.x.toFixed(1)}`);
    ok("and it is not taller than the panel it sits in", m && m.height <= 640);
    ok("the bottom stays on screen", m && m.y + m.height <= 640 + 0.5,
      m && `y ${m.y.toFixed(1)} + h ${m.height.toFixed(1)}`);

    // Four rows on a question, and the one that costs a draft says nothing yet
    // because the composer is empty.
    const rows = await page.locator("#msgMenu [data-mm]").allTextContents();
    ok("a question offers four actions", rows.length === 4, JSON.stringify(rows));
    ok("and Edit is not yet warning about a draft",
      /^Edit$/.test((rows[0] || "").trim()), rows[0]);

    /* With a checkpoint behind the turn the menu grows a fifth row, so the
       clamp is measured again on the taller menu rather than only on the short
       one - a menu that fits at four rows and hangs off the bottom at five
       would pass every assertion above. */
    await page.keyboard.press("Escape");
    await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", {
      data: { type: "checkpointsListed", checkpoints: [
        { hash: "abc1234", label: "a question worth right-clicking", when: "now" },
      ] },
    })));
    await page.locator(".msg-user").first().click({
      button: "right",
      position: { x: Math.max(1, box.width - 2), y: Math.max(1, box.height - 2) },
    });
    await page.waitForTimeout(200);
    const withRewind = await page.locator("#msgMenu [data-mm]").allTextContents();
    ok("a snapshotted turn also offers Rewind", withRewind.length === 5 &&
      /rewind/i.test(withRewind.join(" ")), JSON.stringify(withRewind));
    const m2 = await page.locator("#msgMenu").boundingBox();
    ok("and the taller menu still lands inside the panel",
      m2 && m2.x >= -0.5 && m2.x + m2.width <= 200 + 0.5 && m2.y >= -0.5 &&
      m2.y + m2.height <= 640 + 0.5,
      m2 && `x ${m2.x.toFixed(1)} w ${m2.width.toFixed(1)} y ${m2.y.toFixed(1)} h ${m2.height.toFixed(1)}`);
    await page.keyboard.press("Escape");

    // A code block keeps VS Code's own menu: nothing of ours may open there.
    await page.keyboard.press("Escape");
    await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", {
      data: { type: "streamDelta", text: "\n\n```js\nconst a = 1;\n```\n" },
    })));
    await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "turnEnd" } })));
    await page.waitForTimeout(200);
    if (await page.locator(".msg-ai .cb").count()) {
      await page.locator(".msg-ai .cb").first().click({ button: "right" });
      await page.waitForTimeout(150);
      ok("right-clicking a code block opens nothing of ours",
        !(await page.locator("#msgMenu").isVisible()));
    }
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

  /* ── 5k. every section stays reachable at every width ─────────────── */
  {
    // Ten sections have never fitted on one line. The strip used to answer
    // that by SCROLLING sideways with the scrollbar hidden and a fade at the
    // right edge as the only hint, and the tabs past the fold - Skills,
    // Checkpoints, Logs, Documentation, About - simply sat off-screen at every
    // realistic panel width. Dragging the panel narrower did not reflow them;
    // it hid them. So the strip WRAPS now, and this is the guard on that: a
    // section you cannot see is a section you cannot open.
    //
    // The three assertions that used to live here measured the retired design
    // - they read the fade width out of the stylesheet and expected the strip
    // to overflow - and were never updated when it changed.
    //
    // test/control-center.cjs proves the ten tabs EXIST; jsdom has no layout,
    // so it cannot say whether they land on screen. Only a real engine can,
    // which is why this claim has to be made here or nowhere.
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

    // How many tabs there should be, counted from the source the way
    // test/control-center.cjs:39 counts them. A hardcoded ten would keep
    // passing after an eleventh section was added and left off the strip,
    // which is the failure this whole block exists to catch.
    const sections = (() => {
      const src = fs.readFileSync(path.join(MEDIA, "webview/controlCenter.js"), "utf8");
      const m = src.match(/var SECTIONS = \[[\s\S]*?\];/);
      if (!m) throw new Error("SECTIONS not found in controlCenter.js");
      return [...m[0].matchAll(/\["([a-z]+)",\s*"/g)].map((x) => x[1]);
    })();
    ok("the section list is readable from the shipped source", sections.length >= 10, String(sections.length));

    // 820px was the only width the old block ran at, and it is the one that
    // proves the least: the claim is that narrowing REFLOWS rather than hides,
    // so measure one row, two rows and three.
    for (const width of [520, 820, 1200]) {
      await page.setViewportSize({ width, height: 700 });
      await page.waitForTimeout(80);
      const m = await page.evaluate(() => {
        const s = document.getElementById("strip");
        const box = s.getBoundingClientRect();
        const tabs = [...s.querySelectorAll("button")];
        const within = (a, b) => a <= b + 1; // a pixel of slack for subpixel layout
        const outside = (r) => !(within(box.left, r.left) && within(r.right, box.right) &&
                                 within(box.top, r.top) && within(r.bottom, box.bottom));
        return {
          count: tabs.length,
          wrap: getComputedStyle(s).flexWrap,
          overflow: s.scrollWidth - s.clientWidth,
          rows: new Set(tabs.map((t) => Math.round(t.getBoundingClientRect().top))).size,
          clipped: tabs.filter((t) => outside(t.getBoundingClientRect())).map((t) => t.textContent.trim()),
          // Visible but covered is the failure a rect check alone misses.
          covered: tabs.filter((t) => {
            const r = t.getBoundingClientRect();
            const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            return !(hit && (hit === t || t.contains(hit)));
          }).map((t) => t.textContent.trim()),
        };
      });
      ok(`the strip wraps rather than scrolls at ${width}px`,
        m.wrap === "wrap" && m.overflow <= 1, `${m.wrap}, ${m.overflow}px of overflow, ${m.rows} row(s)`);
      ok(`  and every section is drawn inside it`,
        m.count === sections.length && m.clipped.length === 0,
        `${m.count}/${sections.length} tabs, clipped: ${m.clipped.join(", ") || "none"}`);
      ok(`  and every tab answers a click where it is drawn`,
        m.covered.length === 0, `covered: ${m.covered.join(", ") || "none"}`);
    }
    await ctx.close();
  }

  /* ── 5l. a decision's controls stay on one row ─────────────────────── */
  {
    // The diff card's footer carried "Genesis: 3 additions, 1 deletions" -
    // the same count its own HEADER states as `+3 -1` two rows above. That
    // sentence was 228px in a 390px footer, so the row needed 487px and
    // wrapped: Accept alone on one line, Reject and Diff view underneath.
    // Three controls of one decision, split, with the primary one separated
    // from its alternatives.
    //
    // Asserted by measuring where the buttons LAND, not by looking for the
    // string that used to push them: any future addition to this row fails
    // the same way, which is the point.
    for (const width of [340, 400, 460]) {
      const { ctx, page } = await open(width, {});
      await page.evaluate((patch) => {
        window.dispatchEvent(new MessageEvent("message", { data: {
          type: "diffPending", turnId: "t1", file: "src/providers/http.ts",
          added: 3, removed: 1, patch, truncated: false } }));
        window.dispatchEvent(new MessageEvent("message", { data: {
          type: "permissionRequest", id: "p1", summary: "Run npm test -- http" } }));
      }, "--- a/x\n+++ b/x\n@@ -41,1 +41,3 @@\n-  const res = await fetch(url);\n+  const res = await withRetry(\n");
      await page.waitForTimeout(250);

      const rows = (sel) => page.evaluate((s) => {
        const box = document.querySelector(s);
        if (!box) return null;
        const tops = [...box.querySelectorAll("button")]
          .map((b) => Math.round(b.getBoundingClientRect().top));
        return { count: tops.length, rows: new Set(tops).size };
      }, sel);

      const d = await rows(".diff-foot");
      ok(`the diff decision keeps its controls on one row at ${width}px`,
        d && d.count >= 2 && d.rows === 1, JSON.stringify(d));
      const p = await rows(".perm-actions");
      ok(`and the permission decision does too at ${width}px`,
        p && p.count >= 2 && p.rows === 1, JSON.stringify(p));
      await ctx.close();
    }
  }

  /* ── 5m. a pill in the composer can always be dismissed ────────────── */
  {
    // Found by a responsive sweep, not by looking: #selText was a flex item at
    // its default `min-width: auto`, so a long path could not shrink. It
    // pushed the row 153px past the composer, which CLIPS - and the dismiss
    // button went with it. Measured before the fix: composer right edge 384px,
    // clear button at 537-555px, elementFromPoint said it was not there.
    //
    // A selection that cannot be cleared rides along with every message sent,
    // which makes this a correctness bug wearing a layout bug's clothes.
    //
    // Asserted by HIT TESTING rather than by geometry: what matters is not
    // where the button is but whether a click lands on it.
    const LONG = "src/providers/very/deeply/nested/path/to/a/module/with/a/long/name.ts";
    for (const width of [300, 340, 400, 520]) {
      const { ctx, page } = await open(width, { selection: { file: LONG, startLine: 41, endLine: 58 } });
      const hit = await page.evaluate(() => {
        const btn = document.getElementById("selClear");
        if (!btn) return { missing: true };
        const r = btn.getBoundingClientRect();
        const comp = document.querySelector(".composer").getBoundingClientRect();
        const at = document.elementFromPoint(
          Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
        return {
          inside: r.right <= comp.right + 1 && r.left >= comp.left - 1,
          reachable: !!at && (at === btn || btn.contains(at)),
          btn: [Math.round(r.left), Math.round(r.right)], comp: Math.round(comp.right),
        };
      });
      ok(`the selection pill's dismiss button is inside the composer at ${width}px`,
        hit.inside === true, JSON.stringify(hit));
      ok(`and a click actually lands on it at ${width}px`,
        hit.reachable === true, JSON.stringify(hit));
      await ctx.close();
    }
  }

  /* ── 5n. the model is a palette row, and says which model ──────────── */
  {
    /* THE MODEL BUTTON IS GONE, and with it the whole class of problem this
       section existed for: it was the control that competed for row width, so
       it was the one that broke away at a narrow dock, and its name had to be
       fitted by measurement. In the palette it has a full row to itself at
       every width, so what is left to pin is that it still NAMES the model and
       still carries the whole id where the short name cannot. */
    const ID = "claude-sonnet-4-6";
    for (const width of [300, 420, 700]) {
      const { ctx, page } = await open(width, {
        profiles: [{ id: "gw", status: "ready", active: true, model: ID,
          wire: "anthropic", baseUrl: "https://x", capabilities: { contextWindow: 200000 } }],
        models: [{ group: "gw", models: [ID] }],
      });
      const m = await page.evaluate(() => {
        const row = document.querySelector('#cmdPal [data-pal="model"]');
        if (!row) return { missing: true };
        const val = row.querySelector(".cp-val");
        const r = row.getBoundingClientRect();
        const v = val.getBoundingClientRect();
        return { value: val.textContent, title: row.title,
                 overflows: Math.round(v.right) > Math.round(r.right) };
      });
      ok(`the model row names the model at ${width}px`,
        !m.missing && /sonnet/i.test(m.value || ""), JSON.stringify(m));
      /* The short name is the family; the whole id is on the row's tooltip,
         which is the one place it can be read in full now. */
      ok(`and the full id is still reachable at ${width}px`,
        (m.title || "").includes(ID), JSON.stringify(m));
      ok(`without the value spilling out of its row at ${width}px`,
        !m.overflows, JSON.stringify(m));
      await ctx.close();
    }
  }

  /* ── 5o. the health dot knows what the status bar knows ────────────── */
  {
    // `stateSync` carries `status` and the handler dropped it, so `S.status`
    // was only ever written by the `statusChanged` PUSH. A panel opened while
    // the gateway was failing therefore came up with no status at all and the
    // dot rendered green - and stayed green until the endpoint's state next
    // changed, which for a persistently broken gateway is never.
    //
    // Reloading the window, the first thing anyone tries, reproduced it:
    // a reload is a fresh sync, not a change.
    for (const width of [360, 700]) {
      const { ctx, page } = await open(width, {
        status: { state: "error", label: "ERROR · HTTP" },
      });
      const d = await page.evaluate(() => {
        const dot = document.querySelector('#cmdPal [data-pal="model"] .cp-dot');
        if (!dot) return { missing: true };
        const cs = getComputedStyle(dot);
        return { err: dot.getAttribute("data-err"), display: cs.display,
                 label: dot.getAttribute("aria-label") };
      });
      ok(`a failing endpoint in the first sync turns the dot red at ${width}px`,
        d.err === "1", JSON.stringify(d));
      // The narrow-panel rule hides the GREEN dot only. Red is the one state
      // you must not have to widen the panel to find, so it stays at every
      // width - which is exactly what that rule's own comment promises.
      ok(`and the red dot is visible at ${width}px`,
        d.display !== "none", JSON.stringify(d));
      ok(`and it is named, not just coloured, at ${width}px`,
        /failing/i.test(d.label || ""), JSON.stringify(d));
      await ctx.close();
    }
    // The other half of the same bug: a healthy sync must not report failure.
    const { ctx, page } = await open(700, { status: { state: "ok", label: "OK" } });
    const good = await page.evaluate(() =>
      document.querySelector('#cmdPal [data-pal="model"] .cp-dot').getAttribute("data-err"));
    ok("a healthy endpoint in the first sync leaves the dot green", good === "0", good);
    await ctx.close();
  }

  /* ── 5p. the model's working is visible WHILE it is being written ──── */
  {
    // Reported as "show me in real time when the model is thinking, not after
    // it ends thinking I got all the text at once".
    //
    // `addThinking` built a fresh `.think` element per reasoning event, so a
    // model streaming its working in chunks produced one CLOSED strip per
    // chunk, each labelled "Thought for 4 words" as though it were a finished
    // thought. Measured against the shipped panel with five chunks: five
    // boxes, and zero visible characters at every step. The panel had the
    // text the whole time and was hiding it behind five doors.
    const CHUNKS = ["Let me look at the ", "loader first. The skills ",
                    "directory is read by ", "a watcher, so a new folder ",
                    "should appear without a reload."];
    const { ctx, page } = await open(420, {});
    const send = (d) => page.evaluate(
      (m) => window.dispatchEvent(new MessageEvent("message", { data: m })), d);
    const snap = () => page.evaluate(() => {
      const boxes = [...document.querySelectorAll(".think")];
      return {
        boxes: boxes.length,
        // What a reader can actually SEE, not what is in the DOM: a closed
        // disclosure holds all of its text and shows none of it, which is
        // exactly the bug being pinned.
        visible: boxes.reduce((n, b) => {
          const body = b.querySelector(".think-body");
          return n + (getComputedStyle(body).display === "none" ? 0 : body.textContent.length);
        }, 0),
        head: boxes.length ? boxes[0].querySelector(".think-head .n").textContent : "",
        live: boxes.length ? boxes[0].getAttribute("data-live") : "",
      };
    });

    let prev = 0;
    for (let i = 0; i < CHUNKS.length; i++) {
      await send({ type: "thinking", text: CHUNKS[i] });
      await page.waitForTimeout(90);
      const m = await snap();
      ok(`one thinking box, not one per chunk (after chunk ${i + 1})`,
        m.boxes === 1, JSON.stringify(m));
      ok(`the working is on screen while it is being written (chunk ${i + 1})`,
        m.visible > prev, JSON.stringify(m) + " prev=" + prev);
      ok(`and it is marked live rather than presented as finished (chunk ${i + 1})`,
        m.live === "1" && /thinking/i.test(m.head), JSON.stringify(m));
      prev = m.visible;
    }

    // The seal. Once the answer starts, the working is no longer the
    // interesting thing on screen, so it collapses - with an accurate total
    // rather than the count of whichever chunk arrived last.
    await send({ type: "streamDelta", text: "Here is the answer." });
    await page.waitForTimeout(250);
    const done = await snap();
    ok("the working seals when the answer starts", done.live === "0", JSON.stringify(done));
    ok("and it is closed once sealed", done.visible === 0, JSON.stringify(done));
    const words = CHUNKS.join("").trim().split(/\s+/).length;
    ok("and its count is the WHOLE working, not the last chunk",
      done.head === `Thought for ${words} words`, done.head + " != " + words);
    await ctx.close();
  }

  /* ── 5q. a second run of reasoning does not join the first ─────────── */
  {
    // think, answer, think again, answer again - the ordinary shape of a turn
    // that calls a tool. Left open, the second run would append into the first
    // box, which sits ABOVE the first answer, so the transcript would claim
    // the model thought it all before saying anything.
    const { ctx, page } = await open(420, {});
    const send = (d) => page.evaluate(
      (m) => window.dispatchEvent(new MessageEvent("message", { data: m })), d);
    await send({ type: "thinking", text: "First I check the loader." });
    await page.waitForTimeout(80);
    await send({ type: "streamDelta", text: "Checking the loader." });
    await page.waitForTimeout(200);
    await send({ type: "thinking", text: "Now I check the watcher." });
    await page.waitForTimeout(80);
    const r = await page.evaluate(() => {
      const kids = [...document.getElementById("log").children];
      return {
        order: kids.map((e) => e.className.split(" ")[0]).filter((c) => /think|msg-ai/.test(c)),
        bodies: [...document.querySelectorAll(".think-body")].map((b) => b.textContent),
      };
    });
    ok("a second run of reasoning opens its own box",
      r.bodies.length === 2, JSON.stringify(r));
    ok("and the first box keeps only its own text",
      r.bodies[0] === "First I check the loader.", JSON.stringify(r));
    /* Deliberately NOT asserting which side of the answer the second box
       lands on. addThinking places reasoning ABOVE the answer on purpose, and
       the comment there gives the reason: several providers flush a reasoning
       summary only once the visible answer has started, so ordering by arrival
       makes the transcript read "here is the answer... and here is the
       thinking that led to it". A late summary and a fresh run of reasoning
       are indistinguishable from the event stream, and that tradeoff was
       already made. What this section owns is that the two runs stay SEPARATE
       - which is what the accumulating box put at risk. */
    ok("and both boxes are still collapsed disclosures, not one merged blob",
      r.bodies.every((b) => b.length > 0) && r.bodies[0] !== r.bodies[1],
      JSON.stringify(r));
    await ctx.close();
  }

  /* ── 5r. Jump to latest floats over the transcript, not the composer ─ */
  {
    // `.to-latest` was an absolute child of `#viewSession` at `bottom: 8px`,
    // and `#viewSession` holds the composer as well as the transcript - so
    // "8px from the bottom" was 8px from the bottom of the COMPOSER. Measured
    // at 360px before the fix: transcript ended at y=418, pill sat at 606-632,
    // over a composer occupying 497-628, covering the ACT button.
    //
    // The rule carried a comment claiming this exact bug was what it prevented.
    // It was right about the mechanism and wrong about which element bounds
    // it, and nothing had ever rendered the two together to find out.
    const msgs = [];
    for (let i = 0; i < 14; i++) {
      msgs.push({ role: "user", content: `Question number ${i} about the codebase.` });
      msgs.push({ role: "assistant", content: `Answer ${i}. ` + "Lorem ipsum dolor sit amet. ".repeat(6) });
    }
    for (const width of [300, 360, 420, 520]) {
      const { ctx, page } = await open(width, { session: { id: "s1", title: "Long chat", messages: msgs } });
      // Scroll up, which is the only state the pill exists in.
      await page.evaluate(() => { document.getElementById("log").scrollTop = 0; });
      await page.waitForTimeout(200);
      const m = await page.evaluate(() => {
        const btn = document.getElementById("toLatest");
        const log = document.getElementById("log");
        const wrap = document.querySelector(".composer-wrap");
        const br = btn.getBoundingClientRect(), lr = log.getBoundingClientRect();
        const wr = wrap.getBoundingClientRect();
        const at = document.elementFromPoint(
          Math.round(br.left + br.width / 2), Math.round(br.top + br.height / 2));
        return {
          hidden: btn.hidden,
          overComposer: br.bottom > wr.top && br.top < wr.bottom,
          insideLog: br.bottom <= lr.bottom + 1 && br.top >= lr.top - 1,
          reachable: !!at && (at === btn || btn.contains(at)),
          btn: [Math.round(br.top), Math.round(br.bottom)],
          log: [Math.round(lr.top), Math.round(lr.bottom)],
          composerWrapTop: Math.round(wr.top),
        };
      });
      ok(`the pill is offered when scrolled up at ${width}px`, m.hidden === false, JSON.stringify(m));
      ok(`and it never overlaps the composer at ${width}px`, m.overComposer === false, JSON.stringify(m));
      ok(`and it sits within the transcript it belongs to at ${width}px`,
        m.insideLog === true, JSON.stringify(m));
      // The consequence, not the geometry: a pill over the composer is a pill
      // that eats clicks meant for the phase segment underneath it.
      ok(`and a click lands on the pill itself at ${width}px`, m.reachable === true, JSON.stringify(m));
      await ctx.close();
    }
    // The composer's own controls must still be clickable with the pill shown.
    const { ctx, page } = await open(360, { session: { id: "s1", title: "Long chat", messages: msgs } });
    await page.evaluate(() => { document.getElementById("log").scrollTop = 0; });
    await page.waitForTimeout(200);
    const seg = await page.evaluate(() => {
      const act = document.querySelector('[data-phase="act"]');
      const r = act.getBoundingClientRect();
      const at = document.elementFromPoint(
        Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
      return { reachable: !!at && (at === act || act.contains(at)), tag: at ? at.className : null };
    });
    ok("the ACT button is still clickable while the pill is shown",
      seg.reachable === true, JSON.stringify(seg));
    await ctx.close();
  }

  /* ── 5s. the model's family is what the row shows ──────────────────── */
  {
    /* This pinned a TRUNCATION: the model button measured the id and cut it so
       the half that identifies a model survived. There is no truncation now -
       the palette row shows the FAMILY ("Sonnet") and keeps the whole id in
       the tooltip - so what is pinned instead is that the short form still
       tells two models apart, which is the property the truncation existed to
       protect. */
    const IDS = ["claude-sonnet-4-6", "claude-opus-4-1", "openai/gpt-oss-20b"];
    const seen = [];
    for (const id of IDS) {
      const { ctx, page } = await open(400, {
        profiles: [{ id: "gw", status: "ready", active: true, model: id,
          wire: "anthropic", baseUrl: "https://x", capabilities: { contextWindow: 200000 } }],
        models: [{ group: "gw", models: [id] }],
      });
      const v = await page.evaluate(() =>
        document.querySelector('#cmdPal [data-pal="model"] .cp-val').textContent.trim());
      ok(`"${id}" is named on the row`, v.length > 0, v);
      seen.push(v);
      await ctx.close();
    }
    /* THE POINT: three different models must not read as the same word. A
       short name that collapses two ids into one string is the same failure
       as a truncation that cuts before the distinguishing character. */
    ok("and three different models read as three different names",
      new Set(seen).size === seen.length, JSON.stringify(seen));
  }

  /* ── 5t. the welcome is a workspace boot sequence ─────────────────── */
  //
  // The centred one-column greeting and the wide-dock split it grew are both
  // gone: the welcome comes up like a terminal now - a masthead, a boot log, a
  // live prompt, and the openers as cards - with the split-screen mark bled in
  // behind it as a watermark. These assertions test that screen, and two of
  // them pin what the owner asked for by name: the cursor must blink like a
  // terminal's, and the background logo must be there.
  {
    const sessions = [
      { id: "a", title: "can you explain this code?", count: 4, when: "1m ago" },
      { id: "b", title: "why dlc? here and what used for?", count: 9, when: "3d ago" },
    ];
    // It renders as the boot screen at every dock width, reports what mounted,
    // offers three cards, and never scrolls the panel sideways.
    for (const width of [300, 360, 420, 520, 900]) {
      const { ctx, page } = await open(width, { sessions, session: { id: "s1", title: "", messages: [] } },
        { welcome: true });
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(200);
      const m = await page.evaluate(() => {
        const wel = document.querySelector(".welcome.boot");
        if (!wel) return { missing: true };
        return {
          text: wel.textContent,
          panel: !!document.querySelector(".boot-term"),
          cards: document.querySelectorAll(".boot-card[data-starter]").length,
          hScroll: document.documentElement.scrollWidth >
                   document.documentElement.clientWidth + 1,
        };
      });
      ok(`the boot welcome renders at ${width}px`, !m.missing && m.panel, JSON.stringify(m));
      /* The log is a boot REPORT now, not four prose sentences: a command that
         ran, then one bracketed status line per thing that came up. The claim
         is the same - it says what actually mounted, read from state rather
         than written into the screen - so it is checked against the labels the
         report prints. */
      ok(`its log reports what mounted at ${width}px`,
        /genesis init/.test(m.text || "") && /workspace/.test(m.text || "") &&
        /endpoint/.test(m.text || "") && /skills/.test(m.text || "") &&
        /approvals/.test(m.text || ""),
        (m.text || "").slice(0, 90));
      ok(`the openers are three cards at ${width}px`, m.cards === 3, JSON.stringify(m));
      ok(`and it never scrolls the panel sideways at ${width}px`, !m.hScroll, JSON.stringify(m));
      await ctx.close();
    }

    /* THE BACKGROUND LOGO, AND IT IS NO LONGER THE WELCOME'S.
     *
     * It was `.boot-bg`, a child of the boot screen, and it died with it. The
     * hand-off is the reason it moved: the welcome clears, the composer rises,
     * and the mark is the one thing on screen in BOTH states, so the eye has
     * something to follow across the cut. A watermark that dies with the screen
     * it decorates cannot do that job, so it lives on `#viewSession` now as
     * `.void-mark`.
     *
     * Everything else the old assertions claimed still has to hold: texture,
     * not a control - aria-hidden, click-through, behind the content, and NOT
     * the `.crystal` that names the single turning roundel the animation suite
     * counts. And a MEDIUM portion of it must show: the offsets were once
     * percentages of the VIEW'S height rather than the mark's, so a taller
     * panel cropped it harder and only 23% of its area was visible at 420px. */
    {
      const { ctx, page } = await open(420, { session: { id: "s1", title: "", messages: [] } },
        { welcome: true });
      const wm = await page.evaluate(() => {
        const bg = document.querySelector(".void-mark");
        const mark = document.querySelector(".void-mark-svg");
        if (!bg || !mark) return { missing: true };
        const bgcs = getComputedStyle(bg);
        const view = document.getElementById("viewSession").getBoundingClientRect();
        const r = bg.getBoundingClientRect();
        const ix = Math.max(0, Math.min(view.right, r.right) - Math.max(view.left, r.left));
        const iy = Math.max(0, Math.min(view.bottom, r.bottom) - Math.max(view.top, r.top));
        return {
          crystals: document.querySelectorAll(".welcome .crystal").length,
          opacity: parseFloat(bgcs.opacity),
          hidden: bg.getAttribute("aria-hidden") === "true",
          behind: (parseInt(bgcs.zIndex || "0", 10) || 0) <= 0,
          pe: bgcs.pointerEvents,
          visible: Math.round((100 * ix * iy) / (r.width * r.height)),
        };
      });
      ok("the watermark is on the view, so it outlives the welcome", !wm.missing, JSON.stringify(wm));
      ok("and it is the only logo: no foreground .crystal on the welcome",
        wm.crystals === 0, JSON.stringify(wm));
      ok("the watermark is a whisper, not a foreground",
        wm.opacity > 0 && wm.opacity <= 0.16, JSON.stringify(wm));
      ok("it sits behind the content", wm.behind, JSON.stringify(wm));
      ok("it is texture: aria-hidden and click-through",
        wm.hidden && wm.pe === "none", JSON.stringify(wm));
      // A medium portion, not a stray arc. Both axes share one basis now, so
      // this holds at any panel height rather than only at the one measured.
      ok("and a medium portion of it is actually visible",
        wm.visible >= 40 && wm.visible <= 80, JSON.stringify(wm));
      await ctx.close();
    }

    /* THE GREEN PROMPT CURSOR BLINKS LIKE A TERMINAL'S. A steady block that
     * appears and disappears is what a terminal draws, so it has an animation
     * and its pixels change across a blink - and it holds still for a reader
     * who asked for no motion, because a blink is exactly what that setting is
     * asking not to see. */
    {
      const { ctx, page } = await open(420, { session: { id: "s1", title: "", messages: [] } },
        { welcome: true });
      const cur = page.locator(".boot-cursor").first();
      ok("the boot prompt has a cursor", (await cur.count()) === 1);
      const anim = await cur.evaluate((el) => getComputedStyle(el).animationName);
      ok("and it blinks like a terminal cursor", anim !== "none" && anim.length > 0, anim);
      const box = await cur.boundingBox();
      const shot = async () =>
        (await page.screenshot({ clip: box, animations: "allow" })).toString("base64");
      const a = await shot();
      await page.waitForTimeout(370);
      const b = await shot();
      await page.waitForTimeout(370);
      const c = await shot();
      ok("and the blink actually paints on and off",
        a !== b || b !== c, "sampled three frames across a 1.1s blink");
      await ctx.close();

      const ctx2 = await browser.newContext({
        viewport: { width: 420, height: 900 }, deviceScaleFactor: 2,
        colorScheme: "dark", reducedMotion: "reduce",
      });
      const p2 = await ctx2.newPage();
      await p2.goto("file://" + HTML_PATH);
      await p2.evaluate((s) => window.dispatchEvent(new MessageEvent("message",
        { data: { type: "stateSync", state: s } })),
        Object.assign({}, BASE, { session: { id: "s1", title: "", messages: [] } }));
      await p2.waitForTimeout(300);
      const c2 = p2.locator(".boot-cursor").first();
      const box2 = await c2.boundingBox();
      const r1 = (await p2.screenshot({ clip: box2, animations: "allow" })).toString("base64");
      await p2.waitForTimeout(560);
      const r2 = (await p2.screenshot({ clip: box2, animations: "allow" })).toString("base64");
      ok("and it holds still for a reader who asked for no motion", r1 === r2);
      await ctx2.close();
    }
  }

  /* ── 5u. the permission glyphs are a set, and all three paint ──────── */
  {
    // Manual's mark was a raised open palm, and it was the odd one out three
    // ways: a pictogram among geometric marks, a "stop" gesture on a mode that
    // does not stop but ASKS, and - measured - the thinnest ink of the three,
    // which at the 15px the composer draws it left a smudge rather than a
    // shape. It is a shield with a check now.
    //
    // A `<use href="#missing">` fails SILENTLY - empty shadow tree, no error,
    // no console message - so a rename that missed a call site would ship an
    // invisible icon. getBBox() is the only thing that catches it.
    const { ctx, page } = await open(420, {});
    await page.evaluate(() => window.dispatchEvent(new MessageEvent("message",
      { data: { type: "configChanged",
        config: { approvalMode: "edits-auto", activeProfile: "", caBundlePath: "", ui: {} } } })));
    await page.waitForTimeout(120);
    await page.click('.pick[data-pick="perm"]');
    await page.waitForTimeout(650);
    const rows = await page.evaluate(() => {
      return [...document.querySelectorAll(".perm-row")].map((r) => {
        const svg = r.querySelector("svg");
        const use = r.querySelector("use");
        const bb = svg && svg.getBBox ? svg.getBBox() : null;
        return {
          href: use ? use.getAttribute("href") : null,
          w: bb ? Math.round(bb.width) : 0,
          h: bb ? Math.round(bb.height) : 0,
          colour: svg ? getComputedStyle(svg).color : "",
        };
      });
    });
    ok("the mode sheet offers three modes", rows.length === 3, JSON.stringify(rows));
    for (const r of rows) {
      // Ink, not presence. This is the assertion the silent <use> failure
      // needs: a symbol that does not exist renders a 0x0 box and no error.
      ok(`${r.href} actually paints`, r.w > 0 && r.h > 0, JSON.stringify(r));
      // At 15px in the composer, a glyph thinner than this is a smudge. The
      // palm measured 8 wide; the shield measures 11.
      ok(`${r.href} carries enough ink to read at 15px`, r.w >= 9, JSON.stringify(r));
    }
    ok("Manual is no longer the raised palm",
      rows[0].href === "#i-shield", JSON.stringify(rows));
    // The three are coloured differently on purpose - cream, purple, red - and
    // that is the whole signal for which mode is armed. Identical colours
    // would make the sheet three rows of the same thing.
    ok("the three modes are told apart by colour as well as by name",
      new Set(rows.map((r) => r.colour)).size === 3, JSON.stringify(rows.map((r) => r.colour)));
    await ctx.close();

    /* And the glyph on the row carries the same mark, so the sheet and the
       thing that states the mode cannot disagree about which one is on.
       Opened with a non-default mode on purpose: the default takes no plate,
       which is the rule the whole picked group is built on. */
    const { ctx: c2, page: p2 } = await open(420, { config: { ui: {}, approvalMode: "edits-auto" } });
    const btn = await p2.evaluate(() => {
      const use = document.querySelector('.pick[data-pick="perm"] use');
      const svg = document.querySelector('.pick[data-pick="perm"] svg');
      const bb = svg && svg.getBBox ? svg.getBBox() : null;
      return { href: use ? use.getAttribute("href") : null, w: bb ? Math.round(bb.width) : 0 };
    });
    ok("the glyph on the row matches the mode's own mark",
      btn.href === "#i-code", JSON.stringify(btn));
    ok("and it paints there too", btn.w > 0, JSON.stringify(btn));
    await c2.close();
  }

  /* ── 5v. the + joins the glyphs; send stays the primary action ─────── */
  {
    /* THE PREMISE OF THIS SECTION CHANGED WITH THE DESIGN.
     *
     * It used to pin mode, attach and send as three controls of identical
     * geometry. The chatbox design breaks that on purpose: the + is the last
     * item of the picked-feature tray and takes the tray's 22px, while send
     * stays the largest control in the row because it is the primary action.
     * So "all the same size" is no longer the promise - what is, is that the +
     * matches the glyphs it sits among, send outweighs it, and a wrap still
     * never separates them. That last one is the reason the group exists. */
    for (const width of [300, 360, 420, 520, 700]) {
      const { ctx, page } = await open(width, { activeAgent: "reviewer",
        agents: [{ name: "reviewer", description: "d", tools: [], skills: [] }] });
      const m = await page.evaluate(() => {
        const ids = ["attachBtn", "sendBtn"];
        const box = (id) => {
          const e = document.getElementById(id);
          const r = e.getBoundingClientRect();
          return { id, w: Math.round(r.width), h: Math.round(r.height),
                   top: Math.round(r.top), mid: Math.round(r.top + r.height / 2),
                   inGroup: !!e.closest(".tb-actions") };
        };
        const b = ids.map(box);
        const g = document.querySelector('.pick[data-pick="agent"]');
        b.push({ id: "glyph", w: g ? Math.round(g.getBoundingClientRect().width) : 0,
                 mid: g ? Math.round(g.getBoundingClientRect().top +
                                     g.getBoundingClientRect().height / 2) : 0 });
        // Hit-tested, because a control that is the right size in the right
        // place and covered by something else is still unusable.
        const hit = ids.map((id) => {
          const e = document.getElementById(id);
          const r = e.getBoundingClientRect();
          const at = document.elementFromPoint(
            Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
          return !!at && (at === e || e.contains(at));
        });
        return { b, hit };
      });
      const [attach, send, glyph] = m.b;
      /* THE + LEFT THE ACTION GROUP, on purpose: it is the last item of the
         glyph tray now, which sits at the other end of the row. So "one group"
         is no longer the property - what replaced it is that the + belongs to
         the TRAY (it matches the glyphs and travels with them) while send
         stays at the end, and a wrap never puts them on different lines. */
      ok(`send stays in the action group at ${width}px`,
        send.inGroup, JSON.stringify(m.b));
      ok(`and the + rides with the glyph tray at ${width}px`,
        !attach.inGroup, JSON.stringify(m.b));
      // Measured against the glyph beside it rather than a literal, so a change
      // to the tray's size moves the + with it instead of failing here.
      ok(`the + matches the glyphs it sits among at ${width}px`,
        glyph.w > 0 && attach.w === glyph.w, JSON.stringify(m.b));
      ok(`and send outweighs it, being the primary action at ${width}px`,
        send.w > attach.w && send.h > attach.h, JSON.stringify(m.b));
      /* CENTRES, not tops. Two controls of different heights on one row have
         different tops by definition; comparing tops only ever worked while
         they were the same size, and would now fail on a row that is correct. */
      ok(`and all three sit on one line at ${width}px`,
        attach.mid === send.mid && attach.mid === glyph.mid, JSON.stringify(m.b));
      ok(`and both are clickable at ${width}px`,
        m.hit.every(Boolean), JSON.stringify({ hit: m.hit, b: m.b }));
      await ctx.close();
    }

    /* The mode is still ANNOUNCED, and that now has to hold in TWO states,
       because the design only draws the mode while it is non-default.
       A glyph plus a colour is nothing to a screen reader, and the DEFAULT
       mode draws no glyph at all - so at rest the only thing carrying the
       answer is the off-screen name and the palette's own row. */
    const { ctx, page } = await open(420, {});
    const atRest = await page.evaluate(() => ({
      // No plate on the row while nothing is switched away from its default.
      glyph: !!document.querySelector('.pick[data-pick="perm"]'),
      text: (document.getElementById("permName") || {}).textContent,
    }));
    ok("the default mode draws no glyph, as the design has it", !atRest.glyph);
    ok("but its name is still in the DOM for a screen reader",
      /manual/i.test(atRest.text || ""), JSON.stringify(atRest));
    await ctx.close();

    // Switched away from the default, the glyph appears and has to say what it
    // is - it is the only thing on the row carrying the mode at that point.
    const { ctx: c3, page: p3 } = await open(420, { config: { ui: {}, approvalMode: "full-auto" } });
    const named = await p3.evaluate(() => {
      const g = document.querySelector('.pick[data-pick="perm"]');
      return g ? { title: g.title, aria: g.getAttribute("aria-label") } : { missing: true };
    });
    ok("a non-default mode draws its glyph", !named.missing, JSON.stringify(named));
    ok("whose tooltip names the mode", /auto/i.test(named.title || ""), JSON.stringify(named));
    ok("and whose accessible name names it too",
      /auto/i.test(named.aria || ""), JSON.stringify(named));
    /* It used to say "click to return to Manual", because the plate cleared
       itself like every other glyph. It opens the SHEET now - the palette's
       Approvals row is gone, and if this cleared then full-auto would be
       reachable from nowhere. So what it must say is that it leads somewhere. */
    ok("and says that clicking it leads to the choice",
      /change/i.test(named.title || ""), JSON.stringify(named));
    await c3.close();
  }

  /* ── 5w. attach reaches the LOCAL machine, not the extension host ───── */
  {
    // `showOpenDialog` runs on the extension host. In a WSL, dev container,
    // SSH or Codespaces window that host is the remote machine, so the dialog
    // browses the remote disk and a file on the user's own Desktop cannot be
    // attached through it. Reported from exactly that setup.
    //
    // The webview renderer is always local, so a file input here opens the
    // user's own OS picker whatever the window is attached to.
    const { ctx, page } = await open(420, {});
    const input = await page.evaluate(() => {
      const el = document.getElementById("localPick");
      if (!el) return { missing: true };
      const cs = getComputedStyle(el);
      return {
        tag: el.tagName, type: el.type, multiple: el.multiple,
        // display:none / visibility:hidden inputs are not focusable and some
        // engines refuse to open a picker for one, so the offscreen trick has
        // to survive: it must be rendered, just not seen.
        display: cs.display, visibility: cs.visibility,
      };
    });
    ok("the panel carries a local file input", !input.missing, JSON.stringify(input));
    ok("and it accepts more than one file", input.multiple === true, JSON.stringify(input));
    ok("and it is rendered, not display:none, so the picker will open",
      input.display !== "none" && input.visibility !== "hidden", JSON.stringify(input));

    // The consequence: choosing Upload from the attach menu must NOT ask the
    // host to open its dialog, because that dialog is on the wrong machine.
    await page.evaluate(() => { window.__sent.length = 0; });
    await page.click("#attachBtn");
    await page.click('#cmdPal [data-pal="upload"]');
    await page.waitForTimeout(150);
    const sent = await page.evaluate(() => window.__sent.map((m) => m.type));
    ok("choosing Upload does not route to the host's dialog",
      !sent.includes("attachFiles"), JSON.stringify(sent));
    await ctx.close();
  }

  /* ── 5x. a file can be dropped anywhere on the panel ────────────────── */
  {
    // The drop listeners were bound to `.composer`, so a file let go over the
    // transcript - most of the panel, and the obvious place to aim - hit the
    // document guard that stops the webview navigating to the file, and did
    // nothing. Silently: no outline, no error, no attachment.
    const { ctx, page } = await open(420, {});
    const r = await page.evaluate(() => {
      // A real DataTransfer carrying a real File, so this exercises the same
      // path an OS drag takes rather than a shape invented for the test.
      const dt = new DataTransfer();
      dt.items.add(new File(["hello from the desktop"], "notes.txt", { type: "text/plain" }));
      const log = document.getElementById("log");
      const fire = (el, type) => {
        const ev = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt });
        el.dispatchEvent(ev);
        return ev;
      };
      fire(log, "dragenter");
      const over = fire(log, "dragover");
      const lit = document.querySelector('.composer[data-drop="1"]') !== null;
      fire(log, "drop");
      return {
        // A cancelled dragover is what tells the OS the drop will be accepted.
        accepted: over.defaultPrevented,
        // The composer still carries the highlight, because that is where the
        // file is going even when the pointer is over the transcript.
        highlighted: lit,
      };
    });
    ok("a drag over the transcript is accepted", r.accepted === true, JSON.stringify(r));
    ok("and the composer shows where it will land", r.highlighted === true, JSON.stringify(r));
    // FileReader is async, so the attachment lands a tick later.
    await page.waitForTimeout(300);
    const got = await page.evaluate(() =>
      [...document.querySelectorAll("#attachStrip [data-att-rm]")].length ||
      document.querySelectorAll("#attachStrip .att").length);
    ok("and the file dropped on the transcript is actually attached", got > 0, String(got));
    await ctx.close();
  }

  /* ── 5y. the command in a tool card, painted and unharmed ──────────── */
  {
    /* THIS SECTION EXISTS BECAUSE THE IN ROW BECAME innerHTML.
    
       It used to be `cmd.textContent = args.command`, which cannot inject
       anything no matter what the string holds. It is now
       `cmd.innerHTML = highlight(...)`, which is only safe while `highlight`
       escapes every byte it emits - both the spans it builds and the text it
       skips over. That is a claim about a regex-driven tokeniser, and
       `markdown-render.cjs` checks it against a copy of the function lifted
       out of source. This checks the SHIPPED panel, with a real DOM, because
       "it escaped in a string comparison" and "it did not become an element"
       are different questions.
    
       A command reaches here from the model. It is exactly the string an
       attacker controls if they control the model's output. */
    const open2 = async (command, result, isError) => {
      const { ctx, page } = await open(460, {});
      const send = (d) => page.evaluate(
        (m) => window.dispatchEvent(new MessageEvent("message", { data: m })), d);
      await send({ type: "toolStart", tool: { name: "run_command", args: { command } } });
      await page.waitForTimeout(60);
      await send({ type: "toolEnd", tool: {
        name: "run_command", args: { command }, result, isError: !!isError } });
      await page.waitForTimeout(200);
      await page.evaluate(() => {
        const h = document.querySelector(".tool .tool-head");
        if (h) h.click();
      });
      await page.waitForTimeout(200);
      return { ctx, page };
    };

    const HOSTILE = [
      'echo "<img src=x onerror=alert(1)>"',
      'git commit -m "</span><script>alert(1)</script>"',
      "ls && echo '<b>bold</b>' > /tmp/x",
      'curl "https://x/?a=1&b=2" -H "X-Y: <z>"',
      // A closing span in the middle of a token, which is the shape that
      // breaks a tokeniser that concatenates without escaping.
      'npm run "</span></span>oops"',
    ];
    for (const command of HOSTILE) {
      const { ctx, page } = await open2(command, "done");
      const m = await page.evaluate(() => {
        const el = document.querySelector(".term-cmd-text");
        if (!el) return { missing: true };
        return {
          text: el.textContent,
          // Elements the payload tried to create. Counted inside the card
          // rather than the document, so a legitimate <span> elsewhere is not
          // mistaken for a break-out.
          scripts: el.querySelectorAll("script,img,iframe,object,embed").length,
          // Only the tokeniser's own spans may exist in here.
          foreign: [...el.querySelectorAll("*")]
            .filter((n) => n.tagName !== "SPAN" || !/^tk-/.test(n.className)).length,
        };
      });
      ok(`a hostile command creates no elements: ${command.slice(0, 34)}`,
        !m.missing && m.scripts === 0, JSON.stringify(m));
      ok("and nothing but the tokeniser's own spans",
        m.foreign === 0, JSON.stringify(m));
      /* THE ROUND TRIP, which is the assertion that catches both failures at
         once: markup injected would ADD characters, and a regex whose matches
         overlap would silently LOSE them. Byte-for-byte or it is wrong. */
      ok("and the command reads back exactly as it was given",
        m.text === command, JSON.stringify({ got: m.text, want: command }));
      await ctx.close();
    }

    /* The corpus. Real command shapes, checked for the same round trip and for
       the command name actually being painted in the shipped panel - which is
       a different thing from `highlight()` returning a span in a unit test. */
    const CORPUS = [
      ["npm run verify", ["npm"], ["run", "verify"]],
      ["cd media/webview && npm test | grep -c PASS", ["cd", "npm", "grep"], ["media/webview"]],
      ["./scripts/build.sh --watch", ["./scripts/build.sh"], []],
      ["git log --oneline -3; ls -la", ["git", "ls"], []],
      ["python3 -m pytest -q", ["python3"], []],
      ["docker compose up -d && docker ps", ["docker"], ["compose", "up"]],
    ];
    for (const [command, wantCmd, wantPlain] of CORPUS) {
      const { ctx, page } = await open2(command, "ok");
      const m = await page.evaluate(() => {
        const el = document.querySelector(".term-cmd-text");
        // GUARDED, because an unguarded null here does not fail this
        // assertion - it throws out of the harness and takes every section
        // after it with it, reporting one line that names no test. That is
        // how a selector going stale hid itself: the suite stopped rather
        // than failed. A missing element is a FAIL like any other.
        if (!el) return { missing: true };
        return {
          text: el.textContent,
          cmds: [...el.querySelectorAll(".tk-cmd")].map((n) => n.textContent),
          // Everything the tokeniser coloured, whatever the class.
          painted: [...el.querySelectorAll("[class^=tk-]")].map((n) => n.textContent),
        };
      });
      ok(`"${command}" reads back exactly`, !m.missing && m.text === command,
        JSON.stringify({ got: m.text }));
      for (const c of wantCmd) {
        ok(`  and paints "${c}" as a command`, (m.cmds || []).includes(c), JSON.stringify(m.cmds));
      }
      for (const p of wantPlain) {
        ok(`  and does not paint "${p}" as one`,
          !m.missing && !m.cmds.includes(p), JSON.stringify(m.cmds));
      }
      await ctx.close();
    }

    /* The command's colour has to be READABLE where it actually sits.
    
       The token behind `.tk-cmd` is checked against the panel ground by
       contrast.cjs, but that is not where this lands: the boxes are gone, so
       the command sits on the tool card's own surface, which is a wash over
       whatever the workbench is showing through. Composited, not declared -
       so it is measured in the page rather than computed from a token. */
    {
      const { ctx, page } = await open2("npm run verify", "ok");
      const r = await page.evaluate(() => {
        const span = document.querySelector(".term-cmd-text .tk-cmd");
        if (!span) return { missing: true };
        const rgb = (s) => (s.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
        // Walk up for the first ancestor that actually paints, which is what
        // the eye sees behind the text.
        let el = span.parentElement, bg = null;
        while (el) {
          const c = getComputedStyle(el).backgroundColor;
          const p = (c.match(/[\d.]+/g) || []).map(Number);
          if (p.length >= 3 && (p.length < 4 || p[3] > 0)) { bg = c; break; }
          el = el.parentElement;
        }
        const lum = (c) => {
          const [r, g, b] = rgb(c).map((v) => {
            const s = v / 255;
            return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
          });
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        const fg = getComputedStyle(span).color;
        const [hi, lo] = [lum(fg), lum(bg || "rgb(24,24,24)")].sort((a, b) => b - a);
        return { fg, bg, weight: getComputedStyle(span).fontWeight,
                 ratio: (hi + 0.05) / (lo + 0.05) };
      });
      ok("the command colour is measurable", !r.missing, JSON.stringify(r));
      /* 4.5:1. This is not an accent or a rail - it is the text of the command
         the user is being asked to approve, so it is body text and takes the
         body-text bar. */
      ok("and reaches 4.5:1 where it is actually painted",
        r.ratio >= 4.5, `${(r.ratio || 0).toFixed(2)}:1 (${r.fg} on ${r.bg})`);
      await ctx.close();
    }
  }

  /* ── 5z. the tool card is rails, not nested boxes ───────────────────── */
  {
    /* Reported against a screenshot: a filled, bordered, rounded panel inside
       a bordered card inside a bordered card. `.term-block` earns that
       treatment in the transcript, where it is an object among prose; inside
       a tool card it is the card's own content, and the nesting made the
       command and its result read as two unrelated artefacts. */
    const { ctx, page } = await open(460, {});
    const send = (d) => page.evaluate(
      (m) => window.dispatchEvent(new MessageEvent("message", { data: m })), d);
    await send({ type: "toolStart", tool: { name: "run_command", args: { command: "npm test" } } });
    await page.waitForTimeout(60);
    await send({ type: "toolEnd", tool: {
      name: "run_command", args: { command: "npm test" }, result: "3 passed", isError: false } });
    await page.waitForTimeout(200);
    await page.evaluate(() => document.querySelector(".tool .tool-head").click());
    await page.waitForTimeout(200);

    const m = await page.evaluate(() => {
      const box = (el) => {
        if (!el) return null;
        const cs = getComputedStyle(el);
        return {
          bg: cs.backgroundColor, radius: cs.borderTopLeftRadius,
          top: cs.borderTopWidth, right: cs.borderRightWidth, bottom: cs.borderBottomWidth,
          left: cs.borderLeftWidth, leftColor: cs.borderLeftColor,
        };
      };
      return {
        // The one surface the exchange now shares.
        term: box(document.querySelector(".tool-body .term")),
        terms: document.querySelectorAll(".tool-body .term").length,
        // The result block nested inside it, which must have been stripped of
        // its own chrome so the card is not a box inside a box.
        nested: box(document.querySelector(".tool-body .term .term-out .term-block")),
        prompt: (document.querySelector(".tool-body .term-prompt") || {}).textContent,
        cmd: (document.querySelector(".tool-body .term-cmd-text") || {}).textContent,
        out: (document.querySelector(".tool-body .term-out") || {}).textContent,
      };
    });
    const transparent = (c) => /rgba\(0, 0, 0, 0\)|transparent/.test(c);
    /* ONE box for the exchange, not two. A command and its output are one
       thing that happened, and the old pair of bordered blocks behind IN/OUT
       tags read as two unrelated artefacts. */
    ok("the command and its output share one surface", m.terms === 1, String(m.terms));
    ok("which is the box: it keeps its border and its rail",
      !!m.term && parseFloat(m.term.left) >= 2 && m.term.top === "1px", JSON.stringify(m.term));
    ok("and its corners", !!m.term && m.term.radius !== "0px", JSON.stringify(m.term));
    /* And nothing boxed INSIDE it. This is what the section is named for: the
       nested result block is de-chromed so the surface is the only object. */
    ok("the nested result block has no fill of its own",
      !!m.nested && transparent(m.nested.bg), JSON.stringify(m.nested));
    ok("and no box around it", !!m.nested && m.nested.top === "0px" &&
      m.nested.right === "0px" && m.nested.bottom === "0px" && m.nested.left === "0px",
      JSON.stringify(m.nested));
    ok("and no rounded corners", !!m.nested && m.nested.radius === "0px",
      JSON.stringify(m.nested));
    /* The $ is what says which half is which, now that the two halves are one
       box: it marks the line that was TYPED, and the output is what is left. */
    ok("a $ prompt marks the command line", m.prompt === "$", JSON.stringify(m.prompt));
    ok("the command line carries what was run", /npm test/.test(m.cmd || ""), m.cmd);
    ok("and the output carries what came back", /3 passed/.test(m.out || ""), m.out);
    await ctx.close();

    // A FAILED run recolours the output rail, not the command's: what was run
    // is still what was run, and it is the result that went wrong.
    const { ctx: c2, page: p2 } = await open(460, {});
    const s2 = (d) => p2.evaluate(
      (mm) => window.dispatchEvent(new MessageEvent("message", { data: mm })), d);
    await s2({ type: "toolStart", tool: { name: "run_command", args: { command: "npm test" } } });
    await p2.waitForTimeout(60);
    await s2({ type: "toolEnd", tool: {
      name: "run_command", args: { command: "npm test" }, result: "1 failed", isError: true } });
    await p2.waitForTimeout(200);
    await p2.evaluate(() => document.querySelector(".tool .tool-head").click());
    await p2.waitForTimeout(200);
    const bad = await p2.evaluate(() => {
      const term = document.querySelector(".tool-body .term");
      const cmd = document.querySelector(".tool-body .term-cmd-text");
      const out = document.querySelector(".tool-body .term-out");
      if (!term || !cmd || !out) return { missing: true };
      const resolve = (name) => {
        const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
        const probe = document.createElement("span");
        probe.style.color = v; document.body.appendChild(probe);
        const rgb = getComputedStyle(probe).color; probe.remove();
        return rgb;
      };
      return {
        failMarked: term.classList.contains("term-fail"),
        rail: getComputedStyle(term).borderLeftColor,
        outBg: getComputedStyle(out).backgroundColor,
        cmdColour: getComputedStyle(cmd).color,
        errRgb: resolve("--kx-error"),
        err2Rgb: resolve("--kx-error-2"),
      };
    });
    ok("a failed run marks the surface", !bad.missing && bad.failMarked, JSON.stringify(bad));
    ok("and turns its rail red", bad.rail === bad.errRgb, JSON.stringify(bad));
    /* The OUTPUT is what went wrong, and it is the half that says so - a tint
       behind it rather than the whole card shouting. */
    ok("the output area takes the failure tint",
      !bad.missing && !/rgba\(0, 0, 0, 0\)/.test(bad.outBg), JSON.stringify(bad));
    /* And the command stays neutral: what was run is still what was run. This
       is the assertion the old two-rail version existed for, and it survives
       the redesign unchanged in meaning. */
    ok("and the command itself is left alone",
      !bad.missing && bad.cmdColour !== bad.errRgb && bad.cmdColour !== bad.err2Rgb,
      JSON.stringify(bad));
    await c2.close();
  }

  /* ── 6. the session list, as the reference draws it ────────────────── */
  {
    const { ctx, page } = await open(400, {
      sessions: [
        { id: "a", title: "why Master is sending 0x3E", when: "7m ago", count: 14 },
        { id: "b", title: "create an svg image editor", when: "4m ago", count: 4, running: true },
      ],
    }, { welcome: true });
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

    /* THE SECTION IS THE INVITATION NOW.
       This asserted a sentence - "pick up where you left off, or start
       something new" - which sat directly above two captions saying exactly
       that: `Recent` is the picking up and `Start here` is the something new.
       A line of copy introducing two labels that already say it is a line to
       cut, so what is pinned is the thing that actually invites. */
    ok("the welcome copy invites you back rather than introducing itself",
      /recent/i.test(text) && /start here/i.test(text), text.slice(0, 80));
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
