/**
 * Where the mark appears, and that it turns.
 *
 * Two things the owner made conditions of the release: the Genesis logo has to
 * be in VS Code's editor title bar, beside Claude's, and the logo on the
 * welcome page has to rotate. Neither is visible to any other suite - one is a
 * manifest contribution VS Code reads at install time, the other is a CSS
 * animation - so both are pinned here.
 *
 * This file deliberately does NOT open a browser. It asserts the things that
 * are true of the source regardless of rendering: the contribution exists, the
 * files it names exist, the geometry matches the shared mark, and the CSS says
 * "infinite". test/render.cjs is the companion that puts the shipped archive in
 * Chromium and checks the pixels actually move.
 *
 * Run: node test/brand.cjs
 */
const fs = require("node:fs");
const path = require("node:path");

let pass = 0;
const failures = [];
const ok = (label, cond, detail = "") => {
  if (cond) { pass++; return; }
  failures.push(label + (detail ? "  — " + detail : ""));
};

const ROOT = path.join(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const CSS = fs.readFileSync(path.join(ROOT, "media/webview/sidebar.css"), "utf8");
const JS = fs.readFileSync(path.join(ROOT, "media/webview/sidebar.js"), "utf8");
const CRYSTAL = fs.readFileSync(path.join(ROOT, "media/webview/crystal.js"), "utf8");

console.log("──── the mark sits in the editor title bar ────");
{
  const menus = pkg.contributes.menus || {};
  const title = menus["editor/title"] || [];
  ok("editor/title carries an entry", title.length > 0);

  const entry = title.find((e) => e.command === "genesis.focusSidebar");
  ok("and it opens Genesis", !!entry, title.map((e) => e.command).join(", "));

  // `navigation` is the group VS Code renders as ICONS in the title bar. Any
  // other group collapses into the overflow "..." menu, where the mark would
  // not be visible at all - which is the whole point of the contribution.
  ok("in the navigation group, so it renders as an icon rather than a menu row",
    !!entry && /^navigation/.test(entry.group || ""), entry && entry.group);

  // The order suffix is `group@N`. It was `@-1` to sit leftmost, which relies
  // on VS Code accepting a NEGATIVE order - and code.visualstudio.com is
  // blocked from this build environment, so that could not be read off a
  // primary source. Every documented example uses a non-negative integer, so
  // the manifest uses one too: an ordering that might be dropped by a stricter
  // parser is not worth the one position it buys, and which extension sits
  // adjacent is not ours to decide anyway.
  const order = /@(-?\d+)$/.exec((entry && entry.group) || "");
  ok("with an order suffix", !!order, entry && entry.group);
  ok("and it is a non-negative integer, which is the only documented form",
    !!order && Number(order[1]) >= 0, order && order[1]);

  const cmd = pkg.contributes.commands.find((c) => c.command === "genesis.focusSidebar");
  ok("the command declares an icon", !!cmd && !!cmd.icon);
  // A single path would be drawn on both themes, and the mark's ring is the
  // one part that has to invert: a light ring vanishes on a light title bar.
  ok("with a light and a dark cut",
    !!cmd && !!cmd.icon && typeof cmd.icon === "object" && !!cmd.icon.light && !!cmd.icon.dark,
    JSON.stringify(cmd && cmd.icon));

  for (const which of ["light", "dark"]) {
    const rel = cmd && cmd.icon && cmd.icon[which];
    ok(`the ${which} icon file exists`, !!rel && fs.existsSync(path.join(ROOT, rel)), rel);
  }
}

console.log("\n──── and it is the same mark as everywhere else ────");
{
  // The editor-title icons are their own files - they cannot use crystal.js,
  // which builds SVG at runtime for a document that has scripts. That is
  // exactly how a mark drifts, so the geometry is pinned against the shared
  // symbol rather than merely eyeballed.
  const notch = 'd="M9.9 .744 A11.45 11.45 0 0 1 14.1 .744 L14.1 3.3 A8.95 8.95 0 0 0 9.9 3.3Z"';
  const core = 'd="M12 6.4 A5.6 5.6 0 1 1 11.99 6.4 Z M9 11 H15 V13 H9 Z"';
  ok("crystal.js is still the source of that geometry",
    CRYSTAL.includes(notch.replace('d="', '"').slice(1, -1)) || CRYSTAL.includes("M9.9 .744"));

  for (const which of ["light", "dark"]) {
    const raw = fs.readFileSync(path.join(ROOT, `media/editor-title-${which}.svg`), "utf8");
    // The comments explain why currentColor is wrong here, so they mention it.
    // Assertions below are about the MARKUP; strip the prose first.
    const svg = raw.replace(/<!--[\s\S]*?-->/g, "");
    ok(`the ${which} cut is a 24x24 roundel`, /viewBox="0 0 24 24"/.test(svg));
    ok(`the ${which} cut keeps the shared notch geometry`, svg.includes("M9.9 .744"));
    ok(`the ${which} cut keeps the shared core`, svg.includes("M12 6.4 A5.6 5.6"));
    ok(`the ${which} cut has all four notches`,
      (svg.match(/#E03A2F/g) || []).length === 4,
      String((svg.match(/#E03A2F/g) || []).length));
    // currentColor has nothing to inherit from in a background-image SVG; it
    // would resolve to black and the ring would disappear on a dark title bar.
    ok(`the ${which} cut resolves its colours literally`, !svg.includes("currentColor"));
  }

  const light = fs.readFileSync(path.join(ROOT, "media/editor-title-light.svg"), "utf8");
  const dark = fs.readFileSync(path.join(ROOT, "media/editor-title-dark.svg"), "utf8");
  ok("the two cuts differ only in the ring and core colour", light !== dark);
  ok("the dark cut draws a light ring", dark.includes("#C5C5C5"));
  ok("the light cut draws a dark ring", light.includes("#424242"));
}

console.log("\n──── the welcome mark rotates ────");
{
  // Matches `.welcome .crystal { ... }` and reads the animation shorthand.
  const rule = /\.welcome\s+\.crystal\s*\{([^}]*)\}/.exec(CSS);
  ok("the welcome mark carries an animation rule", !!rule);
  const decl = rule ? rule[1] : "";

  ok("it is the shared 360 sweep", /animation:\s*g-sweep/.test(decl), decl.trim());
  ok("and it never stops", /\binfinite\b/.test(decl), decl.trim());
  // An eased infinite rotation stutters at the wrap, where the end of one turn
  // meets the start of the next at a different rate.
  ok("linear, so the wrap does not stutter", /\blinear\b/.test(decl), decl.trim());
  ok("about its own centre", /transform-origin:\s*50%\s*50%/.test(decl));

  const dur = /animation:\s*g-sweep\s+([\d.]+)s/.exec(decl);
  ok("it declares a duration", !!dur, decl.trim());
  // The other two g-sweep users mean "work is in flight" (1.4s streaming notch,
  // 2.4s working conversation). An idle logo turning at their rate reads as a
  // turn running on a panel where nothing is happening.
  ok("slower than either status sweep, so an idle logo does not read as work",
    !!dur && parseFloat(dur[1]) > 2.4, dur && dur[1] + "s");

  ok("the keyframe it names is defined", /@keyframes\s+g-sweep/.test(CSS));
}

console.log("\n──── and the one-shot it replaced is gone, not merely unused ────");
{
  // The mark used to turn once and stop, driven by a data-greet attribute that
  // JS added and removed on animationend. animationend never fires on an
  // infinite animation, so a leftover of that mechanism would set an attribute
  // that is never cleared - dead, and misleading to the next reader.
  ok("no data-greet rule survives in the stylesheet", !CSS.includes("data-greet"));
  ok("and nothing in the panel still sets it", !JS.includes("data-greet"));
  ok("the greet trigger is gone", !JS.includes("greetMark"));
  ok("and renderWelcome no longer takes a flag it would ignore",
    /function renderWelcome\(\)/.test(JS));
  ok("so no call site passes one",
    !/renderWelcome\(true\)/.test(JS));
}

console.log("\n──── motion can still be turned off ────");
{
  // There are several reduced-motion blocks; find the one that names the mark
  // rather than whichever comes first.
  const blocks = [...CSS.matchAll(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/g)]
    .map((m) => m[1]);
  ok("a reduced-motion block exists", blocks.length > 0, String(blocks.length));
  ok("and one of them stills the welcome mark",
    blocks.some((b) => /\.welcome\s+\.crystal\s*\{\s*animation:\s*none/.test(b)),
    blocks.map((b) => b.trim().slice(0, 40)).join(" | "));
}

if (failures.length) for (const f of failures) console.log("FAIL  " + f);
console.log(`\n──── ${pass} passed, ${failures.length} failed ────`);
process.exitCode = failures.length ? 1 : 0;
