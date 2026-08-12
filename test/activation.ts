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
import * as extension from "../src/extension";
import { recorded, reset, makeContext, __cfg } from "./vscode-stub";

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

  /* ── house typography ──────────────────────────────────────────────
     No em-dashes anywhere that ships. This keeps coming back because it is
     the natural thing to type in prose, and it has to be caught here rather
     than by re-reading every file by eye. */
  {
    const root = path.join(__dirname, "..");
    const roots = [path.join(root, "src"), path.join(root, "media", "webview")];
    const files: string[] = [path.join(root, "package.json")];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|js|css|json)$/.test(e.name)) files.push(p);
      }
    };
    for (const r of roots) if (fs.existsSync(r)) walk(r);

    const offenders: string[] = [];
    for (const f of files) {
      const text = fs.readFileSync(f, "utf8");
      const i = text.indexOf("—");
      if (i === -1) continue;
      const line = text.slice(0, i).split("\n").length;
      offenders.push(`${path.relative(root, f)}:${line}`);
    }
    ck(offenders.length === 0, `1.1 no em-dash in ${files.length} shipped files`,
      offenders.slice(0, 5).join(", "));
  }

  /* ── where the panel lives ─────────────────────────────────────────
     The right-hand position is now a manifest fact, not something activation
     does, so what is worth asserting is that nothing moves the user's layout
     any more - and that the one machine-state repair left over from the
     versions that did runs exactly once. */
  {
    const { undoSideBarMove, SIDEBAR_STATE_KEY } = extension;
    const fakeCtx: any = {
      globalState: {
        get: (k: string, d?: unknown) => (recorded.global.has(k) ? recorded.global.get(k) : d),
        update: async (k: string, v: unknown) => {
          v === undefined ? recorded.global.delete(k) : recorded.global.set(k, v);
        },
      },
    };

    // Fresh install: no key, so activation must leave the layout alone.
    recorded.global.clear();
    recorded.executed.length = 0;
    await undoSideBarMove(fakeCtx);
    ck(recorded.executed.length === 0,
      "1.1 a fresh install never touches the Primary Side Bar",
      recorded.executed.map((e) => e.id).join(", "));

    // Upgraded from a version that moved the bar right: put it back, once.
    recorded.global.set(SIDEBAR_STATE_KEY, "right");
    recorded.executed.length = 0;
    await undoSideBarMove(fakeCtx);
    ck(recorded.executed.some((e) => e.id === "workbench.action.moveSideBarLeft"),
      "1.1 an upgrade puts the Primary Side Bar back on the left",
      recorded.executed.map((e) => e.id).join(", "));

    recorded.executed.length = 0;
    await undoSideBarMove(fakeCtx);
    ck(recorded.executed.length === 0,
      "1.1 and does it once, so a deliberate move afterwards sticks",
      recorded.executed.map((e) => e.id).join(", "));

    // The container has to be declared where the code says it is: a view
    // contributed to the activity bar would open on the left again, and
    // nothing in the extension host would complain.
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
    const containers = manifest.contributes.viewsContainers;
    ck(
      Array.isArray(containers.secondarySidebar) && !containers.activitybar,
      "1.1 the container is contributed to the Secondary Side Bar only",
      Object.keys(containers).join(", ")
    );
    ck(
      containers.secondarySidebar[0].id === "kryptonite" &&
        Array.isArray(manifest.contributes.views.kryptonite),
      "1.1 and the view is declared inside it"
    );
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
