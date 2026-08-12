import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WebSocket } from "undici";

/**
 * A browser the model can actually operate, over the Chrome DevTools Protocol.
 *
 * The reader in `fetchPage.ts` answers "what does this page say". It cannot
 * answer "what happens when I click that", and a great many pages - anything
 * behind a login, anything rendered by JavaScript, anything with a form - only
 * exist after something is clicked. This is the other half.
 *
 * Deliberately no Playwright. Playwright is the obvious choice and it would
 * add a 150-300 MB browser download to a 4 MB extension whose entire purpose
 * is working inside locked-down networks, where that download is exactly the
 * thing that will not happen. CDP is a WebSocket carrying JSON-RPC; undici is
 * already a dependency and already ships a WebSocket. The browser being driven
 * is the Chrome or Edge the user already has.
 *
 * Headless by default. What the model needs is pixels and a DOM, and a window
 * appearing over someone's editor every time the agent looks something up is
 * a worse experience than a screenshot in the transcript.
 */

export interface LaunchOptions {
  /** Show the window. Off by default; the panel renders screenshots instead. */
  headed?: boolean;
  /** Milliseconds to wait for the browser to announce its debugging port. */
  startupMs?: number;
  viewport?: { width: number; height: number };
}

export interface FoundBrowser {
  /** "Chrome", "Edge", "Brave", … for showing to a person. */
  name: string;
  path: string;
}

/**
 * Every Chromium-family browser installed, best first.
 *
 * Nothing is bundled and nothing is downloaded. A browser engine is 150-300 MB,
 * and this extension exists to work inside networks where that download is the
 * first thing to fail - so it drives what the machine already has. Practically
 * every Windows machine has Edge whether or not anyone chose it, every Mac can
 * install Chrome, and Linux has one of half a dozen packages.
 *
 * Firefox and Safari are absent on purpose: neither speaks the Chrome DevTools
 * Protocol, so listing them would offer a browser that cannot be driven.
 *
 * Ordered by what a person is most likely to have configured the way they
 * expect - their default Chrome first, the always-present Edge after it.
 */
