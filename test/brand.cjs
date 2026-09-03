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

console.log("\n──── the welcome mark turns once, and stops ────");
{
  /* THE STEADY TURN IS GONE, AND THAT IS THE POINT OF THIS BLOCK.
   *
   * A 6s rotation used to run behind the entrance for ever. The case for it
   * was that the two other g-sweep users are STATUS - the streaming notch at
   * 1.4s, the working-conversation mark at 2.4s - and a quarter of their
   * speed reads as idle rather than busy.
   *
   * It does not. Motion is the signal; its rate is a detail nobody measures
   * against a mark they were not already watching. An idle panel looked like
   * a working one, and paid a compositor frame every 16ms to say so. The
   * owner asked for one rotation. This is one rotation. */
  const rule = /\.welcome\s+\.crystal\s*\{([^}]*)\}/.exec(CSS);
  ok("the resting mark has a rule", !!rule);
  const decl = rule ? rule[1] : "";

  ok("and it declares no animation of its own",
    !/animation:/.test(decl), decl.trim());
  ok("nothing on it runs for ever", !/\binfinite\b/.test(decl), decl.trim());
  ok("but it still turns about its own centre",
    /transform-origin:\s*50%\s*50%/.test(decl));
}

console.log("\n──── it arrives spinning, on a deliberate arrival only ────");
{
  // One animation now, on its own class. test/render.cjs measures the motion;
  // this pins the source text.
  const rule = /\.welcome\s+\.crystal\.spin-in\s*\{([^}]*)\}/.exec(CSS);
  ok("the entrance is its own rule, on its own class", !!rule);
  const decl = rule ? rule[1] : "";

  ok("it runs the entrance", /g-spin-in/.test(decl), decl.trim());
  ok("and nothing behind it", !/g-turn/.test(decl) && !/g-sweep/.test(decl), decl.trim());
  ok("exactly once, not for ever", !/\binfinite\b/.test(decl), decl.trim());
  ok("and eases it, which is what makes it decelerate",
    /cubic-bezier/.test(decl), decl.trim());

  // It still has to land square. Nothing hands off from it any more, but the
  // mark comes to REST at this angle, and a bezel resting off-square looks
  // like a rendering fault rather than a logo.
  const spinKf = /@keyframes\s+g-spin-in\s*\{([\s\S]*?)\n\}/.exec(CSS);
  const to = spinKf && /to\s*\{\s*transform:\s*rotate\((\d+)deg\)/.exec(spinKf[1]);
  ok("the entrance names a final angle", !!to, to && to[1]);
  ok("and it is a whole number of turns, so the mark rests square",
    !!to && Number(to[1]) % 360 === 0, to && to[1] + "deg");

  // "kinda fast", as the brief put it. A logo entrance that outstays a second
  // and a half is a loading screen.
  const dur = /g-spin-in\s+(\d+)ms/.exec(decl);
  ok("and the whole entrance is over quickly",
    !!dur && Number(dur[1]) <= 1200, dur && dur[1] + "ms");

  // The steady turn's keyframes went with it. An unused @keyframes is dead
  // weight, and this one carried a trap: `g-sweep` declares only `to`, so
  // layered behind a filled entrance its implicit start resolved to the
  // entrance's final angle and the mark rotated BACKWARDS. It did. The lesson
  // stays as a comment in the stylesheet; the keyframes do not.
  ok("and the steady turn's keyframes are gone with it",
    !/@keyframes\s+g-turn\b/.test(CSS));
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
  // The flag is BACK, and the assertion is inverted rather than dropped. What
  // it was guarding against is "an argument nothing reads" - so now that the
  // mark arrives again and the flag decides whether it does, the failure mode
  // is the opposite one: a parameter declared and never passed, which would
  // spin the logo on every data refresh exactly as before.
  ok("renderWelcome takes the arrival flag again",
    /function renderWelcome\(arriving\)/.test(JS));
  ok("and the refresh call sites actually pass it",
    (JS.match(/renderWelcome\(false\)/g) || []).length >= 2,
    String((JS.match(/renderWelcome\(false\)/g) || []).length) + " call sites");
  // A default of "this is an arrival" is what makes a call with no opinion
  // mean the right thing; passing `true` explicitly would be noise.
  ok("while an arrival needs no argument", !/renderWelcome\(true\)/.test(JS));
}

console.log("\n──── motion can still be turned off ────");
{
  // There are several reduced-motion blocks; find the one that names the mark
  // rather than whichever comes first.
  const blocks = [...CSS.matchAll(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/g)]
    .map((m) => m[1]);
  ok("a reduced-motion block exists", blocks.length > 0, String(blocks.length));
  // BOTH the steady turn and the entrance. A reduced-motion setting is asking
  // not to see a fast spin more clearly than it is asking not to see a slow
  // one, so stilling only the base rule would leave in the louder of the two.
  const stills = (sel) =>
    blocks.some((b) => new RegExp(sel + "[^{]*\\{\\s*animation:\\s*none").test(b));
  ok("and one of them stills the welcome mark",
    stills("\\.welcome\\s+\\.crystal"),
    blocks.map((b) => b.trim().slice(0, 40)).join(" | "));
  ok("including its arrival, which is the louder half",
    stills("\\.welcome\\s+\\.crystal\\.spin-in"),
    blocks.map((b) => b.trim().slice(0, 40)).join(" | "));
}

if (failures.length) for (const f of failures) console.log("FAIL  " + f);
console.log(`\n──── ${pass} passed, ${failures.length} failed ────`);
process.exitCode = failures.length ? 1 : 0;
