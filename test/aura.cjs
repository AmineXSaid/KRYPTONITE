/**
 * The composer's aura: the one animated gradient in the product.
 *
 * Half of this is a CSS-text test, which is unusual and deliberate. jsdom does
 * not implement `@property`, does not interpolate registered custom
 * properties, and does not run animations, so there is no DOM assertion that
 * can tell a working aura from a broken one. What *can* be pinned is the set
 * of decisions the thing depends on, each of which is a silent failure if
 * removed:
 *
 *   - Without the `@property` registration the browser cannot interpolate
 *     between two angles. The animation still "runs", the rim never turns,
 *     and nothing anywhere reports an error.
 *   - Without the reduced-motion block a user who asked the OS to stop
 *     animating gets a spinning border anyway.
 *   - Without the focus ring the aura becomes the focus indicator, and a
 *     gradient is not a 3:1 affordance - parts of any sweep are low-contrast
 *     against the surface behind it.
 *   - Without `overflow: hidden` the pills and the toolbar stop being clipped
 *     to the composer's rounded corners.
 *
 * The real interpolation was verified in a browser by driving the animation's
 * currentTime to 600ms of its 2400ms cycle and reading --kx-angle back as
 * 90deg, which is exactly a quarter turn. That cannot be automated here
 * without shipping a headless browser to run the stylesheet in.
 *
 * Run: node test/aura.cjs
 */
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; return; }
  failures.push(label + (detail ? "  — " + detail : ""));
}

const ROOT = path.join(__dirname, "..");
const CSS = fs.readFileSync(path.join(ROOT, "media/webview/sidebar.css"), "utf8");

