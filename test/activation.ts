/**
 * §1.1 — the extension activates without errors, in the states a user can
 * actually be in on startup.
 *
 * `vscode` is aliased to test/vscode-stub.ts, so `App` and `activate()` are the
 * real code. Anything the extension reports to the editor is recorded, and an
 * unhandled rejection anywhere fails the run rather than being swallowed.
 *
 * Run: npx esbuild test/activation.ts --bundle --outfile=dist/activation.cjs \
 *        --format=cjs --platform=node --target=node20 --alias:vscode=./test/vscode-stub.ts
 *      node dist/activation.cjs
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { activate, deactivate } from "../src/extension";
import { recorded, reset, makeContext } from "./vscode-stub";

let pass = 0;
let fail = 0;
function ck(ok: boolean, label: string, detail = "") {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
}

const unhandled: string[] = [];
process.on("unhandledRejection", (e: any) => unhandled.push(String(e?.message ?? e)));
process.on("uncaughtException", (e: any) => unhandled.push(String(e?.message ?? e)));

const TMP = path.join(os.tmpdir(), "kx-activation-" + Date.now());
const EXT = path.resolve(".");

/** Activate against a workspace root (or none) and report what happened. */
async function activateIn(root: string | undefined, label: string) {
  reset(root);
  const storage = path.join(TMP, "storage-" + Math.random().toString(36).slice(2));
  fs.mkdirSync(storage, { recursive: true });
  const ctx = makeContext(storage, EXT);
  let threw: string | undefined;
  try {
    await activate(ctx);
  } catch (e: any) {
    threw = e?.message ?? String(e);
  }
  await new Promise((r) => setTimeout(r, 300)); // let async reload settle
  ck(!threw, `1.1 ${label}: activate() does not throw`, threw);
  // A profile that will not parse is *supposed* to be logged as an error — that
  // is the feature. What must not appear is an error from the extension itself.
  const errs = recorded.output.filter(
    (l) => /\berror\b/i.test(l) && !/^\[error\] (Profile|Skill)/.test(l)
  );
  ck(errs.length === 0, `1.1 ${label}: no unexpected errors logged`, errs.slice(0, 2).join(" | "));
  return ctx;
}

async function main() {
  fs.mkdirSync(TMP, { recursive: true });

  console.log("──── §1.1 activation ────");

  // No folder open — the state a fresh VS Code window starts in.
  let ctx = await activateIn(undefined, "no folder");
  // Pinned by name rather than by count. A count catches a command going
  // missing but says nothing about which one, and every entry here has to
  // exist on both sides: registered in code, and declared in the manifest.
  // A command registered but not declared never reaches the palette; one
  // declared but not registered fails the moment it is invoked.
  const EXPECTED = [
    "kryptonite.focusSidebar",
    "kryptonite.openControlCenter",
    "kryptonite.openBrowser",
    "kryptonite.closeBrowser",
    "kryptonite.newChat",
    "kryptonite.runDiagnostics",
    "kryptonite.selectEndpoint",
    "kryptonite.newEndpoint",
    "kryptonite.restoreCheckpoint",
    "kryptonite.exportBundle",
  ];
  for (const name of EXPECTED) {
    ck(recorded.commands.includes(name), `1.1 ${name} is registered`);
  }
  ck(recorded.commands.length === EXPECTED.length, "1.1 and nothing else is",
    recorded.commands.join(", "));
  {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")
    );
    const declared: string[] = (manifest.contributes?.commands ?? []).map((c: any) => c.command);
    for (const name of EXPECTED) {
      ck(declared.includes(name), `1.1 ${name} is declared in the manifest`);
    }
    ck(declared.length === EXPECTED.length, "1.1 and the manifest declares no others",
      declared.join(", "));
  }
  ck(ctx.subscriptions.length > 0, "1.1 disposables registered", String(ctx.subscriptions.length));
  await deactivate();

  // A real folder with no .agent/ at all.
  const bare = path.join(TMP, "bare");
  fs.mkdirSync(bare, { recursive: true });
  await activateIn(bare, "empty workspace");
  await deactivate();

  // A workspace whose profile does not parse — must not take activation down.
  const broken = path.join(TMP, "broken");
  fs.mkdirSync(path.join(broken, ".agent", "endpoints"), { recursive: true });
  fs.writeFileSync(path.join(broken, ".agent", "endpoints", "bad.yaml"), "name: x\nwire: nope\n", "utf8");
  fs.writeFileSync(path.join(broken, ".agent", "endpoints", "worse.yaml"), ":::not yaml:::\n", "utf8");
  await activateIn(broken, "unparseable profiles");
  ck(
    recorded.output.some((l) => /Profile/.test(l)),
    "1.1 the bad profile is reported to the log rather than thrown",
    recorded.output.filter((l) => /Profile/.test(l))[0]
  );
  await deactivate();

  // A skills folder with a malformed skill.
  const skills = path.join(TMP, "skills-ws");
  fs.mkdirSync(path.join(skills, ".agent", "skills", "nofrontmatter"), { recursive: true });
  fs.writeFileSync(path.join(skills, ".agent", "skills", "nofrontmatter", "SKILL.md"), "no frontmatter here", "utf8");
  fs.mkdirSync(path.join(skills, ".agent", "skills", "empty-dir"), { recursive: true });
  await activateIn(skills, "malformed skill");
  await deactivate();

  console.log("\n──── unhandled rejections ────");
  ck(unhandled.length === 0, "1.1 no unhandled rejection during any activation", unhandled.slice(0, 3).join(" | "));

  console.log(`\n──── ${pass} passed, ${fail} failed ────`);
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* temp */
  }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error("THREW", e);
  process.exit(1);
});
