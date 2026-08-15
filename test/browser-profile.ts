/**
 * Does the agent's browser remember anything between launches?
 *
 * The reason this matters is the reason to have a browser the agent drives at
 * all: a login is performed once and used afterwards. The profile used to be
 * minted in a temp directory and deleted on close, so signing in to anything
 * was pointless the moment the window closed - the next launch started at the
 * sign-in page with no way to tell that it would.
 *
 * This is about the session, not about how the browser looks to a server. It
 * does not affect bot detection and is not meant to.
 *
 * Driven against a real Chromium launched twice, because "the profile
 * persists" is a claim about what a second process finds on disk, and nothing
 * short of a second process tests it.
 *
 * Skips itself, loudly, when no browser is installed.
 *
 * Run: npx esbuild test/browser-profile.ts --bundle --outfile=dist/browser-profile.cjs \
 *        --format=cjs --platform=node --target=node20 && node dist/browser-profile.cjs
 */
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { CdpBrowser, listBrowsers } from "../src/browser/cdp";
import { navigate, runJs } from "../src/browser/page";

let pass = 0;
const failures: string[] = [];
function ok(label: string, cond: boolean, detail = ""): void {
  if (cond) { pass++; return; }
  failures.push(label + (detail ? "  — " + detail : ""));
}

const TMP = path.join(os.tmpdir(), "kx-profile-" + Date.now());

function serve() {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><html><head><title>Profile</title></head><body><h1>ok</h1></body></html>");
  });
  return {
    server,
    listen: () =>
      new Promise<number>((r) => server.listen(0, "127.0.0.1", () => r((server.address() as any).port))),
  };
}

void (async () => {
  const found = listBrowsers();
  if (!found.length) {
    console.log("──── skipped: no Chromium-family browser on this machine ────");
    console.log(`\n${pass} passed, ${failures.length} failed`);
    process.exit(0);
  }

  fs.mkdirSync(TMP, { recursive: true });
  const s = serve();
  const port = await s.listen();
  // A real http origin, because localStorage and cookies are per-origin and
  // about:blank has none worth the name.
  const url = `http://127.0.0.1:${port}/`;
  const profileDir = path.join(TMP, "kept");

  try {
    /* ── a persistent profile survives the process ────────────────────── */
    {
      const first = new CdpBrowser(found[0].path);
      await first.launch({ profileDir, viewport: { width: 800, height: 600 } });
      ok("the profile directory is created", fs.existsSync(profileDir));

      await navigate(first, url);
      await runJs(first, `localStorage.setItem("kx-token", "signed-in"); "set"`);
      await runJs(first, `document.cookie = "kxsession=abc; path=/; max-age=3600"; "set"`);
      await first.close();

      ok("and is not deleted on close", fs.existsSync(profileDir));
      // Chromium only flushes some state at shutdown, so the files appearing
      // is the thing being checked, not merely the directory.
      ok("with the browser's own state written into it",
        fs.readdirSync(profileDir).length > 0, fs.readdirSync(profileDir).join(","));

      const second = new CdpBrowser(found[0].path);
      await second.launch({ profileDir, viewport: { width: 800, height: 600 } });
      await navigate(second, url);
      const token = await runJs(second, `localStorage.getItem("kx-token")`);
      const cookie = await runJs(second, `document.cookie`);
      await second.close();

      // This is the whole point: a login performed once is still there.
      ok("a second launch finds what the first stored", /signed-in/.test(token), token);
      ok("cookies survive too", /kxsession=abc/.test(cookie), cookie);
    }

    /* ── a throwaway profile does not, and cleans up ──────────────────── */
    {
      const before = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("kx-cdp-")).length;

      const one = new CdpBrowser(found[0].path);
      await one.launch({ viewport: { width: 800, height: 600 } });
      const during = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("kx-cdp-")).length;
      ok("a throwaway profile is made in the temp directory", during > before, `${before} -> ${during}`);

      await navigate(one, url);
      await runJs(one, `localStorage.setItem("kx-token", "should-not-survive"); "set"`);
      await one.close();

      // Not merely absent from the next launch: gone from the disk. A browser
      // profile left behind on every run is megabytes a time.
      const after = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("kx-cdp-")).length;
      ok("and removed on close", after <= before, `${before} -> ${during} -> ${after}`);

      const two = new CdpBrowser(found[0].path);
      await two.launch({ viewport: { width: 800, height: 600 } });
      await navigate(two, url);
      const token = await runJs(two, `localStorage.getItem("kx-token")`);
      await two.close();
      ok("a fresh launch remembers nothing", !/should-not-survive/.test(token), token);
    }

    /* ── the two do not contaminate each other ────────────────────────── */
    {
      // The persistent profile must still hold what it held, after a
      // throwaway launch has been and gone in between.
      const back = new CdpBrowser(found[0].path);
      await back.launch({ profileDir, viewport: { width: 800, height: 600 } });
      await navigate(back, url);
      const token = await runJs(back, `localStorage.getItem("kx-token")`);
      await back.close();
      ok("the kept profile is untouched by a throwaway one", /signed-in/.test(token), token);
    }
  } finally {
    await new Promise<void>((r) => s.server.close(() => r()));
    try {
      fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3 });
    } catch { /* the OS will reap it */ }
  }

  if (failures.length) for (const f of failures) console.log("FAIL  " + f);
  console.log(`\n${pass} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();
