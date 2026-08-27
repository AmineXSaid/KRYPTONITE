/**
 * The browser: address handling, text extraction, and a real fetch.
 *
 * The extraction half is where the value is. An <iframe> can display a page
 * but nothing can be read out of it - it is a different origin - so the text
 * the panel shows and the text the agent reads both come from here.
 *
 * The fetch runs against a loopback server, because what matters is behaviour
 * against real HTTP: redirects, a wrong content type, a body larger than the
 * cap, a 404 that still has a body worth reading.
 *
 * Run: npx esbuild test/browser.ts --bundle --outfile=dist/browser.cjs \
 *        --format=cjs --platform=node --target=node20 && node dist/browser.cjs
 */
import * as http from "node:http";
import { normaliseUrl, extractText, extractLinks, fetchPage } from "../src/browser/fetchPage";

let pass = 0;
let fail = 0;
function ck(ok: boolean, label: string, detail = "") {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
}
const threw = (fn: () => unknown): string => {
  try { fn(); return ""; } catch (e: any) { return String(e.message); }
};

(async () => {
  /* ── the address bar ─────────────────────────────────────────────── */
  console.log("──── addresses ────");
  ck(normaliseUrl("example.com") === "https://example.com/",
    "a bare host gets https, not http - defaulting to cleartext is a downgrade nobody asked for");
  ck(normaliseUrl("  example.com/a?b=1  ") === "https://example.com/a?b=1", "whitespace is trimmed");
  ck(normaliseUrl("http://localhost:3000") === "http://localhost:3000/", "an explicit scheme is kept");
  ck(/^https:\/\/example\.com\/x#y$/.test(normaliseUrl("https://example.com/x#y")), "a fragment survives");
  ck(/Enter an address/.test(threw(() => normaliseUrl(""))), "an empty address is refused");
  ck(/Enter an address/.test(threw(() => normaliseUrl("   "))), "so is whitespace");
  ck(/Only http and https/.test(threw(() => normaliseUrl("file:///etc/passwd"))),
    "file:// is refused - a browser panel is not a way to read the disk");
  ck(/Only http and https/.test(threw(() => normaliseUrl("javascript:alert(1)"))),
    "and so is javascript:");
  ck(threw(() => normaliseUrl("ht tp://bad host")) !== "", "an unparseable address is refused");
  // The case that stops the scheme check being a one-liner: that colon
  // introduces a port, not a scheme, and rejecting it would break every local
  // dev server anyone ever types in.
  ck(normaliseUrl("localhost:3000") === "https://localhost:3000/",
    "host:port is a port, not a scheme", normaliseUrl("localhost:3000"));
  ck(normaliseUrl("127.0.0.1:8080/x") === "https://127.0.0.1:8080/x", "and so is an address with a path");
  ck(/Only http and https/.test(threw(() => normaliseUrl("data:text/html,<h1>x"))), "data: is refused");
  ck(/Only http and https/.test(threw(() => normaliseUrl("vscode://settings"))), "custom schemes are refused");

  /* ── extraction ──────────────────────────────────────────────────── */
  console.log("\n──── reading a document ────");
  {
    const html = `<!doctype html><html><head><title>  Docs &amp; Guides </title>
      <style>body{color:red}</style><script>var x = "<p>not text</p>";</script></head>
      <body><h1>Heading</h1><p>First para.</p><p>Second&nbsp;para.</p>
      <div>Third</div><ul><li>one</li><li>two</li></ul>
      <noscript>enable js</noscript></body></html>`;
    const { title, text } = extractText(html);
    ck(title === "Docs & Guides", "the title is decoded and trimmed", title);
    ck(/First para\./.test(text) && /Second para\./.test(text), "paragraphs survive");
    ck(!/color:red/.test(text), "stylesheet contents are dropped, not escaped");
    ck(!/var x/.test(text), "and so are script contents");
    ck(!/not text/.test(text), "including markup inside a script string");
    ck(!/enable js/.test(text), "noscript is dropped");
    ck(!/<[a-z]/i.test(text), "no tags survive at all");
    ck(/one\s*\n?\s*two/.test(text) || (/one/.test(text) && /two/.test(text)), "list items survive");
    // Block boundaries have to become breaks or the whole page is one line.
    ck(text.split("\n").length > 2, "block elements become line breaks", String(text.split("\n").length));
  }
  {
    const { text } = extractText("<p>&lt;b&gt; &#65;&#x42; &quot;q&quot; &#39;a&#39;</p>");
    ck(/<b>/.test(text), "escaped markup decodes back to text, not to markup");
    ck(/AB/.test(text), "numeric entities decode, decimal and hex");
    ck(/"q"/.test(text) && /'a'/.test(text), "quote entities decode");
  }
  {
    // A malformed entity must not throw or produce garbage.
    const { text } = extractText("<p>&#x110000; &#999999999; &notarealentity;</p>");
    ck(typeof text === "string", "an out-of-range entity does not throw");
    ck(/&notarealentity;/.test(text), "an unknown entity is left as written");
  }
  {
    const { title } = extractText("<html><body>no title here</body></html>");
    ck(title === "", "a page with no title reports none rather than inventing one");
  }

  console.log("\n──── links ────");
  {
    const html =
      '<a href="/a">Relative</a>' +
      '<a href="https://other.example/b">Absolute</a>' +
      '<a href="mailto:x@y.z">Mail</a>' +
      '<a href="javascript:alert(1)">Script</a>' +
      '<a href="/a">Duplicate</a>' +
      '<a href="/c"><span>Nested <b>markup</b></span></a>';
    const links = extractLinks(html, "https://site.example/docs/page");
    const hrefs = links.map((l) => l.href);
    ck(hrefs.includes("https://site.example/a"), "a relative href resolves against the page");
    ck(hrefs.includes("https://other.example/b"), "an absolute href is kept");
    ck(!hrefs.some((h) => /^mailto:/.test(h)), "mailto: is dropped");
    ck(!hrefs.some((h) => /^javascript:/.test(h)), "javascript: is dropped");
    ck(hrefs.filter((h) => h === "https://site.example/a").length === 1, "duplicates collapse");
    const nested = links.find((l) => l.href.endsWith("/c"));
    ck(nested?.text === "Nested markup", "link text is flattened, not left as markup", nested?.text);
  }

  /* ── against a real server ───────────────────────────────────────── */
  console.log("\n──── fetching ────");
  let lastAgent = "";
  const server = http.createServer((req, res) => {
    lastAgent = String(req.headers["user-agent"] ?? "");
    const u = new URL(req.url!, "http://x");
    if (u.pathname === "/") {
      return res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
        .end("<html><head><title>Home</title></head><body><p>Hello there.</p><a href='/next'>Next</a></body></html>");
    }
    if (u.pathname === "/redir") {
      return res.writeHead(302, { location: "/" }).end();
    }
    if (u.pathname === "/plain") {
      return res.writeHead(200, { "content-type": "text/plain" }).end("just text, no tags");
    }
    if (u.pathname === "/missing") {
      return res.writeHead(404, { "content-type": "text/html" })
        .end("<html><body><h1>Not found</h1></body></html>");
    }
    if (u.pathname === "/huge") {
      res.writeHead(200, { "content-type": "text/html" });
      res.write("<html><body><p>");
      // Larger than the 8 MB ceiling, to prove the stream is cut rather than
      // buffered whole.
      for (let i = 0; i < 900; i++) res.write("x".repeat(10_000));
      res.end("</p></body></html>");
      return;
    }
    res.writeHead(500).end("boom");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  const base = `http://127.0.0.1:${port}`;

  {
    const p = await fetchPage(base + "/");
    ck(p.status === 200, "a page loads");
    ck(p.title === "Home", "with its title");
    ck(/Hello there\./.test(p.text), "and its text");
    ck(p.links.some((l) => l.href === base + "/next"), "and its links, resolved");
    ck(p.bytes > 0 && p.ms >= 0, "with size and timing");
    ck(/Genesis/.test(lastAgent),
      "identifying honestly - a blank agent gets a different page from many sites", lastAgent);
  }
  {
    const p = await fetchPage(base + "/redir");
    ck(p.status === 200, "a redirect is followed");
    ck(p.title === "Home", "to the page it points at");
  }
  {
    const p = await fetchPage(base + "/plain");
    ck(/just text, no tags/.test(p.text), "a non-HTML body is returned as-is");
    ck(p.links.length === 0, "and is not scanned for links");
  }
  {
    // A 404 body often explains what to do instead, so it is still read.
    const p = await fetchPage(base + "/missing");
    ck(p.status === 404, "a 404 reports its status");
    ck(/Not found/.test(p.text), "and its body is still readable");
  }
  {
    const p = await fetchPage(base + "/huge");
    ck(p.truncated, "an oversized page is truncated");
    ck(p.text.length <= 200_000, "and its text is capped", String(p.text.length));
  }
  {
    let msg = "";
    try { await fetchPage("https://127.0.0.1:1/nothing", { timeoutMs: 1500 }); }
    catch (e: any) { msg = e.message; }
    ck(msg !== "", "an unreachable address rejects rather than hanging", msg.slice(0, 50));
  }
  {
    const ac = new AbortController();
    const pending = fetchPage(base + "/huge", { signal: ac.signal });
    ac.abort();
    let aborted = false;
    try { await pending; } catch { aborted = true; }
    ck(aborted, "an in-flight fetch can be cancelled");
  }

  await new Promise<void>((r) => server.close(() => r()));
  console.log(`\n──── ${pass} passed, ${fail} failed ────`);
  process.exit(fail ? 1 : 0);
})();
