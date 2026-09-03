/**
 * Getting a browser when the machine running the extension has none.
 *
 * The reported symptom was "so even inside WSL then inside a dev container
 * I'll be having a browser tab?" - and the honest answer at the time was that
 * the panel would exist and the agent's browser would not. `listBrowsers()`
 * stats the filesystem of whatever machine the EXTENSION HOST runs on, which
 * in a dev container is the container: no Chrome, no Edge, and an error
 * telling the user to install one into an image somebody else builds.
 *
 * These cover the two rungs added below it. The download itself is not
 * exercised - it is 150 MB from Google - but everything around it is: which
 * platform names it asks for, where the binary lands, and what it says when
 * the archive unpacks into a container with no shared libraries.
 *
 * Run: npx esbuild test/browser-provision.ts --bundle --outfile=dist/browser-provision.cjs \
 *        --format=cjs --platform=node --target=node20
 *      node dist/browser-provision.cjs
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { windowsBrowsersUnder, cachedBrowser, missingLinuxLibs, isWsl } from "../src/browser/provision";

let pass = 0;
let fail = 0;
function ck(ok: boolean, label: string, detail = "") {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "kx-prov-"));
const touch = (p: string) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, "x"); };

console.log("──── the WSL host's browsers ────");
{
  /* The mount root is read rather than assumed: /mnt/c is the default and the
     overwhelming majority, but it is configurable in wsl.conf, and /mnt also
     holds `wsl` and `wslg` directories that are not drives. */
  const mnt = path.join(TMP, "mnt");
  fs.mkdirSync(path.join(mnt, "wsl"), { recursive: true });   // not a drive
  fs.mkdirSync(path.join(mnt, "wslg"), { recursive: true });  // nor this
  touch(path.join(mnt, "c", "Program Files", "Google", "Chrome", "Application", "chrome.exe"));
  touch(path.join(mnt, "c", "Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe"));
  touch(path.join(mnt, "c", "Users", "amine", "AppData", "Local",
    "Google", "Chrome", "Application", "chrome.exe"));
  touch(path.join(mnt, "c", "Users", "Public", "Google", "Chrome", "Application", "chrome.exe"));

  const found = windowsBrowsersUnder([mnt], {} as NodeJS.ProcessEnv);
  ck(found.length >= 3, "the Windows browsers on a mounted drive are found",
    found.map((f) => f.name).join(", "));
  ck(found.every((f) => / \(Windows\)$/.test(f.name)),
    "and are named so the log says which machine they are on",
    found.map((f) => f.name).join(", "));
  ck(found.some((f) => /Program Files\//.test(f.path)), "a machine-wide install");
  ck(found.some((f) => /amine/.test(f.path)),
    "and a per-user one, which is where Chrome lands without an admin");
  ck(!found.some((f) => /Public|Default/.test(f.path)),
    "the pseudo-accounts are skipped", found.map((f) => f.path).join(", "));
  ck(!found.some((f) => /\/wslg?\//.test(f.path)),
    "and /mnt/wsl is not mistaken for a drive letter");
  ck(new Set(found.map((f) => f.path)).size === found.length,
    "with nothing listed twice");

  // A machine with no mounts at all - which is the dev container - answers
  // with nothing rather than throwing on a directory that is not there.
  ck(windowsBrowsersUnder([path.join(TMP, "nope")], {} as NodeJS.ProcessEnv).length === 0,
    "and a missing mount base is not an error");
}

console.log("\n──── isWsl is not fooled by a plain Linux box ────");
{
  // The dev container case: Linux, no interop, no Windows anywhere.
  const container = isWsl({} as NodeJS.ProcessEnv, () => "Linux version 6.1.0-generic (gcc 12)");
  ck(container === false || process.platform !== "linux",
    "a container is not WSL, so nothing is looked for on a host that is not there");
  const wsl = isWsl({} as NodeJS.ProcessEnv,
    () => "Linux version 5.15.153.1-microsoft-standard-WSL2");
  ck(wsl === true || process.platform !== "linux",
    "but the real thing is recognised from /proc/version");
  // WSL_DISTRO_NAME is set for interactive shells and an extension host
  // started by VS Code Server does not necessarily inherit it - which is
  // exactly the case this has to work in, so it cannot be the only signal.
  const byEnv = isWsl({ WSL_INTEROP: "/run/WSL/1_interop" } as NodeJS.ProcessEnv,
    () => { throw new Error("no /proc/version"); });
  ck(byEnv === true || process.platform !== "linux",
    "and the interop socket is enough on its own");
}

console.log("\n──── a browser fetched on an earlier run ────");
{
  const cache = path.join(TMP, "browsers");
  ck(cachedBrowser(cache) === undefined, "an empty cache offers nothing");

  // Laid out the way fetchBrowser writes it: one directory per version.
  const plat = process.platform === "linux" ? "linux64"
    : process.platform === "darwin" ? (process.arch === "arm64" ? "mac-arm64" : "mac-x64")
    : "win64";
  const bin = process.platform === "win32" ? "chrome.exe"
    : process.platform === "darwin"
      ? path.join("Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing")
      : "chrome";
  touch(path.join(cache, "131.0.6778.85", `chrome-${plat}`, bin));
  touch(path.join(cache, "120.0.6099.109", `chrome-${plat}`, bin));

  // Two digits, so a lexical sort would put this on top and be wrong.
  touch(path.join(cache, "99.0.4844.51", `chrome-${plat}`, bin));

  const got = cachedBrowser(cache);
  ck(!!got, "a fetched browser is found again without fetching it twice");
  ck(!!got && /131\./.test(got.path),
    "and the newest wins, so an upgrade supersedes rather than races", got && got.path);
  ck(!!got && got.name === "Chrome for Testing",
    "named for what it is - not the browser the person uses", got && got.name);
}

console.log("\n──── the dev-container failure is named, not guessed at ────");
{
  // A binary that exists and cannot start is the whole trap: a slim image has
  // none of Chromium's shared libraries and it exits before printing anything
  // anyone sees. This is only meaningful on Linux with ldd; elsewhere it must
  // say nothing rather than invent a diagnosis.
  const missing = missingLinuxLibs(process.execPath);
  ck(Array.isArray(missing), "it always answers with a list");
  ck(missing.length === 0,
    "and node's own binary is not reported as broken", missing.join(", "));
  ck(missingLinuxLibs(path.join(TMP, "not-a-binary")).length === 0,
    "a path that is not a binary is not a diagnosis");
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n──── ${pass} passed, ${fail} failed ────`);
process.exitCode = fail ? 1 : 0;
