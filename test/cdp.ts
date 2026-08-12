/**
 * The CDP browser, driving a real Chrome or Edge.
 *
 * There is no useful way to fake this. The whole feature is "a real browser
 * did a real thing", so the test launches one, points it at a local page, and
 * checks that clicking and typing change what the page reports. A mocked CDP
 * socket would only prove that the mock replies.
 *
 * Skips itself, loudly, when no browser is installed - CI without one should
 * report that rather than fail.
 *
 * Run: npx esbuild test/cdp.ts --bundle --outfile=dist/cdp.cjs \
 *        --format=cjs --platform=node --target=node20 && node dist/cdp.cjs
 */
import * as fs from "node:fs";
import * as http from "node:http";
import { CdpBrowser, findBrowser, listBrowsers } from "../src/browser/cdp";
import { navigate, snapshot, screenshot, click, type, scroll, renderSnapshot } from "../src/browser/page";
import { sniffBytes } from "../src/providers/client";

let pass = 0;
let fail = 0;
function ck(ok: boolean, label: string, detail = "") {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
}

const PAGE = `<!doctype html><html><head><title>Kryptonite Test Page</title></head><body>
<h1>Heading One</h1>
<p id="status">idle</p>
<button id="go" onclick="document.getElementById('status').textContent='clicked'">Press me</button>
<input id="field" placeholder="Type here">
<button id="show" onclick="document.getElementById('status').textContent=document.getElementById('field').value">Show</button>
<a href="/second">Go to second</a>
<button id="hidden" style="display:none">Never visible</button>
<div style="height:2000px"></div>
<p id="bottom">Bottom marker</p>
<script>
  document.getElementById('field').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('status').textContent = 'submitted:' + e.target.value;
  });
</script>
</body></html>`;

const SECOND = `<!doctype html><html><head><title>Second Page</title></head>
<body><h1>Second</h1><p>You arrived.</p></body></html>`;

