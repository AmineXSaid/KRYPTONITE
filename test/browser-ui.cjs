/**
 * The browser panel's frontend, in jsdom.
 *
 * The address bar is the part that has to be right: an address typed without a
 * scheme is a *relative* URL to an <iframe>, so it resolves against the
 * webview's own origin and silently loads nothing - and typing without a
 * scheme is how everyone types. The host normalising it for its fetch never
 * reached the frame.
 *
 * History is the panel's own rather than the frame's, because `history.back()`
 * on a cross-origin frame is blocked: a back button driven by it would work on
 * some sites and quietly do nothing on others.
 *
 * Run: node test/browser-ui.cjs
 */
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; return; }
  failures.push(label + (detail ? "  — " + detail : ""));
}

const SRC = fs.readFileSync(path.join(__dirname, "..", "media", "webview", "browser.js"), "utf8");

function boot() {
  const dom = new JSDOM(`<!doctype html><html><body><div id="root"></div></body></html>`, {
    runScripts: "outside-only", pretendToBeVisual: true, url: "https://webview.local/",
  });
  const w = dom.window;
  const sent = [];
  w.__kx = { api: { postMessage: (m) => sent.push(m) } };
  w.eval(SRC);
  const d = w.document;
  const $ = (id) => d.getElementById(id);
  const enter = (v) => {
    $("bUrl").value = v;
    $("bUrl").dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  };
  const frameSrc = () => d.querySelector("#bStage iframe")?.getAttribute("src");
  const inbound = (m) => w.dispatchEvent(new w.MessageEvent("message", { data: m }));
  return { w, d, $, sent, enter, frameSrc, inbound };
}

/* ── chrome ──────────────────────────────────────────────────────────── */
{
  const { d, $ } = boot();
  for (const id of ["bBack", "bFwd", "bGo", "bUrl", "bLive", "bRead", "bAgent", "bExt", "bStage", "bFoot"]) {
    ok(`the toolbar has ${id}`, !!$(id));
  }
  ok("it opens on an explanation rather than a blank frame", /Browser/.test($("bStage").textContent));
  ok("back and forward start disabled", $("bBack").disabled && $("bFwd").disabled);
  ok("send-to-chat is disabled until something has been fetched", $("bAgent").disabled);
  ok("Live is the starting view", $("bLive").getAttribute("aria-pressed") === "true");
  void d;
}

/* ── the address bar ─────────────────────────────────────────────────── */
{
  const { enter, frameSrc, $ } = boot();

  enter("example.com");
  ok("a bare host becomes an absolute https URL, not a relative one",
    frameSrc() === "https://example.com", frameSrc());

  enter("http://localhost:3000");
  ok("an explicit scheme is kept", frameSrc() === "http://localhost:3000", frameSrc());

  enter("localhost:3000");
  ok("host:port is a port, not a scheme", frameSrc() === "https://localhost:3000", frameSrc());

  // Rejected in the panel as well as in the host: this one must never reach an
  // iframe src at all.
  enter("javascript:alert(1)");
  ok("javascript: is refused", /Only http and https/.test($("bStage").textContent));
  ok("and never becomes a frame", !$("bStage").querySelector("iframe"));

  enter("file:///etc/passwd");
  ok("file:// is refused", /Only http and https/.test($("bStage").textContent));

  const before = $("bStage").innerHTML;
  enter("   ");
  ok("an empty address does nothing", $("bStage").innerHTML === before);
}

/* ── history ─────────────────────────────────────────────────────────── */
{
  const { enter, frameSrc, $ } = boot();
  enter("a.example"); enter("b.example"); enter("c.example");
  ok("three pages leaves back available", !$("bBack").disabled);
  ok("and forward unavailable", $("bFwd").disabled);

  $("bBack").click();
  ok("back moves to the previous page", frameSrc() === "https://b.example", frameSrc());
  ok("and forward becomes available", !$("bFwd").disabled);

  $("bBack").click();
  ok("back again reaches the first", frameSrc() === "https://a.example", frameSrc());
  ok("where back is exhausted", $("bBack").disabled);

  $("bFwd").click();
  ok("forward returns", frameSrc() === "https://b.example", frameSrc());

  // Navigating from mid-history drops what was ahead, as everywhere else.
  enter("d.example");
  ok("a new address from mid-history becomes the tip", frameSrc() === "https://d.example");
  ok("and discards the forward entries", $("bFwd").disabled);
}

