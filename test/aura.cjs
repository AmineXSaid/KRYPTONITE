/**
 * The composer's two states, and the rotating rim that used to draw them.
 *
 * THE AURA IS GONE. It was a conic gradient on the composer's border, turning
 * on focus and faster while streaming. It was removed at the owner's request,
 * and it deserved removing on its own terms: the sweep was clipped to the
 * BORDER box, which contains the padding box, and the layer meant to cover it
 * was `--kx-surface` - 4% white. So it never drew the 1px rim it was written
 * for; it washed the whole box you type into in a blue-to-green gradient.
 *
 * This file used to assert that machinery existed. It now asserts the
 * opposite, and that is not a test weakened to pass a change - the invariants
 * it protected are all still here, carried by something quieter:
 *
 *   - Focus must be a 3:1 affordance. The comment on the old rule already
 *     admitted the gradient could not be one and leaned on the wash ring - but
 *     the ring alone is 1.17:1 on the real ground, so it could not be one
 *     either. Focus now sets a SOLID border, and test/contrast.cjs measures it
 *     against both grounds and against the composer's own floor.
 *   - A running turn must still be visible where the user is looking, or
 *     `data-streaming` becomes an attribute nobody styles.
 *   - Neither state may change the border WIDTH, or the layout moves every
 *     time the model starts talking.
 *   - `overflow: hidden` must survive, or the pills and toolbar stop being
 *     clipped to the composer's corners.
 *   - The floor must survive every environment. That section is unchanged and
 *     is the most important thing in this file: it is the regression that
 *     reached a user's screen.
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
console.log("──── the rotating rim is gone, and stays gone ────");
{
  // Every piece of the machinery, named individually. A partial removal is
  // worse than none: an @property with no animation, or keyframes driving an
  // unregistered variable, is dead weight that reads as a live feature.
  ok("no @property --kx-angle registration", !/@property\s+--kx-angle/.test(CSS));
  ok("no kx-aura-spin keyframes", !/@keyframes\s+kx-aura-spin/.test(CSS));
  ok("no --kx-angle referenced anywhere", !/--kx-angle/.test(CSS));

  const focusRule = /\.composer:focus-within\s*\{([^}]*)\}/.exec(CSS);
  const streamRule = /\.composer\[data-streaming="1"\]\s*\{([^}]*)\}/.exec(CSS);
  ok("the composer still has a focus rule", !!focusRule);
  ok("and a streaming rule", !!streamRule);
  ok("neither paints a conic sweep",
    !!focusRule && !!streamRule &&
    !/conic-gradient/.test(focusRule[1]) && !/conic-gradient/.test(streamRule[1]),
    (focusRule ? focusRule[1] : "") + " | " + (streamRule ? streamRule[1] : ""));
  ok("and neither animates",
    !!focusRule && !!streamRule &&
    !/animation/.test(focusRule[1]) && !/animation/.test(streamRule[1]));
}

console.log("\n──── both states are still drawn, as solid borders ────");
{
  const focusRule = /\.composer:focus-within\s*\{([^}]*)\}/.exec(CSS);
  const streamRule = /\.composer\[data-streaming="1"\]\s*\{([^}]*)\}/.exec(CSS);
  const fc = focusRule && /border-color:\s*var\((--[\w-]+)\)/.exec(focusRule[1]);
  const sc = streamRule && /border-color:\s*var\((--[\w-]+)\)/.exec(streamRule[1]);

  // Focus needs a border because the wash ring cannot carry 3:1 on its own -
  // test/contrast.cjs does the measuring; this asserts the rule exists to be
  // measured.
  ok("focus sets a border colour", !!fc, focusRule ? focusRule[1].trim() : "no rule");
  ok("and keeps its halo ring",
    !!focusRule && /box-shadow:/.test(focusRule[1]), focusRule ? focusRule[1].trim() : "");
  ok("streaming sets a border colour", !!sc, streamRule ? streamRule[1].trim() : "no rule");

  // Different colours, because the two facts are independent and can both be
  // true: focus is where the keyboard is, streaming is what the model is doing.
  ok("the two states are told apart by colour",
    !!fc && !!sc && fc[1] !== sc[1], `${fc && fc[1]} vs ${sc && sc[1]}`);

  // Width, not colour, is what moves a layout.
  ok("neither state changes the border WIDTH",
    !!focusRule && !!streamRule &&
    !/border(-width)?:\s*\d/.test(focusRule[1]) && !/border(-width)?:\s*\d/.test(streamRule[1]));
}
{
  const composer = CSS.match(/\n\.composer\s*\{[^}]*\}/);
  ok("the composer still clips its children", !!composer && /overflow:\s*hidden/.test(composer[0]),
    composer ? composer[0].replace(/\s+/g, " ") : "not found");
  ok("and keeps a 1px border, so nothing moves between states",
    !!composer && /border:\s*1px/.test(composer[0]));
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

  // The aura rule this used to inspect is gone. The invariant it protected is
  // NOT about the aura, though - it is that nothing may reset the composer's
  // background-color out from under it, and `background:` is the shorthand
  // that does exactly that when its value turns out to be invalid.
  //
  // So the check generalises, and gets stricter: NO rule targeting .composer
  // may use the shorthand, not merely the one rule that once did. That covers
  // whatever gets added next, which is the failure mode - the aura was itself
  // "whatever got added next" the first time this broke.
  {
    const offenders = [];
    for (const m of css.matchAll(/(^|\n)([^\n{}]*\.composer[^\n{}]*)\{([^}]*)\}/g)) {
      const selector = m[2].trim();
      const body = m[3];
      // Pseudo-elements are overlays drawn ON the composer, not the composer's
      // own background - the drop veil is a literal rgba() by design and has
      // no floor to lose. Only the element's own rules are under this rule.
      if (/::(before|after)/.test(selector)) continue;
      if (/(^|[;{\s])background:/.test(body)) offenders.push(selector);
    }
    ok("no rule on the composer uses the background shorthand",
      offenders.length === 0, offenders.join(" | "));
  }

  // Every var() on a composer rule still needs a literal fallback: a token
  // that fails to resolve makes the declaration invalid at computed-value
  // time, and an invalid background takes the floor with it. This was the
  // aura's rule alone; it is every composer rule now, for the same reason.
  {
    const bare = [];
    for (const m of css.matchAll(/(^|\n)([^\n{}]*\.composer[^\n{}]*)\{([^}]*)\}/g)) {
      const selector = m[2].trim();
      if (/::(before|after)/.test(selector)) continue;
      for (const decl of m[3].split(";")) {
        if (!/background/.test(decl)) continue;
        for (const v of decl.match(/var\(--[a-z0-9-]+(?:,[^)]*)?\)/g) || []) {
          if (!v.includes(",")) bare.push(`${selector}: ${v}`);
        }
      }
    }
    ok("every background var() on the composer carries a fallback",
      bare.length === 0, bare.join(" | "));
  }
}


if (failures.length) for (const f of failures) console.log("FAIL  " + f);
console.log(`\n──── ${pass} passed, ${failures.length} failed ────`);
process.exitCode = failures.length ? 1 : 0;
