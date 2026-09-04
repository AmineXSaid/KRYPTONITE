import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { request, Dispatcher } from "undici";
import type { FoundBrowser } from "./cdp";

/**
 * Getting a browser when the machine running the extension has none.
 *
 * `cdp.ts` drives whatever Chromium the machine already has, and says plainly
 * why it bundles nothing: a browser engine is 150-300 MB and this extension
 * exists for networks where that download is the first thing to fail. That
 * reasoning is still right, and it is also why the feature did not exist at
 * all for the people most likely to want it - anyone whose extension host is
 * a container. A dev container has no Chrome, and the answer "install one"
 * lands on an image somebody else builds.
 *
 * So this is the rest of the ladder, cheapest rung first:
 *
 *   1. Installed here.            listBrowsers() in cdp.ts. Unchanged.
 *   2. Installed on the HOST.     Under WSL, the Windows browser is on a
 *                                 mounted drive and WSL can execute it. No
 *                                 download, no permission, already configured.
 *   3. Fetched once and kept.     Chrome for Testing into globalStorage, over
 *                                 the endpoint profile's own dispatcher - so
 *                                 it inherits the corporate CA, the CONNECT
 *                                 proxy and the client certificate that make
 *                                 every other request in this extension work.
 *                                 A plain https.get is exactly the download
 *                                 that fails behind a corporate proxy; this
 *                                 one goes the same way the model's traffic
 *                                 does.
 *
 * Rung 4 is not here: it is `fetchPage`, and it belongs to the caller. When
 * all of this comes back empty the tool reads the page instead of failing.
 */

const exists = (p: string) => { try { return fs.existsSync(p); } catch { return false; } };

/* ─────────────────────────── rung 2: the WSL host ─────────────────────────── */

/**
 * Are we a Linux process inside WSL?
 *
 * `/proc/version` carries "microsoft" on both WSL 1 and WSL 2 and is the check
 * Microsoft's own documentation uses. WSL_DISTRO_NAME is set for interactive
 * shells and is NOT reliable here: an extension host started by VS Code Server
 * does not necessarily inherit it, which is the case this has to work in.
 */
export function isWsl(
  env: NodeJS.ProcessEnv = process.env,
  // Injected so this is testable without a /proc to write to. The default is
  // the real thing; the parameter exists for the suite and for nothing else.
  procVersion: () => string = () => fs.readFileSync("/proc/version", "utf8"),
): boolean {
  if (process.platform !== "linux") return false;
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return true;
  try {
    return /microsoft|wsl/i.test(procVersion());
  } catch {
    return false;
  }
}

/**
 * Windows browsers reachable from inside WSL, through the drive mounts.
 *
 * WSL's binfmt interop runs a Windows executable from Linux directly - no
 * shim, no wrapper - so a `chrome.exe` found here can simply be spawned. The
 * browser then runs on Windows, which is where the person can see it, and
 * its debugging port is reachable because WSL 2 forwards localhost.
 *
 * `/mnt/c` is the default and the overwhelming majority; the mount root is
 * configurable, so the drives actually mounted are read rather than assumed.
 */
export function wslHostBrowsers(env: NodeJS.ProcessEnv = process.env): FoundBrowser[] {
  if (!isWsl(env)) return [];
  return windowsBrowsersUnder(["/mnt", "/windir"], env);
}

/**
 * Windows browsers under the given mount bases.
 *
 * Split out from the guard above so it can be pointed at a directory in a
 * test. Everything interesting is here: which subdirectories count as drives,
 * where the two kinds of install put a browser, and which accounts to skip.
 */
