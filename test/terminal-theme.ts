/**
 * The Genesis terminal palette, and the command that applies it.
 *
 * WHAT THIS SUITE IS FOR
 *
 * The panel and the integrated terminal sit side by side and are supposed to
 * read as one product. That only stays true if the terminal's colours are
 * DERIVED from the panel's tokens rather than copied once - so the assertions
 * below are mostly about the derivation still tracking `tokens.css`, not about
 * any particular hex value being pretty.
 *
 * Eleven ANSI slots come straight from a token and are checked byte for byte.
 * The other nine - cyan and eight brights - have no token to be equal to, so
 * they are checked by the PROPERTIES that make them belong to this palette:
 * a bright is lighter than its base and the same hue, and cyan is a sibling of
 * the blue rather than a colour from somewhere else.
 *
 * Run: npx esbuild test/terminal-theme.ts --bundle --outfile=dist/terminal-theme.cjs \
 *        --format=cjs --platform=node --target=node20 --alias:vscode=./test/vscode-stub.ts
 *      node dist/terminal-theme.cjs
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildPalette, colorCustomizations, token, toOklch, toRgb, hueGap,
  DIRECT, FONT_SETTINGS,
} from "../src/theme/palette";
import { applyTerminalTheme, revertTerminalTheme } from "../src/theme/terminal";
import { reset, makeContext, __cfg, __globalKeys } from "./vscode-stub";

let pass = 0;
const failures: string[] = [];
function ok(label: string, cond: boolean, detail = ""): void {
  if (cond) pass++;
  else failures.push(label + (detail ? "  - " + detail : ""));
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail && !cond ? "  - " + detail : ""}`);
}

const ROOT = path.resolve(".");
const CSS = fs.readFileSync(path.join(ROOT, "media/webview/tokens.css"), "utf8");
const P = buildPalette(CSS);

/** WCAG relative luminance and ratio, the same maths as test/contrast.cjs. */
function lum(hex: string): number {
  const [r, g, b] = toRgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function ratio(a: string, b: string): number {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const HUES = ["Black", "Red", "Green", "Yellow", "Blue", "Magenta", "Cyan", "White"];

(async () => {
  console.log("---- every slot is present and well formed ----");
  {
    const want = HUES.flatMap((h) => ["ansi" + h, "ansiBright" + h]);
    for (const slot of want) {
      ok(`${slot} exists`, typeof P.ansi[slot] === "string", JSON.stringify(P.ansi[slot]));
      ok(`${slot} is a hex colour`, /^#[0-9a-f]{6}$/i.test(P.ansi[slot] || ""), P.ansi[slot]);
    }
    ok("there are exactly sixteen ANSI colours",
      Object.keys(P.ansi).length === 16, String(Object.keys(P.ansi).length));
    ok("background and foreground are set",
      /^#[0-9a-f]{6}$/i.test(P.background) && /^#[0-9a-f]{6}$/i.test(P.foreground),
      `${P.background} / ${P.foreground}`);
  }

  console.log("\n---- the direct slots track tokens.css, byte for byte ----");
  {
    /* THE MAPPING IS WRITTEN OUT HERE, not imported from `DIRECT`.
    
       Reading the module's own table and checking the palette against it is
       tautological about the half that matters: point `ansiGreen` at
       `--kx-warn` and both sides move together, so the suite stays green while
       the terminal's green turns orange. Measured - that is exactly what the
       bite test did.
    
       Spelling the pairs out makes changing which token a slot uses a
       deliberate edit in two places, while the anti-drift property is
       unaffected: the VALUES still come from tokens.css at test time, so
       editing `--kx-accent` still carries to the terminal or fails here. */
    const EXPECTED: Record<string, string> = {
      background: "kx-bg",
      foreground: "kx-fg-2",
      ansiBlack: "kx-bg-deep",
      ansiRed: "kx-error",
      ansiGreen: "kx-accent",
      ansiYellow: "kx-warn",
      ansiBlue: "kx-link",
      ansiMagenta: "kx-agent",
      ansiWhite: "kx-fg-3",
      ansiBrightBlack: "kx-fg-4",
      ansiBrightWhite: "kx-fg",
    };
    ok("the module maps exactly the slots this suite knows about",
      DIRECT.length === Object.keys(EXPECTED).length &&
      DIRECT.every(([slot]) => slot in EXPECTED),
      DIRECT.map(([s]) => s).join(","));
    for (const [slot, name] of Object.entries(EXPECTED)) {
      const declared = DIRECT.find(([s]) => s === slot);
      ok(`${slot} is taken from --${name}`, !!declared && declared[1] === name,
        declared ? declared[1] : "(unmapped)");
      const expected = token(CSS, name);
      const actual =
        slot === "background" ? P.background : slot === "foreground" ? P.foreground : P.ansi[slot];
      ok(`and carries --${name}'s current value`, actual === expected, `${actual} vs ${expected}`);
    }
    // Foreground is fog, not cream. Using the emphasis colour as body text
    // leaves nothing louder for bold to be, which is a design decision worth
    // pinning rather than rediscovering.
    ok("foreground is the body colour, not the emphasis colour",
      P.foreground === token(CSS, "kx-fg-2") && P.foreground !== token(CSS, "kx-fg"),
      P.foreground);
  }

  console.log("\n---- the derived brights are the same colour, lighter ----");
  {
    for (const h of HUES) {
      const base = P.ansi["ansi" + h];
      const bright = P.ansi["ansiBright" + h];
      const b = toOklch(base), br = toOklch(bright);
      ok(`bright ${h} is lighter than ${h}`, br.L > b.L, `${b.L.toFixed(3)} -> ${br.L.toFixed(3)}`);

      /* Hue is only meaningful when there is chroma to have a hue OF. Black
         and white are near-neutral - chroma under 0.02 - and their hue angle
         is numerical noise that swings tens of degrees on a rounding. Checking
         it there would fail for a reason that says nothing about the colour. */
      if (b.C < 0.02) {
        ok(`${h} is near-neutral, so its hue is not asserted`, true,
          `C=${b.C.toFixed(3)}`);
        continue;
      }
      /* THE ASSERTION THAT CATCHES A NAIVE DERIVATION. Scaling RGB channels
         or clamping after an out-of-gamut conversion rotates the hue - yellow
         moved 11 degrees before `fromOklch` learned to reduce chroma instead.
         Two degrees is comfortably inside what gamut mapping costs and far
         outside what channel-clamping does. */
      ok(`bright ${h} keeps ${h}'s hue`, hueGap(b.h, br.h) <= 2,
        `${hueGap(b.h, br.h).toFixed(1)}deg`);
    }
  }

  console.log("\n---- cyan is a sibling of the blue, not a twin ----");
  {
    const blue = toOklch(P.ansi.ansiBlue);
    const cyan = toOklch(P.ansi.ansiCyan);
    // Genesis has no cyan token: tokens.css folds link, info and tab-position
    // into one blue. So cyan is built from the blue - and the one way that can
    // go wrong is producing something indistinguishable from it, which would
    // quietly cost the palette a slot.
    ok("cyan is clearly separated from blue in hue", hueGap(blue.h, cyan.h) >= 25,
      `${hueGap(blue.h, cyan.h).toFixed(1)}deg`);
    ok("but shares the blue's lightness, so it belongs to the family",
      Math.abs(blue.L - cyan.L) < 0.02, `${blue.L.toFixed(3)} vs ${cyan.L.toFixed(3)}`);
    ok("and is not simply the blue", P.ansi.ansiCyan !== P.ansi.ansiBlue, P.ansi.ansiCyan);
  }

  console.log("\n---- every colour is visible on the ground ----");
  {
    /* 3:1, not 4.5:1. These are ANSI slots, and several are DIM text by
       design - bright-black is what a shell uses for a comment or a hint, and
       demanding 4.5 there would be demanding the palette be wrong. 3:1 is the
       WCAG bar for non-text UI and is the right floor for "you can see it at
       all". Anything between 3 and 4.5 is reported rather than hidden, because
       a reader choosing it for body text should know. */
    const soft: string[] = [];
    for (const [slot, hex] of Object.entries(P.ansi)) {
      const r = ratio(hex, P.background);
      /* ansiBlack is the one slot exempt, and not as a concession: in every
         ANSI palette black is the BACKGROUND-fill colour (`\e[40m`) and is at
         or below the terminal's own background by definition. A black that
         reached 3:1 against the background would not be black. What it does
         have to do is stay dark, which is asserted instead. */
      if (slot === "ansiBlack") {
        ok("ansiBlack stays at or below the background, as a fill colour should",
          lum(hex) <= lum(P.background), `${hex} vs ${P.background}`);
        continue;
      }
      ok(`${slot} is visible on the background`, r >= 3,
        `${r.toFixed(2)}:1 (${hex} on ${P.background})`);
      if (r < 4.5) soft.push(`${slot} ${r.toFixed(2)}`);
    }
    const fg = ratio(P.foreground, P.background);
    ok("body text reaches 4.5:1", fg >= 4.5, `${fg.toFixed(2)}:1`);
    console.log(`      note: below 4.5:1, fine for accents, not for body text - ${soft.join(", ")}`);
  }

  console.log("\n---- applying merges, and reverting restores ----");
  {
    const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "kx-theme-"));
    reset(TMP);
    __cfg.clear();
    __globalKeys.clear();

    /* Somebody else's customisation, and one of ours they had already set by
       hand. Both have to survive: `workbench.colorCustomizations` is one
       object shared by every extension, and replacing it rather than merging
       silently deletes whatever else was in there. */
    __cfg.set("colorCustomizations", {
      "editor.background": "#123456",
      "terminal.ansiRed": "#ff0000",
    });

    const ctx = makeContext(path.join(TMP, "store"), ROOT) as any;
    const n = await applyTerminalTheme(ctx);
    ok("applying writes every colour", n.colors === 20, String(n.colors));
    ok("and every font setting", n.fonts === Object.keys(FONT_SETTINGS).length, String(n.fonts));

    const after = __cfg.get("colorCustomizations") as Record<string, string>;
    ok("a customisation Genesis does not own is untouched",
      after["editor.background"] === "#123456", JSON.stringify(after["editor.background"]));
    ok("and the palette is in there",
      after["terminal.ansiGreen"] === token(CSS, "kx-accent"), after["terminal.ansiGreen"]);
    ok("overwriting one the user had set", after["terminal.ansiRed"] === token(CSS, "kx-error"),
      after["terminal.ansiRed"]);
    ok("the font family names JetBrains Mono",
      /JetBrains ?Mono/i.test(String(__cfg.get("terminal.integrated.fontFamily"))),
      String(__cfg.get("terminal.integrated.fontFamily")));
    // Nerd Font first so prompt glyphs render; plain second so it still works
    // when the Nerd build is not installed.
    ok("with the Nerd Font build first",
      /^"JetBrainsMono Nerd Font"/.test(String(__cfg.get("terminal.integrated.fontFamily"))),
      String(__cfg.get("terminal.integrated.fontFamily")));
    ok("and cursorStyle is left alone", __cfg.get("terminal.integrated.cursorStyle") === undefined,
      String(__cfg.get("terminal.integrated.cursorStyle")));

    const undone = await revertTerminalTheme(ctx);
    ok("reverting reports that it did something", undone === true);
    const back = __cfg.get("colorCustomizations") as Record<string, string>;
    ok("the other extension's customisation is still there",
      back["editor.background"] === "#123456", JSON.stringify(back));
    // The distinction that makes revert honest: a key that was set before is
    // put back, and a key that was NOT set is removed rather than left behind.
    ok("a colour the user had set is restored to their value",
      back["terminal.ansiRed"] === "#ff0000", JSON.stringify(back["terminal.ansiRed"]));
    ok("and colours they never set are gone, not left as debris",
      back["terminal.ansiGreen"] === undefined, JSON.stringify(back["terminal.ansiGreen"]));
    ok("and the font setting is cleared",
      __cfg.get("terminal.integrated.fontSize") === undefined,
      String(__cfg.get("terminal.integrated.fontSize")));

    ok("reverting twice says there is nothing to undo",
      (await revertTerminalTheme(ctx)) === false);

    fs.rmSync(TMP, { recursive: true, force: true });
  }

  console.log(`\n---- ${pass} passed, ${failures.length} failed ----`);
  if (failures.length) {
    for (const f of failures) console.log("  FAIL " + f);
    process.exit(1);
  }
})();
