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
import { sidebarHtml, controlCenterHtml, browserHtml } from "../src/ui/shell";
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
    "genesis.focusSidebar",
    "genesis.openControlCenter",
    "genesis.openBrowser",
    "genesis.closeBrowser",
    "genesis.newChat",
    "genesis.runDiagnostics",
    "genesis.selectEndpoint",
    "genesis.newEndpoint",
    "genesis.restoreCheckpoint",
    "genesis.selectAgent",
    "genesis.newAgent",
    "genesis.exportChat",
    "genesis.exportAllChats",
    "genesis.exportBundle",
    // The editor-side features. These are also invoked as CodeLens and code
    // action targets, where a missing registration surfaces as a link that
    // does nothing rather than as an error.
    "genesis.fixProblem",
    "genesis.documentSymbol",
    "genesis.explainSelection",
    "genesis.writeTests",
    "genesis.generateCommitMessage",
    // Distinct from openBrowser: lands on the agent's view and starts
    // watching, which is what the model launching a browser calls for.
    "genesis.watchAgentBrowser",
    /* The host's own file dialog. The composer's attach button no longer
       calls it: `showOpenDialog` runs on the EXTENSION HOST, so in a WSL, dev
       container or SSH window it browses the remote disk while the user is
       sitting at a different machine. The button opens a file input in the
       webview instead, which is always local.
    
       This keeps the dialog reachable, because it is still the only route to a
       file on the remote machine that is outside the workspace - `@` covers
       the workspace and nothing beyond it. */
    "genesis.attachFromHost",
    /* The panel's palette applied to the terminal beside it, and its undo.
       Both are declared here rather than the count being loosened: this list
       exists so a command cannot go missing unnoticed, and that only works
       while it is exact. */
    "genesis.applyTerminalTheme",
    "genesis.revertTerminalTheme",
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

    // THE SECONDARY SIDE BAR, declared rather than achieved by force.
    //
    // The ask is "open on the right like Claude Code, and do not move the
    // activity bar to do it". Those are two different things and the extension
    // has now done both, in that order and wrongly the first time:
    //
    //   - It used to contribute to the activity bar and then run
    //     `workbench.action.moveSideBarRight` on first activation, which moves
    //     the WHOLE primary side bar and every extension in it. That is the
    //     hack `undoSideBarMove` above exists to reverse, and it stays.
    //   - `contributes.viewsContainers.secondarySidebar` is the declared way,
    //     and it moves nothing but this container. VS Code's own
    //     viewsExtensionPoint.ts accepts exactly three keys - activitybar,
    //     panel, secondarySidebar - and maps the third to
    //     ViewContainerLocation.AuxiliaryBar.
    //
    // It landed in 1.104, which is why `engines.vscode` is ^1.104.0 and why
    // that floor cannot drop without this going back to the activity bar.
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
    const containers = manifest.contributes.viewsContainers;
    ck(
      Array.isArray(containers.secondarySidebar) && !containers.activitybar,
      "1.1 the container opens in the secondary side bar",
      Object.keys(containers).join(", ")
    );
    ck(
      containers.secondarySidebar[0].id === "genesis" &&
        Array.isArray(manifest.contributes.views.genesis),
      "1.1 and the view is declared inside it"
    );
    // secondarySidebar is not in every VS Code that could otherwise run this.
    ck(
      /\^1\.(1[0-9][4-9]|1[2-9][0-9])\./.test(manifest.engines.vscode),
      "1.1 with an engine floor that actually has it",
      manifest.engines.vscode
    );
    // The bar shows the container's icon at 24px, masked to a flat silhouette.
    // It has to be the small roundel cut, not the full mark.
    ck(
      containers.secondarySidebar[0].icon === "media/icon.svg",
      "1.1 with an icon the bar can render",
      containers.secondarySidebar[0].icon
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

  /* ── the webview's content policy ──────────────────────────────────── */
  //
  // Asserted on the string the real builders produce, not in a browser. The
  // policy is assembled from `webview.cspSource`, which only the editor can
  // supply, so a harness that renders an approximation of it tests the
  // approximation. What is worth pinning is structural, and a string is where
  // that lives: this is the boundary that decides whether a page the browser
  // surface frames can reach back into the extension's own document.
  console.log("\n──── the webview content policy ────");
  {
    const origin = "vscode-resource://genesis";
    const webview: any = {
      cspSource: origin,
      asWebviewUri: (u: any) => ({ toString: () => `${origin}/${u.fsPath}` }),
    };
    const extensionUri: any = { fsPath: EXT, path: EXT, scheme: "file", toString: () => EXT };
    const policyOf = (html: string) =>
      /content="([^"]*)"/.exec(
        /<meta http-equiv="Content-Security-Policy"[^>]*>/.exec(html)?.[0] ?? ""
      )?.[1] ?? "";

    for (const [name, build] of [
      ["sidebar", sidebarHtml],
      ["control centre", controlCenterHtml],
      ["browser", browserHtml],
    ] as const) {
      const html = build(webview, extensionUri);
      const policy = policyOf(html);
      ck(policy.length > 0, `1.1 the ${name} document carries a CSP`);
      ck(/(^|;\s*)default-src 'none'/.test(policy), `1.1 ${name}: default-src is none`, policy);
      ck(!/unsafe-eval/.test(policy), `1.1 ${name}: no unsafe-eval`);
      // Scripts run by nonce and by nothing else. `'self'` or an origin here
      // would let any file the extension ships execute, which is the whole
      // reason the nonce exists.
      const script = /script-src ([^;]*)/.exec(policy)?.[1]?.trim() ?? "";
      ck(/^'nonce-[A-Za-z0-9]{32}'$/.test(script), `1.1 ${name}: script-src is one nonce`, script);
      // And the nonce has to be the one the tags carry, or the document is
      // strictly worse than having no policy: it looks protected and loads
      // nothing.
      const nonce = /'nonce-([A-Za-z0-9]+)'/.exec(script)?.[1] ?? "";
      const tags = [...html.matchAll(/<script nonce="([^"]+)"/g)].map((m) => m[1]);
      ck(tags.length > 0, `1.1 ${name}: the document has nonced scripts`, String(tags.length));
      ck(
        tags.every((t) => t === nonce),
        `1.1 ${name}: every script tag carries the policy's nonce`,
        [...new Set(tags)].join(", ")
      );
      // Fresh per document. A fixed nonce is a nonce in name only.
      const again = /'nonce-([A-Za-z0-9]+)'/.exec(policyOf(build(webview, extensionUri)))?.[1];
      ck(again !== nonce, `1.1 ${name}: a second build gets a different nonce`);
      // Nothing may be fetched from the network. `connect-src` is absent, so
      // `default-src 'none'` covers it - which is what stops a compromised
      // panel posting anything it holds anywhere.
      ck(!/connect-src/.test(policy), `1.1 ${name}: no connect-src is granted`);
    }

    // The browser surface is the documented exception and has to differ in
    // exactly one direction. If frame-src ever leaks into the other two, a
    // page could be framed inside the panel that talks to the extension.
    const sidebarPolicy = policyOf(sidebarHtml(webview, extensionUri));
    const browserPolicy = policyOf(browserHtml(webview, extensionUri));
    ck(!/frame-src/.test(sidebarPolicy), "1.1 the sidebar frames nothing");
    ck(/frame-src https: http:/.test(browserPolicy), "1.1 while the browser surface may frame a page");
    ck(
      !/script-src[^;]*https?:/.test(browserPolicy),
      "1.1 and framing a page still grants it no script origin",
      browserPolicy
    );
  }

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