/* ── live and reader ─────────────────────────────────────────────────── */
{
  const { enter, sent, $, inbound, d } = boot();

  enter("example.com");
  ok("Live frames without fetching - it costs nothing the iframe does not",
    !sent.some((m) => m.type === "browserOpen"));
  const f = d.querySelector("#bStage iframe");
  ok("the frame is sandboxed", /allow-scripts/.test(f.getAttribute("sandbox")));
  ok("and sends no referrer", f.getAttribute("referrerpolicy") === "no-referrer");

  sent.length = 0;
  $("bRead").click();
  ok("switching to Reader asks the host to fetch",
    sent.some((m) => m.type === "browserOpen" && m.url === "https://example.com"));
  ok("and the segment reflects it", $("bRead").getAttribute("aria-pressed") === "true");

  inbound({ type: "browserPage", page: {
    url: "https://example.com/", finalUrl: "https://example.com/", status: 200,
    title: "Example Domain", text: "This domain is for use in examples.",
    links: [{ href: "https://iana.org/x", text: "More" }],
    contentType: "text/html; charset=utf-8", bytes: 1256, ms: 84, truncated: false } });

  ok("the title renders", d.querySelector(".reader h1")?.textContent === "Example Domain");
  ok("the body renders", /for use in examples/.test($("bStage").textContent));
  ok("links are listed", d.querySelectorAll(".links a").length === 1);
  const foot = $("bFoot").textContent;
  ok("the status line carries status, type, size and timing",
    /200/.test(foot) && /text\/html/.test(foot) && /1.2 KB/.test(foot) && /84ms/.test(foot), foot);
  ok("send-to-chat is now available", !$("bAgent").disabled);

  sent.length = 0;
  $("bAgent").click();
  const toAgent = sent.find((m) => m.type === "browserToAgent");
  ok("it hands the page text to the chat", !!toAgent && /for use in examples/.test(toAgent.text));
  ok("with the address it came from", toAgent?.url === "https://example.com/");

  // A link inside the reader navigates the panel rather than the document.
  sent.length = 0;
  d.querySelector(".links a").dispatchEvent(new d.defaultView.MouseEvent("click", { bubbles: true, cancelable: true }));
  ok("a reader link navigates in the panel",
    sent.some((m) => m.type === "browserOpen" && m.url === "https://iana.org/x"));
}

/* ── failures ────────────────────────────────────────────────────────── */
{
  const { enter, $, inbound } = boot();
  enter("example.com");
  $("bRead").click();
  inbound({ type: "browserError", message: "getaddrinfo ENOTFOUND example.com" });
  ok("a fetch failure is explained", /ENOTFOUND/.test($("bStage").textContent));
  ok("and the spinner stops", !$("bBusy").querySelector("svg"));
}
{
  // Page content reaches the reader, so it must not survive as markup.
  const { enter, $, inbound, d } = boot();
  enter("example.com");
  $("bRead").click();
  inbound({ type: "browserPage", page: {
    url: "https://x/", finalUrl: "https://x/", status: 200,
    title: "<img src=x onerror=alert(1)>", text: "<script>alert(2)</script>",
    links: [{ href: "https://x/a", text: "<b>bold</b>" }],
    contentType: "text/html", bytes: 10, ms: 1, truncated: false } });
  ok("a hostile title cannot inject markup", d.querySelectorAll("#bStage img").length === 0);
  ok("nor can the body", d.querySelectorAll("#bStage script").length === 0);
  ok("nor can link text", d.querySelectorAll("#bStage .links b").length === 0);
  ok("and the text is still shown, escaped", /alert\(2\)/.test($("bStage").textContent));
}