/* ── the stylesheet ─────────────────────────────────────────────────────── */
console.log("──── the rules the aura depends on ────");
{
  const prop = CSS.match(/@property\s+--kx-angle\s*\{[^}]*\}/);
  ok("the angle is a registered custom property", !!prop);
  ok("declared as an <angle>, so the browser can interpolate it",
    !!prop && /syntax:\s*"<angle>"/.test(prop[0]), prop ? prop[0].replace(/\s+/g, " ") : "");
  ok("with an initial value, so the first frame is not invalid",
    !!prop && /initial-value:\s*0deg/.test(prop[0]));

  const frames = CSS.match(/@keyframes\s+kx-aura-spin\s*\{[^}]*\}[^}]*\}/);
  ok("there is a keyframe animation", !!frames);
  ok("and it drives the registered angle a full turn",
    !!frames && /--kx-angle:\s*360deg/.test(frames[0]));
}
{
  // Both triggers. Focus alone would leave the streaming case dead, and the
  // streaming case is the one the feature is for.
  ok("focus lights the aura", /\.composer:focus-within[^{]*\{[\s\S]{0,400}?conic-gradient/.test(CSS));
  ok("and so does streaming", /\[data-streaming="1"\]/.test(CSS));
  ok("streaming runs faster than idle focus",
    /\[data-streaming="1"\]\s*\{\s*animation-duration:\s*2\.4s/.test(CSS));

  // Painted through a transparent border rather than over the content: the
  // technique is what lets `overflow: hidden` survive.
  //
  // The boxes are now set by the `background-clip` / `background-origin`
  // longhands rather than by per-layer keywords inside a `background`
  // shorthand - see the floor test at the bottom of this file for why the
  // shorthand had to go. The invariant is unchanged and is what is asserted:
  // layer one (the surface) is clipped to the padding box, layer two (the
  // sweep) to the border box, IN THAT ORDER. Reverse them and the gradient
  // is painted over the content instead of showing through the border.
  ok("the surface layer is declared before the sweep", (() => {
    const img = /background-image:\s*([\s\S]*?);/.exec(CSS);
    if (!img) return false;
    const lin = img[1].indexOf("linear-gradient");
    const con = img[1].indexOf("conic-gradient");
    return lin !== -1 && con !== -1 && lin < con;
  })());
  ok("the surface is clipped to the padding box and the sweep to the border box",
    /background-clip:\s*padding-box,\s*border-box/.test(CSS));
  ok("and both layers originate from the matching boxes",
    /background-origin:\s*padding-box,\s*border-box/.test(CSS));
}
{
  const composer = CSS.match(/\n\.composer\s*\{[^}]*\}/);
  ok("the composer still clips its children", !!composer && /overflow:\s*hidden/.test(composer[0]),
    composer ? composer[0].replace(/\s+/g, " ") : "not found");
  // A border that changes width between states would move the layout every
  // time the model started talking.
  ok("and keeps a 1px border, so nothing moves when the aura lights",
    !!composer && /border:\s*1px/.test(composer[0]));
}
{
  const focus = CSS.match(/\.composer:focus-within\s*\{\s*box-shadow:[^}]*\}/);
  ok("the focus ring survives alongside the aura", !!focus,
    "a gradient is not a 3:1 focus indicator on its own");

  const reduced = CSS.split("@media (prefers-reduced-motion: reduce)")
    .find((b) => /data-streaming/.test(b));
  ok("reduced motion is honoured", !!reduced);
  ok("by stopping the animation rather than hiding the rim",
    !!reduced && /animation:\s*none/.test(reduced));
}
{
  // The palette, not a rainbow. Three accents this panel already owns.
  const conic = CSS.match(/conic-gradient\(([\s\S]*?)\n\s*\);/);
  ok("the sweep uses the product's own accents", !!conic &&
    ["--kx-accent", "--kx-link", "--kx-under"].every((t) => conic[1].includes(t)),
    conic ? conic[1].replace(/\s+/g, " ").slice(0, 90) : "not found");
  ok("and closes the loop, so there is no seam at 360deg",
    !!conic && (conic[1].match(/--kx-accent/g) || []).length >= 2);
}

/* ── the attribute the CSS reads ────────────────────────────────────────── */
console.log("\n──── the host tells the composer it is streaming ────");
{
  const crystal = fs.readFileSync(path.join(ROOT, "media/webview/crystal.js"), "utf8");
  const src = fs.readFileSync(path.join(ROOT, "media/webview/sidebar.js"), "utf8");
  const dom = new JSDOM(`<!doctype html><html><body><div id="root"></div></body></html>`, {
    runScripts: "outside-only", pretendToBeVisual: true,
  });
  const w = dom.window;
  if (!w.TextEncoder) w.TextEncoder = TextEncoder;
  w.__kx = { api: { postMessage: () => {}, getState: () => null, setState: () => {} } };
  w.eval(crystal);
  w.eval(src);

  const state = (running) => ({ type: "stateSync", state: {
    workspace: { open: true, name: "r" }, running, phase: "act",
    status: { state: "ok", label: "OK" }, endpoint: "gw",
    profiles: [{ id: "gw", status: "ready", active: true, model: "m", wire: "openai",
      baseUrl: "https://x", capabilities: { contextWindow: 128000 } }],
    skills: [], skillWarnings: [], config: { ui: {} }, tlsError: null, rungs: [],
    tracing: false, todos: [], checkpoints: [], sessions: [], selection: null,
    context: null, models: [], logs: [], session: { id: "s", title: "t", messages: [] },
  } });
  const send = (m) => w.dispatchEvent(new w.MessageEvent("message", { data: m }));
  const attr = () => w.document.querySelector(".composer").getAttribute("data-streaming");

  send(state(false));
  ok("an idle composer says so", attr() === "0", String(attr()));
  send(state(true));
  ok("a streaming one says so too", attr() === "1", String(attr()));
  send(state(false));
  ok("and it goes back when the turn ends", attr() === "0", String(attr()));
  dom.window.close();
}

/* ── the composer must never lose its floor ──────────────────────────────
 *
 * This is the regression that reached a user's screen: the composer rendered
 * TRANSPARENT, with the panel behind it showing through the box you type into.
 *
 * The cause was the `background` shorthand. It resets `background-color`, so
 * anything that made the aura declaration invalid at computed-value time took
 * the composer's surface down with it - and an invalid `background` computes
 * to `initial` (transparent), not to whatever an earlier rule said. Two real
 * environments do exactly that:
 *
 *   - an Electron without `@property` support, where `--kx-angle` is an
 *     unregistered custom property and `var(--kx-angle)` resolves to nothing;
 *   - any load where tokens.css did not apply, so every `--kx-*` is absent.
 *
 * The fix is structural, so the test is structural: the aura rule may not use
 * the shorthand, and every `var()` in it must carry a literal fallback.
 */
{
  const css = fs.readFileSync(path.join(ROOT, "media/webview/sidebar.css"), "utf8");

  // Anchored at the start of a line: `.composer-wrap[data-drop="1"] .composer`
  // also ends in `.composer {`, and an unanchored match finds the drop rule
  // instead of the base one.
  const composerBase = /\n\.composer \{([^}]*)\}/.exec(css);
  ok("the composer declares a floor", !!composerBase);
  if (composerBase) {
    const body = composerBase[1];
    ok("the floor is background-COLOR, not the shorthand",
      /background-color:/.test(body) && !/\bbackground:/.test(body), body.trim());
    ok("and it has a literal fallback, for a load with no tokens",
      /background-color:\s*var\(--kx-surface,\s*#[0-9a-f]{3,8}\)/i.test(body), body.trim());
  }

  const auraRule = /\.composer:focus-within,\s*\n\.composer\[data-streaming="1"\] \{([^}]*)\}/.exec(css);
  ok("the aura rule is present", !!auraRule);
  if (auraRule) {
    const body = auraRule[1];
    // The whole point. `background:` here is what made the composer vanish.
    ok("the aura never uses the background shorthand",
      !/(^|[;{\s])background:/.test(body), body.trim().slice(0, 120));
    ok("it paints with background-image", /background-image:/.test(body));
    ok("and sets clip and origin as longhands",
      /background-clip:\s*padding-box,\s*border-box/.test(body) &&
      /background-origin:\s*padding-box,\s*border-box/.test(body));
    // Without a fallback the unregistered-property case invalidates the whole
    // declaration, which is how this broke in the first place.
    ok("the angle carries a fallback, so no @property still draws a rim",
      /var\(--kx-angle,\s*0deg\)/.test(body), body.trim().slice(0, 120));
    const vars = body.match(/var\(--[a-z0-9-]+(?:,[^)]*)?\)/g) || [];
    const bare = vars.filter((v) => !v.includes(","));
    ok("every var() in the aura has a fallback", bare.length === 0, bare.join(" "));
  }
}

if (failures.length) for (const f of failures) console.log("FAIL  " + f);
console.log(`\n──── ${pass} passed, ${failures.length} failed ────`);
process.exitCode = failures.length ? 1 : 0;