export function listBrowsers(env: NodeJS.ProcessEnv = process.env): FoundBrowser[] {
  const candidates: FoundBrowser[] = [];
  const add = (name: string, p: string) => candidates.push({ name, path: p });

  if (process.platform === "win32") {
    const roots = [env["ProgramFiles"], env["ProgramFiles(x86)"], env["LOCALAPPDATA"]]
      .filter(Boolean) as string[];
    for (const r of roots) {
      add("Chrome", path.join(r, "Google", "Chrome", "Application", "chrome.exe"));
      add("Brave", path.join(r, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"));
      add("Vivaldi", path.join(r, "Vivaldi", "Application", "vivaldi.exe"));
      add("Opera", path.join(r, "Opera", "opera.exe"));
      add("Edge", path.join(r, "Microsoft", "Edge", "Application", "msedge.exe"));
      add("Chromium", path.join(r, "Chromium", "Application", "chrome.exe"));
    }
  } else if (process.platform === "darwin") {
    add("Chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
    add("Brave", "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser");
    add("Vivaldi", "/Applications/Vivaldi.app/Contents/MacOS/Vivaldi");
    add("Edge", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge");
    add("Chromium", "/Applications/Chromium.app/Contents/MacOS/Chromium");
  } else {
    add("Chrome", "/usr/bin/google-chrome");
    add("Chrome", "/usr/bin/google-chrome-stable");
    add("Brave", "/usr/bin/brave-browser");
    add("Chromium", "/usr/bin/chromium");
    add("Chromium", "/usr/bin/chromium-browser");
    add("Chromium", "/snap/bin/chromium");
    add("Edge", "/usr/bin/microsoft-edge");
  }

  const seen = new Set<string>();
  const found: FoundBrowser[] = [];

  // An explicit override leads, for a browser installed somewhere unusual or
  // a specific build somebody wants driven.
  const explicit = env.KRYPTONITE_BROWSER;
  if (explicit && exists(explicit)) {
    found.push({ name: "Configured", path: explicit });
    seen.add(explicit.toLowerCase());
  }
  for (const c of candidates) {
    if (seen.has(c.path.toLowerCase()) || !exists(c.path)) continue;
    seen.add(c.path.toLowerCase());
    found.push(c);
  }
  return found;
}

function exists(p: string): boolean {
  try { return fs.existsSync(p); } catch { return false; }
}

/** The one that will be driven, or undefined when the machine has none. */
export function findBrowser(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return listBrowsers(env)[0]?.path;
}

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
}

export class CdpBrowser {
  private proc?: ChildProcess;
  private ws?: WebSocket;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private userDataDir?: string;
  /** The page we drive. Every command is scoped to this session. */
  private sessionId?: string;
  private events = new Map<string, Array<(p: any) => void>>();

  readonly executable: string;

  constructor(executable: string) {
    this.executable = executable;
  }

  get running(): boolean {
    return Boolean(this.ws && this.sessionId);
  }

  /**
   * Start the browser and attach to one blank page.
   *
   * The port is taken from the browser's own announcement on stderr rather
   * than picked in advance: asking for a specific port races anything else on
   * the machine, and `--remote-debugging-port=0` means the browser chooses a
   * free one and tells us which.
   */
  async launch(opts: LaunchOptions = {}): Promise<void> {
    if (this.running) return;
    const budget = opts.startupMs ?? 30_000;
    this.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kx-cdp-"));

    const args = [
      "--remote-debugging-port=0",
      `--user-data-dir=${this.userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-extensions",
      "--disable-component-update",
      "--disable-sync",
      "--disable-default-apps",
      // Renderers sharing a temp profile trip over each other's sandboxes on
      // some Windows setups; the profile is throwaway either way.
      "--no-sandbox",
      "--disable-dev-shm-usage",
      `--window-size=${opts.viewport?.width ?? 1280},${opts.viewport?.height ?? 800}`,
      "about:blank",
    ];
    if (!opts.headed) args.unshift("--headless=new");

    this.proc = spawn(this.executable, args, { stdio: ["ignore", "pipe", "pipe"] });

    const wsUrl = await this.readDevToolsUrl(budget);
    await this.connect(wsUrl, budget);
    await this.attachToPage(opts.viewport);
  }

  /** Chrome prints `DevTools listening on ws://…` once, on stderr. */
  private readDevToolsUrl(budget: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = this.proc!;
      let buf = "";
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(
          `The browser did not report a debugging port within ${budget}ms. ` +
          (buf.trim() ? `It said: ${buf.trim().slice(0, 300)}` : "It printed nothing.")
        ));
      }, budget);
      const onData = (c: Buffer) => {
        buf += c.toString();
        const m = buf.match(/ws:\/\/[^\s]+/);
        if (m) { cleanup(); resolve(m[0]); }
      };
      const onExit = (code: number | null) => {
        cleanup();
        reject(new Error(`The browser exited (code ${code}) before it was ready. ${buf.trim().slice(0, 300)}`));
      };
      const onErr = (e: Error) => { cleanup(); reject(e); };
      function cleanup() {
        clearTimeout(timer);
        proc.stderr?.off("data", onData);
        proc.off("exit", onExit);
        proc.off("error", onErr);
      }
      proc.stderr?.on("data", onData);
      proc.once("exit", onExit);
      proc.once("error", onErr);
    });
  }

  private connect(url: string, budget: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => reject(new Error("Timed out connecting to the browser.")), budget);
      ws.addEventListener("open", () => { clearTimeout(timer); this.ws = ws; resolve(); }, { once: true });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("Could not connect to the browser's debugging socket."));
      }, { once: true });
      ws.addEventListener("message", (ev: any) => this.onMessage(String(ev.data)));
      ws.addEventListener("close", () => {
        for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error("The browser closed.")); }
        this.pending.clear();
        this.ws = undefined;
        this.sessionId = undefined;
      });
    });
  }

  private async attachToPage(viewport?: { width: number; height: number }): Promise<void> {
    const { targetId } = await this.send("Target.createTarget", { url: "about:blank" });
    // `flatten` puts the page session on this same socket, so there is one
    // connection to manage rather than one per target.
    const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true });
    this.sessionId = sessionId;
    await this.send("Page.enable", {});
    await this.send("Runtime.enable", {});
    await this.send("Emulation.setDeviceMetricsOverride", {
      width: viewport?.width ?? 1280,
      height: viewport?.height ?? 800,
      deviceScaleFactor: 1,
      mobile: false,
    });
  }

  private onMessage(raw: string): void {
    let msg: any;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      if (msg.error) {
        p.reject(new Error(`${p.method}: ${msg.error.message ?? "unknown CDP error"}`));
        return;
      }
      p.resolve(msg.result ?? {});
      return;
    }
    if (msg.method) {
      for (const fn of this.events.get(msg.method) ?? []) {
        try { fn(msg.params); } catch { /* a listener must not kill the socket */ }
      }
    }
  }

  on(method: string, fn: (params: any) => void): void {
    const list = this.events.get(method) ?? [];
    list.push(fn);
    this.events.set(method, list);
  }

  /**
   * One CDP call. Scoped to the attached page unless `browserLevel` is set,
   * because Target.* commands are answered by the browser itself.
   */
  send(method: string, params: unknown = {}, timeoutMs = 30_000): Promise<any> {
    const ws = this.ws;
    if (!ws) return Promise.reject(new Error("The browser is not running."));
    const id = this.nextId++;
    const browserLevel = method.startsWith("Target.") || method.startsWith("Browser.");
    const payload: any = { id, method, params };
    if (this.sessionId && !browserLevel) payload.sessionId = this.sessionId;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        ws.send(JSON.stringify(payload));
      } catch (e: any) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  /**
   * Shut down and leave nothing behind.
   *
   * The temp profile is removed too: a directory per launch, left in the
   * system temp folder, is how a tool quietly consumes a disk.
   */
  async close(): Promise<void> {
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error("The browser is closing.")); }
    this.pending.clear();
    this.sessionId = undefined;

    try { this.ws?.close(); } catch { /* already gone */ }
    this.ws = undefined;

    const proc = this.proc;
    this.proc = undefined;
    if (proc && proc.exitCode === null) {
      proc.kill();
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          try { proc.kill("SIGKILL"); } catch { /* already gone */ }
          resolve();
        }, 3000);
        proc.once("exit", () => { clearTimeout(t); resolve(); });
      });
    }
    const dir = this.userDataDir;
    this.userDataDir = undefined;
    if (dir) {
      // Retried: Windows holds profile files briefly after the process exits.
      for (let i = 0; i < 3; i++) {
        try { fs.rmSync(dir, { recursive: true, force: true }); break; }
        catch { await new Promise((r) => setTimeout(r, 200)); }
      }
    }
  }
}
