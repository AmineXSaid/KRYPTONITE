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
  /**
   * Where the browser keeps its profile.
   *
   * Given a path, the profile lives there and survives the process. Omitted, a
   * throwaway is minted in the temp directory and deleted on close, which was
   * the only behaviour for a long time.
   *
   * Persisting is about the session, not about how the browser looks to a
   * server. A browser the agent drives exists so a login can be performed once
   * and used afterwards; a profile that is destroyed on every close means the
   * login is destroyed with it, and the next launch starts at a sign-in page.
   * It does not defeat bot detection and is not meant to.
   */
  profileDir?: string;
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

/**
 * A console argument, as text.
 *
 * `console.log({a: 1})` arrives as a RemoteObject with no value - the object
 * lives in the page and would need a second round trip to read. `preview` is
 * what DevTools shows in that case, so it is what is used here; without it
 * every logged object reads as "Object" and the line is worthless.
 */
function describeRemote(a: any): string {
  if (!a) return "";
  if (a.type === "string") return String(a.value ?? "");
  if ("value" in a && a.value !== undefined) return String(a.value);
  if (a.unserializableValue) return String(a.unserializableValue);
  const p = a.preview;
  if (p?.properties) {
    const body = p.properties
      .slice(0, 8)
      .map((q: any) => `${q.name}: ${q.value}`)
      .join(", ");
    return p.subtype === "array" ? `[${body}]` : `{${body}}`;
  }
  return a.description ?? a.className ?? a.type ?? "";
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

/** One line the page wrote to its console, or threw. */
export interface ConsoleEntry {
  level: "log" | "info" | "warning" | "error" | "debug";
  text: string;
  /** Where it came from, when the page said. */
  source?: string;
}

/** One request the page made. */
export interface NetEntry {
  method: string;
  url: string;
  status?: number;
  /** "document", "script", "xhr", "fetch", "image", … */
  kind?: string;
  /** Present instead of a status when the request never completed. */
  failed?: string;
  ms?: number;
}

/**
 * How much of each is kept.
 *
 * A single page load can log thousands of lines and make hundreds of requests,
 * and the point of these buffers is to answer "what went wrong just now". Old
 * entries are dropped rather than the buffer growing without limit, because
 * this lives in the extension host for as long as the browser is open.
 */
const CONSOLE_CAP = 200;
const NET_CAP = 300;

export class CdpBrowser {
  private proc?: ChildProcess;
  private ws?: WebSocket;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  /** Set only for a throwaway profile: it is what close() deletes. */
  private userDataDir?: string;
  /** Where the profile actually is, throwaway or not. */
  private profileDir?: string;
  /** The page we drive. Every command is scoped to this session. */
  private sessionId?: string;
  private events = new Map<string, Array<(p: any) => void>>();
  private consoleBuf: ConsoleEntry[] = [];
  /** Keyed by requestId so a response can find the request that started it. */
  private netBuf = new Map<string, NetEntry>();
  private netStart = new Map<string, number>();
  private castOn = false;

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
    if (opts.profileDir) {
      fs.mkdirSync(opts.profileDir, { recursive: true });
      this.profileDir = opts.profileDir;
      // Left alone on close: `userDataDir` is the one that gets deleted, and a
      // persistent profile that is deleted is not persistent.
      this.userDataDir = undefined;
    } else {
      this.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kx-cdp-"));
      this.profileDir = this.userDataDir;
    }

    const args = [
      "--remote-debugging-port=0",
      `--user-data-dir=${this.profileDir}`,
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
    // Log and Network are what turn this from a thing that clicks into a thing
    // that can say why a page is broken. Both are pure listeners: enabling
    // them costs nothing until something happens.
    await this.send("Log.enable", {}).catch(() => {});
    await this.send("Network.enable", {}).catch(() => {});
    this.watchDiagnostics();
    await this.send("Emulation.setDeviceMetricsOverride", {
      width: viewport?.width ?? 1280,
      height: viewport?.height ?? 800,
      deviceScaleFactor: 1,
      mobile: false,
    });
  }

  /**
   * Buffer what the page says and what it asks for.
   *
   * Console output arrives on two different domains and neither is a superset
   * of the other: `Runtime.consoleAPICalled` is what the page's own code
   * logged, while `Log.entryAdded` is what the browser itself reported - a
   * blocked mixed-content request, a CSP violation, a 404 on an image. An
   * agent debugging a page needs both, and they are merged here rather than
   * asked for separately.
   */
  private watchDiagnostics(): void {
    const pushLog = (e: ConsoleEntry) => {
      this.consoleBuf.push(e);
      if (this.consoleBuf.length > CONSOLE_CAP) this.consoleBuf.shift();
    };

    this.on("Runtime.consoleAPICalled", (p) => {
      const level: ConsoleEntry["level"] =
        p?.type === "error" ? "error"
          : p?.type === "warning" ? "warning"
            : p?.type === "debug" ? "debug"
              : p?.type === "info" ? "info" : "log";
      pushLog({ level, text: (p?.args ?? []).map(describeRemote).join(" ").slice(0, 2000) });
    });

    // An uncaught exception never reaches consoleAPICalled, and it is the one
    // line most worth having.
    this.on("Runtime.exceptionThrown", (p) => {
      const d = p?.exceptionDetails;
      const text = d?.exception?.description ?? d?.text ?? "Uncaught exception";
      pushLog({
        level: "error",
        text: String(text).split("\n").slice(0, 3).join("\n").slice(0, 2000),
        source: d?.url,
      });
    });

    this.on("Log.entryAdded", (p) => {
      const e = p?.entry;
      if (!e) return;
      const level: ConsoleEntry["level"] =
        e.level === "error" ? "error" : e.level === "warning" ? "warning" : "info";
      pushLog({ level, text: String(e.text ?? "").slice(0, 2000), source: e.url });
    });

    this.on("Network.requestWillBeSent", (p) => {
      if (!p?.requestId) return;
      this.netBuf.set(p.requestId, {
        method: p.request?.method ?? "GET",
        url: String(p.request?.url ?? "").slice(0, 500),
        kind: p.type,
      });
      this.netStart.set(p.requestId, Date.now());
      this.trimNet();
    });
    this.on("Network.responseReceived", (p) => {
      const e = this.netBuf.get(p?.requestId);
      if (!e) return;
      e.status = p?.response?.status;
      e.kind = p?.type ?? e.kind;
      const t0 = this.netStart.get(p.requestId);
      if (t0) e.ms = Date.now() - t0;
    });
    this.on("Network.loadingFailed", (p) => {
      const e = this.netBuf.get(p?.requestId);
      if (!e) return;
      e.failed = String(p?.errorText ?? "failed");
      const t0 = this.netStart.get(p.requestId);
      if (t0) e.ms = Date.now() - t0;
    });
  }

  private trimNet(): void {
    while (this.netBuf.size > NET_CAP) {
      const first = this.netBuf.keys().next().value;
      if (first === undefined) break;
      this.netBuf.delete(first);
      this.netStart.delete(first);
    }
  }

  /**
   * Stream what the page looks like, frame by frame.
   *
   * The browser is headless, which is the right default - a window appearing
   * over the editor every time the agent looks something up is worse than not
   * seeing it. But "worse than not seeing it" is not "never seeing it", and
   * until now there was no way to watch what the agent was doing at all.
   *
   * This is a screencast rather than an iframe on purpose. A frame of a real
   * site is refused by X-Frame-Options on anything with a login, and even when
   * it loads it is a *different* page from the one the agent is driving -
   * different cookies, different session, different scroll position. These are
   * the actual pixels of the actual page.
   *
   * Each frame must be acknowledged or the browser stops sending them, which
   * is what makes this back-pressured rather than a firehose.
   */
  startScreencast(onFrame: (jpegBase64: string) => void, maxWidth = 1280): void {
    if (this.castOn) return;
    this.castOn = true;
    this.on("Page.screencastFrame", (p) => {
      if (!p?.data) return;
      try { onFrame(p.data); } catch { /* a listener must not kill the socket */ }
      // Acked even when the listener threw: a missing ack stops the stream.
      if (p.sessionId !== undefined) {
        void this.send("Page.screencastFrameAck", { sessionId: p.sessionId }).catch(() => {});
      }
    });
    void this.send("Page.startScreencast", {
      format: "jpeg",
      // Low enough to stream, high enough to read UI text. This is a preview,
      // not the screenshot the model reasons about - that one is still a png.
      quality: 60,
      maxWidth,
      maxHeight: Math.round((maxWidth * 800) / 1280),
      everyNthFrame: 1,
    }).catch(() => { this.castOn = false; });
  }

  stopScreencast(): void {
    if (!this.castOn) return;
    this.castOn = false;
    void this.send("Page.stopScreencast", {}).catch(() => {});
  }

  get casting(): boolean {
    return this.castOn;
  }

  /** Everything the page has said since the last clear, oldest first. */
  consoleLines(): ConsoleEntry[] {
    return [...this.consoleBuf];
  }

  /** Every request since the last clear, in the order they were started. */
  networkLines(): NetEntry[] {
    return [...this.netBuf.values()];
  }

  /**
   * Forget both buffers.
   *
   * Called on navigation: "what went wrong on this page" is the question, and
   * carrying the previous page's 404s into it makes the answer useless.
   */
  clearDiagnostics(): void {
    this.consoleBuf.length = 0;
    this.netBuf.clear();
    this.netStart.clear();
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
    // Ask the browser to shut itself down before signalling it.
    //
    // Chromium writes its cookie database on a clean exit and may not on a
    // kill. With a throwaway profile that costs nothing, since the directory
    // is deleted anyway - but with a persistent one it loses exactly the
    // logins the profile exists to keep, and it loses them silently: the
    // session looks fine until the next launch starts at a sign-in page.
    //
    // Raced against a short timer and entirely best-effort. A browser that
    // will not answer still gets the signal below.
    if (this.ws && this.proc && this.proc.exitCode === null) {
      const exited = new Promise<void>((r) => this.proc?.once("exit", () => r()));
      // Ask, then wait for the process to actually go. Waiting on the reply
      // instead was the bug this comment exists for: Browser.close is
      // acknowledged the moment it is accepted, not when shutdown finishes, so
      // killing on the ack interrupted the flush it was sent to trigger. The
      // cookie database was created, and empty.
      void this.send("Browser.close", {}).catch(() => undefined);
      await Promise.race([exited, new Promise((r) => setTimeout(r, 4000))]);
    }

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