(async () => {
  /* ── detection ───────────────────────────────────────────────────── */
  console.log("──── which browser ────");
  {
    const found = listBrowsers();
    console.log("  " + (found.map((f) => `${f.name}`).join(", ") || "(none)"));
    for (const f of found) ck(fs.existsSync(f.path), `${f.name} really exists at its reported path`);
    ck(new Set(found.map((f) => f.path.toLowerCase())).size === found.length,
      "the same executable is never listed twice");
    // Nothing is bundled: an environment with no browser must report none
    // rather than pointing at something that is not there.
    ck(listBrowsers({} as any).length === 0, "an empty environment finds nothing");
    ck(findBrowser({} as any) === undefined, "and findBrowser agrees");
    // The override exists for a build in an unusual place, and has to win.
    const self = process.execPath;
    const over = listBrowsers({ KRYPTONITE_BROWSER: self } as any);
    ck(over[0]?.path === self, "KRYPTONITE_BROWSER takes precedence", over[0]?.path);
    ck(listBrowsers({ KRYPTONITE_BROWSER: "C:/nope/none.exe" } as any).every((f) => f.path !== "C:/nope/none.exe"),
      "an override pointing at nothing is ignored rather than trusted");
  }

  const exe = findBrowser();
  if (!exe) {
    console.log("SKIP  no Chrome or Edge found on this machine; the CDP suite needs one.");
    console.log("\n──── 0 passed, 0 failed (skipped) ────");
    process.exit(0);
  }
  console.log(`browser: ${exe}\n`);
  ck(true, "a browser is installed and was found");

  const server = http.createServer((req, res) => {
    const body = req.url === "/second" ? SECOND : PAGE;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;

  const cdp = new CdpBrowser(exe);
  try {
    console.log("──── launch ────");
    const t0 = Date.now();
    await cdp.launch({ viewport: { width: 1024, height: 720 } });
    ck(cdp.running, "the browser launches and attaches", `${Date.now() - t0}ms`);

    console.log("\n──── navigate and read ────");
    await navigate(cdp, base + "/");
    const s = await snapshot(cdp);
    ck(s.title === "Kryptonite Test Page", "the title is read back", s.title);
    ck(/Heading One/.test(s.text), "and the page text");
    ck(s.elements.length > 0, "interactive elements are found", String(s.elements.length));

    const byName = (n: string) => s.elements.find((e) => e.name === n);
    ck(!!byName("Press me"), "a button is listed with its label");
    ck(byName("Press me")?.role === "button", "with its role");
    ck(!!byName("Type here"), "an input is listed by its placeholder");
    ck(!!s.elements.find((e) => e.role === "link" && /second/i.test(e.name)), "and a link");
    // A hidden control offered as clickable produces a click that lands on
    // nothing, which is the most confusing failure this can have.
    ck(!s.elements.some((e) => e.name === "Never visible"), "a display:none control is not offered");
    ck(!s.elements.some((e) => e.name === "Bottom marker"), "and neither is anything below the fold");

    console.log("\n──── click ────");
    const before = await evalStatus(cdp);
    ck(before === "idle", "the page starts idle", before);
    await click(cdp, byName("Press me")!.ref);
    ck((await evalStatus(cdp)) === "clicked", "a click actually fires the page's handler");

    console.log("\n──── type ────");
    const field = (await snapshot(cdp)).elements.find((e) => e.name === "Type here")!;
    await type(cdp, field.ref, "hello world");
    const after = await snapshot(cdp);
    ck(after.elements.find((e) => e.ref === field.ref || e.name === "Type here")?.value === "hello world",
      "typing lands in the field",
      String(after.elements.find((e) => e.name === "Type here")?.value));

    const show = after.elements.find((e) => e.name === "Show")!;
    await click(cdp, show.ref);
    ck((await evalStatus(cdp)) === "hello world", "and the page can read it back");

    console.log("\n──── submit ────");
    const f2 = (await snapshot(cdp)).elements.find((e) => e.name === "Type here")!;
    await type(cdp, f2.ref, "query", { clear: true, submit: true });
    ck((await evalStatus(cdp)) === "submitted:query", "Enter submits", await evalStatus(cdp));

    console.log("\n──── screenshot ────");
    const png = await screenshot(cdp);
    ck(png.length > 1000, "a screenshot comes back", `${Math.round(png.length / 1024)} KB`);
    ck(sniffBytes(png) === "image/png", "and it is a real PNG");

    console.log("\n──── scroll ────");
    await scroll(cdp, 1200);
    const scrolled = await snapshot(cdp);
    ck(scrolled.elements.some((e) => e.name === "Bottom marker") ||
       (await evalNumber(cdp, "window.scrollY")) > 500,
      "scrolling moves the viewport", String(await evalNumber(cdp, "window.scrollY")));

    console.log("\n──── follow a link ────");
    await scroll(cdp, -2000);
    const top = await snapshot(cdp);
    const link = top.elements.find((e) => e.role === "link")!;
    await click(cdp, link.ref);
    await new Promise((r) => setTimeout(r, 700));
    const arrived = await snapshot(cdp);
    ck(arrived.title === "Second Page", "clicking a link navigates", arrived.title);
    ck(/You arrived/.test(arrived.text), "and the new page is readable");

    console.log("\n──── stale refs ────");
    let staleMsg = "";
    try { await click(cdp, "ref_9999"); } catch (e: any) { staleMsg = e.message; }
    ck(/no longer on the page/.test(staleMsg),
      "a ref that does not exist fails loudly rather than clicking somewhere else", staleMsg.slice(0, 60));

    console.log("\n──── rendering for the model ────");
    const rendered = renderSnapshot(arrived);
    ck(/Second Page/.test(rendered), "the render carries the title");
    ck(/Interactive elements/.test(rendered), "and labels the ref list");
    ck(/Page text/.test(rendered), "and the text");

    console.log("\n──── bad address ────");
    let navErr = "";
    try { await navigate(cdp, "http://127.0.0.1:1/nope", 8000); } catch (e: any) { navErr = e.message; }
    ck(navErr !== "", "an unreachable address reports an error", navErr.slice(0, 60));
  } finally {
    console.log("\n──── close ────");
    const t1 = Date.now();
    await cdp.close();
    ck(!cdp.running, "the browser closes", `${Date.now() - t1}ms`);
    // Closing twice happens on dispose paths; it must not throw.
    await cdp.close();
    ck(true, "and closing twice is safe");
    await new Promise<void>((r) => server.close(() => r()));
  }

  console.log(`\n──── ${pass} passed, ${fail} failed ────`);
  process.exit(fail ? 1 : 0);
})();

async function evalStatus(cdp: CdpBrowser): Promise<string> {
  const r = await cdp.send("Runtime.evaluate", {
    expression: "document.getElementById('status') ? document.getElementById('status').textContent : ''",
    returnByValue: true,
  });
  return String(r.result?.value ?? "");
}
async function evalNumber(cdp: CdpBrowser, expr: string): Promise<number> {
  const r = await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true });
  return Number(r.result?.value ?? 0);
}
