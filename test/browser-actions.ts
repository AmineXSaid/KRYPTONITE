/**
 * The browser actions added to reach parity with a real agent browser, driven
 * against a real Chromium.
 *
 * Clicking and typing were already covered. What was missing was everything
 * needed to *debug* a page rather than merely operate one - what it logged,
 * what it requested, what a computed value is - plus the interactions that
 * `type` cannot express: a <select> ignores keystrokes, a checkbox has no text
 * to insert, and Escape is not a character.
 *
 * There is no useful way to fake any of this. A mocked CDP socket proves the
 * mock replies; a real browser proves the page actually logged the thing, the
 * request actually failed, and the change event actually fired.
 *
 * Skips itself, loudly, when no browser is installed.
 *
 * Run: npx esbuild test/browser-actions.ts --bundle --outfile=dist/browser-actions.cjs  *        --format=cjs --platform=node --target=node20 && node dist/browser-actions.cjs
 */
import * as http from "node:http";
import { CdpBrowser, listBrowsers } from "../src/browser/cdp";
import * as page from "../src/browser/page";


let pass = 0;
const failures: string[] = [];
function ok(label: string, cond: boolean, detail = "") {
  if (cond) { pass++; return; }
  failures.push(label + (detail ? "  — " + detail : ""));
}

const PAGE = `<!doctype html><html><head><title>Actions</title></head><body>
<h1>Actions</h1>
<p id="status">idle</p>
<select id="pick"><option value="a">Alpha</option><option value="b">Beta</option></select>
<input id="agree" type="checkbox">
<input id="field" placeholder="Type here">
<button id="menu">Menu</button>
<div id="pop" style="display:none">Popped open</div>
<p id="late"></p>
<img src="/missing.png" alt="broken on purpose">
<script>
  console.log('hello from the page', { a: 1 });
  console.warn('a warning');
  console.error('an error line');
  fetch('/api/ok').then(() => {});
  fetch('/api/gone').then(() => {});
  document.getElementById('pick').addEventListener('change', function (e) {
    document.getElementById('status').textContent = 'picked:' + e.target.value;
  });
  document.getElementById('agree').addEventListener('change', function (e) {
    document.getElementById('status').textContent = 'agree:' + e.target.checked;
  });
  document.getElementById('menu').addEventListener('mouseover', function () {
    document.getElementById('pop').style.display = 'block';
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') document.getElementById('status').textContent = 'escaped';
  });
  setTimeout(function () { document.getElementById('late').textContent = 'arrived late'; }, 900);
  setTimeout(function () { throw new Error('thrown on purpose'); }, 50);
</script>
</body></html>`;

const SECOND = `<!doctype html><html><head><title>Second</title></head><body><h1>Second</h1></body></html>`;