/* ── the agent's browser: launcher and live view ────────────────────────── */
{
  const { d, w, sent, inbound: send } = boot();
  const sentTypes = () => sent.map((m) => m.type);
  const click = (sel) => {
    const el = d.querySelector(sel);
    if (el) el.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    return !!el;
  };
  const JPEG = "/9j/4AAQSkZJRgABAQEAYABgAAD/2Q==";

  ok("the panel offers a third view for the agent's browser", !!d.getElementById("bAgentView"));
  click("#bAgentView");
  ok("selecting it marks the segment",
    d.getElementById("bAgentView").getAttribute("aria-pressed") === "true");

  // Nothing running: a launcher, not an empty box.
  ok("with no browser it shows a launcher", !!d.querySelector(".launch-card"));
  ok("saying plainly that none is running",
    /No browser running/.test(d.querySelector(".launch-card h2").textContent));
  // Starting a browser puts a process on someone's machine. The copy says so
  // rather than presenting it as a toggle.
  ok("and what pressing the button will do",
    /headless by default/.test(d.querySelector(".launch-card p").textContent));
  ok("there is one obvious action", (d.querySelector("#aStart").textContent || "").trim() === "Launch browser");
  ok("and nothing to close yet", !d.querySelector("#aClose"));

  click("#aStart");
  ok("pressing it asks the host to start one", sentTypes().includes("agentStart"));
  // The browser takes a second or two to come up; a blank stage in the
  // meantime reads as a failure.
  ok("and it waits visibly", !!d.querySelector(".live-wait"));

  send({ type: "agentState", running: true, live: true, url: "https://shop.internal/p/4417", title: "Product 4417" });
  send({ type: "agentFrame", data: JPEG });
  const img = d.querySelector(".live-frame img");
  ok("a frame is rendered", !!img);
  ok("as a data uri, never a remote src", (img.getAttribute("src") || "").startsWith("data:image/jpeg;base64,"),
    "the webview must never fetch from the page's origin");
  ok("the strip names the page", /Product 4417/.test(d.querySelector(".live-t").textContent));
  ok("and carries the address in full", /shop\.internal/.test(d.querySelector(".live-t").getAttribute("title")));

  // The failure this exists to prevent: a stopped stream that keeps showing
  // its last frame. A stale picture and a current one look identical.
  click("#aStop");
  ok("stopping asks the host to stop", sentTypes().includes("agentStop"));
  send({ type: "agentState", running: true, live: false, url: "", title: "" });
  ok("the stale frame is dropped, not left on screen", !d.querySelector(".live-frame img"));
  ok("and the launcher returns", !!d.querySelector(".launch-card"));
  ok("now offering to watch the browser that is still up",
    (d.querySelector("#aStart").textContent || "").trim() === "Watch it");
  ok("and to close it", !!d.querySelector("#aClose"));

  send({ type: "agentState", running: false, live: false, url: "", title: "" });
  ok("closing it returns to the first state",
    /No browser running/.test(d.querySelector(".launch-card h2").textContent));
  ok("with no close button, since there is nothing to close", !d.querySelector("#aClose"));

  send({ type: "agentError", message: "No Chromium-family browser is installed." });
  ok("a launch failure is explained", /could not start/i.test(d.querySelector(".blank-in.err h2").textContent));
  ok("with the reason verbatim",
    /No Chromium-family browser/.test(d.querySelector(".blank-in.err p").textContent));
}

/* ── typography ─────────────────────────────────────────────────────────── */
{
  const CSS = fs.readFileSync(path.join(__dirname, "..", "media", "webview", "browser.css"), "utf8");
  // Form controls do not inherit a font. Without this line every button and
  // input in the panel falls back to the platform default - measured as Arial
  // - while everything around them is set in the house sans. It reads as
  // "slightly wrong" long before anyone can name it.
  ok("form controls inherit the panel's font",
    /button,\s*input,\s*select,\s*textarea\s*\{[^}]*font:\s*inherit/.test(CSS));
  ok("headings use the display cut", /\.launch-card h2\s*\{[^}]*var\(--kx-display\)/.test(CSS));
  ok("body copy uses the text cut", /body\s*\{[^}]*var\(--kx-ui\)/.test(CSS));
  // The address bar is the one deliberate exception: an address is data, and a
  // proportional font makes a url harder to scan.
  ok("the address bar stays monospace", /\.addr input\s*\{[^}]*var\(--kx-mono\)/.test(CSS));
}

console.log(`\n${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log("  FAIL  " + f);
process.exit(failures.length ? 1 : 0);