export function windowsBrowsersUnder(
  bases: string[],
  env: NodeJS.ProcessEnv = process.env,
): FoundBrowser[] {
  const roots: string[] = [];
  for (const base of bases) {
    let entries: string[];
    try { entries = fs.readdirSync(base); } catch { continue; }
    for (const e of entries) {
      // Drive letters only. /mnt also holds `wsl` and `wslg` on some builds.
      if (/^[a-z]$/i.test(e)) roots.push(path.join(base, e));
    }
  }
  const out: FoundBrowser[] = [];
  const seen = new Set<string>();
  const add = (name: string, p: string) => {
    const key = p.toLowerCase();
    if (seen.has(key) || !exists(p)) return;
    seen.add(key);
    out.push({ name: name + " (Windows)", path: p });
  };
  const user = env.WSL_HOST_USER || "";
  for (const r of roots) {
    for (const pf of ["Program Files", "Program Files (x86)"]) {
      add("Chrome", path.join(r, pf, "Google", "Chrome", "Application", "chrome.exe"));
      add("Edge", path.join(r, pf, "Microsoft", "Edge", "Application", "msedge.exe"));
      add("Brave", path.join(r, pf, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"));
    }
    // Per-user installs, which is where Chrome lands without an admin.
    const users = path.join(r, "Users");
    let names: string[] = [];
    if (user) names = [user];
    else { try { names = fs.readdirSync(users); } catch { names = []; } }
    for (const n of names) {
      if (n === "Public" || n === "Default" || n === "All Users") continue;
      const la = path.join(users, n, "AppData", "Local");
      add("Chrome", path.join(la, "Google", "Chrome", "Application", "chrome.exe"));
      add("Edge", path.join(la, "Microsoft", "Edge", "Application", "msedge.exe"));
    }
  }
  return out;
}

/* ─────────────────── rung 3: fetch one, once, and keep it ─────────────────── */

/** Chrome for Testing's platform names, which are not Node's. */
function cftPlatform(): string | undefined {
  if (process.platform === "linux" && process.arch === "x64") return "linux64";
  if (process.platform === "darwin") return process.arch === "arm64" ? "mac-arm64" : "mac-x64";
  if (process.platform === "win32") return process.arch === "x64" ? "win64" : "win32";
  // linux-arm64 has no Chrome for Testing build. Saying so beats downloading
  // 150 MB of x64 and failing to exec it.
  return undefined;
}

/** Where the binary ends up inside the extracted tree, per platform. */
function cftBinary(dir: string, platform: string): string {
  if (platform.startsWith("mac")) {
    return path.join(dir, `chrome-${platform}`,
      "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing");
  }
  if (platform.startsWith("win")) return path.join(dir, `chrome-${platform}`, "chrome.exe");
  return path.join(dir, `chrome-${platform}`, "chrome");
}

/** A browser fetched on an earlier run, if it is still there and runnable. */
export function cachedBrowser(cacheDir: string): FoundBrowser | undefined {
  const platform = cftPlatform();
  if (!platform) return undefined;
  let versions: string[];
  try { versions = fs.readdirSync(cacheDir); } catch { return undefined; }
  /* Newest first, so an upgrade supersedes rather than races - and compared
     NUMERICALLY. A lexical sort puts "99.0.1.1" above "131.0.6778.85", which
     is only harmless while Chrome's major stays three digits. It has been two
     digits before and the cache outlives the assumption. */
  versions.sort((a, b) => {
    const pa = a.split("."), pb = b.split(".");
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (Number(pb[i]) || 0) - (Number(pa[i]) || 0);
      if (d) return d;
    }
    return 0;
  });
  for (const v of versions) {
    const bin = cftBinary(path.join(cacheDir, v), platform);
    if (exists(bin)) return { name: "Chrome for Testing", path: bin };
  }
  return undefined;
}

/**
 * Unpack a .zip with whatever the machine has.
 *
 * Node ships no zip reader and this extension has two runtime dependencies, so
 * a third for one archive a year is the wrong trade. Every platform this runs
 * on has at least one of these already: bsdtar is in Windows 10+ and macOS,
 * `unzip` is on practically every Linux image, and python3 is on the rest.
 */
function unzip(zip: string, into: string): void {
  fs.mkdirSync(into, { recursive: true });
  const tries: Array<[string, string[]]> = process.platform === "win32"
    ? [["tar", ["-xf", zip, "-C", into]],
       ["powershell", ["-NoProfile", "-Command",
         `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${into}' -Force`]]]
    : [["unzip", ["-q", "-o", zip, "-d", into]],
       ["tar", ["-xf", zip, "-C", into]],
       ["python3", ["-m", "zipfile", "-e", zip, into]]];
  const failures: string[] = [];
  for (const [cmd, args] of tries) {
    const r = spawnSync(cmd, args, { stdio: "ignore" });
    if (r.status === 0) return;
    failures.push(`${cmd}: ${r.error ? r.error.message : "exit " + r.status}`);
  }
  throw new Error(
    "Could not unpack the browser archive. Tried " + failures.join("; ") +
    ". Install `unzip`, or set GENESIS_BROWSER to a browser you already have."
  );
}

export interface FetchOptions {
  /** Under globalStorage. One directory per version. */
  cacheDir: string;
  /** The active profile's dispatcher, so the download takes the same road. */
  dispatcher?: Dispatcher;
  signal?: AbortSignal;
  /** Called with a human sentence at each step, and with byte progress. */
  onProgress?: (message: string) => void;
}

/**
 * Fetch Chrome for Testing and return the binary.
 *
 * Chrome for Testing is Google's build published FOR automation: pinned
 * versions, no auto-update, no sign-in, and a stable URL scheme. Driving it
 * cannot disturb the browser somebody actually uses, which the installed-Chrome
 * path can - a headed launch against a live profile steals the session.
 */
export async function fetchBrowser(opts: FetchOptions): Promise<FoundBrowser> {
  const platform = cftPlatform();
  if (!platform) {
    throw new Error(
      `No Chrome for Testing build exists for ${process.platform}/${process.arch}. ` +
      "Install a Chromium-family browser, or set GENESIS_BROWSER to one."
    );
  }
  const say = opts.onProgress || (() => {});

  say("Asking Google which Chrome for Testing build is current…");
  const idx = await request(
    "https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json",
    { dispatcher: opts.dispatcher, signal: opts.signal, maxRedirections: 3 }
  );
  if (idx.statusCode !== 200) {
    throw new Error(`Could not read the Chrome for Testing index: HTTP ${idx.statusCode}.`);
  }
  const body: any = await idx.body.json();
  const stable = body?.channels?.Stable;
  const version: string = stable?.version;
  const dl = (stable?.downloads?.chrome || []).find((d: any) => d.platform === platform);
  if (!version || !dl?.url) {
    throw new Error(`The Chrome for Testing index lists no ${platform} build.`);
  }

  const dir = path.join(opts.cacheDir, version);
  const already = cftBinary(dir, platform);
  if (exists(already)) return { name: "Chrome for Testing", path: already };

  say(`Downloading Chrome for Testing ${version} (about 150 MB, once)…`);
  const res = await request(dl.url, {
    dispatcher: opts.dispatcher, signal: opts.signal, maxRedirections: 5,
  });
  if (res.statusCode !== 200) {
    throw new Error(`Downloading the browser failed: HTTP ${res.statusCode} from ${dl.url}`);
  }
  fs.mkdirSync(dir, { recursive: true });
  const zip = path.join(dir, "chrome.zip");
  // Streamed to disk rather than buffered: 150 MB in the extension host's heap
  // is a memory spike nobody asked for.
  const total = Number(res.headers["content-length"] || 0);
  let seen = 0, lastSaid = 0;
  const out = fs.createWriteStream(zip);
  await new Promise<void>((resolve, reject) => {
    res.body.on("data", (c: Buffer) => {
      seen += c.length;
      // Every 10%, so the log is a progress report rather than a flood.
      if (total && seen - lastSaid > total / 10) {
        lastSaid = seen;
        say(`  ${Math.round((seen / total) * 100)}%`);
      }
    });
    res.body.on("error", reject);
    out.on("error", reject);
    out.on("finish", () => resolve());
    res.body.pipe(out);
  });

  say("Unpacking…");
  unzip(zip, dir);
  try { fs.unlinkSync(zip); } catch { /* the browser is what matters */ }

  const bin = cftBinary(dir, platform);
  if (!exists(bin)) {
    throw new Error(`The archive unpacked but ${bin} is not there.`);
  }
  if (process.platform !== "win32") {
    // The zip carries no executable bit through every extractor.
    try { fs.chmodSync(bin, 0o755); } catch { /* may already be right */ }
  }
  say(`Chrome for Testing ${version} is ready.`);
  return { name: "Chrome for Testing", path: bin };
}

/**
 * The shared libraries a Linux Chromium needs, and which of them are missing.
 *
 * THIS IS THE DEV-CONTAINER FAILURE, and without it the error is `spawn
 * ENOENT`-adjacent nonsense from a binary that plainly exists. A slim image -
 * which is most of them - has none of these, and Chrome exits immediately with
 * a message on stderr nobody sees. Naming the packages turns a dead end into
 * one line in a Dockerfile.
 */
export function missingLinuxLibs(bin: string): string[] {
  if (process.platform !== "linux") return [];
  let out = "";
  try {
    out = execFileSync("ldd", [bin], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return [];   // no ldd, or not a dynamic binary: not a diagnosis worth guessing at
  }
  return out
    .split("\n")
    .filter((l) => /not found/.test(l))
    .map((l) => l.trim().split(/\s+/)[0])
    .filter(Boolean);
}