(async () => {
  const found = listBrowsers();
  if (!found.length) {
    console.log("──── skipped: no Chromium-family browser on this machine ────");
    console.log("\n──── 0 passed, 0 failed ────");
    return;
  }

  const server = http.createServer((req, res) => {
    const u = req.url!.split("?")[0];
    if (u === "/api/ok") return res.writeHead(200, { "content-type": "application/json" }).end("{}");
    if (u === "/api/gone") return res.writeHead(503).end("no");
    if (u === "/missing.png") return res.writeHead(404).end("no");
    if (u === "/second") return res.writeHead(200, { "content-type": "text/html" }).end(SECOND);
    res.writeHead(200, { "content-type": "text/html" }).end(PAGE);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = "http://127.0.0.1:" + (server.address() as any).port;

  const cdp = new CdpBrowser(found[0].path);
  await cdp.launch({ viewport: { width: 1280, height: 800 } });
  console.log("──── driving " + found[0].name + " ────\n");

  try {
    await page.navigate(cdp, base + "/");
    const refOf = async (needle: string) => {
      const s = await page.snapshot(cdp);
      const hit = page.findRefs(s, needle)[0];
      if (!hit) throw new Error("no ref for " + needle);
      return hit.ref;
    };

    /* ── what the page said ────────────────────────────────────────── */
    console.log("──── console ────");
    {
      const lines = cdp.consoleLines();
      const text = lines.map((l) => l.level + " " + l.text).join("\n");
      ok("the page's own log is captured", /hello from the page/.test(text));
      // An object logged from the page has no value over the wire; without a
      // preview every one of them reads as "Object".
      ok("and a logged object is described, not printed as Object", /a: 1/.test(text), text.slice(0, 120));
      ok("warnings are marked as warnings", lines.some((l) => l.level === "warning"));
      ok("errors as errors", lines.some((l) => l.level === "error" && /an error line/.test(l.text)));
      // The line most worth having, and the one console.log never carries.
      ok("an uncaught exception is captured", /thrown on purpose/.test(text), "");
      // The browser's own complaints, not the page's.
      ok("and so is the browser's own 404 report",
        /404|missing\.png/.test(text) || cdp.networkLines().some((r) => r.status === 404));
    }

    /* ── what it asked for ─────────────────────────────────────────── */
    console.log("\n──── network ────");
    {
      const rows = cdp.networkLines();
      ok("requests are recorded", rows.length >= 3, String(rows.length));
      ok("with their status", rows.some((r) => r.url.endsWith("/api/ok") && r.status === 200));
      ok("including the failures", rows.some((r) => r.url.endsWith("/api/gone") && r.status === 503));
      ok("and how long they took", rows.some((r) => typeof r.ms === "number"));
      ok("the document itself is in there", rows.some((r) => r.kind === "Document"));
    }

    /* ── evaluating in the page ────────────────────────────────────── */
    console.log("\n──── eval ────");
    {
      ok("a bare expression returns its value",
        (await page.runJs(cdp, "document.title")) === "Actions");
      ok("a statement body works too",
        (await page.runJs(cdp, "return 6 * 7")) === "42");
      const styled = await page.runJs(cdp, "getComputedStyle(document.body).display");
      ok("computed style is reachable, which is the point of it", styled === "block", styled);
      const obj = await page.runJs(cdp, "({ a: 1, b: [2,3] })");
      ok("an object comes back as json", /"a": 1/.test(obj), obj);
    }

    /* ── form controls typing cannot reach ─────────────────────────── */
    console.log("\n──── set ────");
    {
      const pick = await refOf("select");
      const now = await page.setValue(cdp, pick, "Beta");
      ok("a select can be set by its visible label", now === "b", now);
      const status = await page.runJs(cdp, "document.getElementById('status').textContent");
      // The assignment alone would leave the page looking right and behaving
      // as though nothing happened.
      ok("and the page's change handler actually fired", status === "picked:b", status);
    }
    {
      const box = await refOf("checkbox");
      await page.setValue(cdp, box, "true");
      const status = await page.runJs(cdp, "document.getElementById('status').textContent");
      ok("a checkbox can be ticked", status === "agree:true", status);
    }
    {
      const pick = await refOf("select");
      let msg = "";
      try { await page.setValue(cdp, pick, "Gamma"); } catch (e: any) { msg = String(e.message); }
      ok("an option that does not exist fails loudly", /No option matching/.test(msg), msg);
      ok("and says what the options were", /Alpha/.test(msg) && /Beta/.test(msg), msg);
    }

    /* ── keys and hover ────────────────────────────────────────────── */
    console.log("\n──── key and hover ────");
    {
      await page.pressKey(cdp, "escape");
      const status = await page.runJs(cdp, "document.getElementById('status').textContent");
      ok("a named key reaches the page", status === "escaped", status);
      let msg = "";
      try { await page.pressKey(cdp, "flurb"); } catch (e: any) { msg = String(e.message); }
      ok("an unknown key is refused with the list", /Unknown key/.test(msg) && /escape/.test(msg));
    }
    {
      const menu = await refOf("Menu");
      await page.hover(cdp, menu);
      const shown = await page.runJs(cdp, "getComputedStyle(document.getElementById('pop')).display");
      ok("hovering reveals what a mouse passing over would", shown === "block", shown);
    }

    /* ── waiting ───────────────────────────────────────────────────── */
    console.log("\n──── wait ────");
    {
      const t0 = Date.now();
      const out = await page.waitFor(cdp, { text: "arrived late" }, 6000);
      const took = Date.now() - t0;
      ok("waiting for text returns once it is there", /Found/.test(out), out);
      ok("and does not sit out the whole timeout", took < 4000, took + "ms");
    }
    {
      ok("waiting for a selector works", /Found/.test(await page.waitFor(cdp, { selector: "#late" }, 4000)));
    }
    {
      let msg = "";
      try { await page.waitFor(cdp, { text: "never appears anywhere" }, 1200); }
      catch (e: any) { msg = String(e.message); }
      ok("and a wait that never comes true fails, rather than hanging", /never saw/.test(msg), msg);
    }

    /* ── viewport ──────────────────────────────────────────────────── */
    console.log("\n──── resize ────");
    {
      // This page deliberately has no <meta name="viewport">, so a phone-sized
      // request is answered the way a phone answers it: a 980px layout viewport
      // scaled down. Correct emulation, and a real finding about the page.
      const small = await page.resize(cdp, 400, 700);
      ok("a phone-sized viewport emulates a phone", small.mobile === true);
      ok("and reports the width the page really used, not the one asked for",
        small.asked === 400 && small.actual === 980,
        `asked ${small.asked}, got ${small.actual}`);
      const wide = await page.resize(cdp, 1100, 800);
      ok("a desktop width is not mobile-emulated", wide.mobile === false);
      ok("and lays out at the width requested", wide.actual === 1100, String(wide.actual));
      await page.resize(cdp, 1280, 800, "dark");
      const dark = await page.runJs(cdp, "String(matchMedia('(prefers-color-scheme: dark)').matches)");
      ok("and the page can be told it is a dark theme", dark === "true", dark);
      await page.resize(cdp, 1280, 800, "light");
    }

    /* ── history ───────────────────────────────────────────────────── */
    console.log("\n──── forward ────");
    {
      await page.navigate(cdp, base + "/second");
      ok("navigation clears the previous page's console",
        !cdp.consoleLines().some((l) => /hello from the page/.test(l.text)));
      await page.goBack(cdp);
      ok("back returns", (await page.snapshot(cdp)).title === "Actions");
      await page.goForward(cdp);
      ok("and forward goes again", (await page.snapshot(cdp)).title === "Second");
    }

    /* ── find ──────────────────────────────────────────────────────── */
    console.log("\n──── find ────");
    {
      await page.navigate(cdp, base + "/");
      const s = await page.snapshot(cdp);
      ok("a query matches by name", page.findRefs(s, "menu").length === 1);
      ok("and by role", page.findRefs(s, "checkbox").length === 1);
      ok("every word has to match", page.findRefs(s, "menu nonsense").length === 0);
      ok("and nothing matches nothing", page.findRefs(s, "").length === 0);
    }

    /* ── the live view ─────────────────────────────────────────────── */
    console.log("\n──── screencast ────");
    {
      const frames: string[] = [];
      cdp.startScreencast((d: string) => frames.push(d), 640);
      ok("the browser reports it is casting", cdp.casting === true);
      // Something has to change for a frame to be produced.
      await page.scroll(cdp, 200);
      await new Promise((r) => setTimeout(r, 1200));
      cdp.stopScreencast();
      ok("frames arrive from a headless browser", frames.length > 0, frames.length + " frames");
      ok("and they are jpeg", frames.length > 0 &&
        Buffer.from(frames[0], "base64").subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])));
      ok("stopping is reflected", cdp.casting === false);
    }
  } finally {
    await cdp.close();
    await new Promise<void>((r) => server.close(() => r()));
  }

  if (failures.length) for (const f of failures) console.log("FAIL  " + f);
  console.log(`\n──── ${pass} passed, ${failures.length} failed ────`);
  process.exitCode = failures.length ? 1 : 0;
})();
