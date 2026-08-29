/**
 * The Control Center's frontend, in jsdom.
 *
 * Sixteen hundred lines of DOM building that nothing rendered until this file.
 * `drive.js` covers the sidebar and `browser-ui.cjs` the browser panel; the
 * largest of the three surfaces was reached only by opening it and looking.
 *
 * What breaks in a file like this is never the happy path. It is a section
 * with no branch for the state it was handed, a field read off an object the
 * host did not send, a count key that was simply missing - the panel showed
 * the literal string "undefined" next to MCP servers for everyone who had it
 * open, and the fix carries a comment saying so. So the shape of this file is:
 * render every section against a full state, then against an empty one, then
 * against a broken one, and assert that a hostile profile name cannot become
 * markup.
 *
 * The pane is read as `textContent` and as `innerHTML` deliberately. Text says
 * what a person sees; the HTML is where an unescaped `<img onerror>` would be
 * hiding, and a test that only reads text would pass while the panel executed
 * whatever a YAML file called itself.
 *
 * Run: node test/control-center.cjs
 */
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM, VirtualConsole } = require("jsdom");

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; return; }
  failures.push(label + (detail ? "  — " + detail : ""));
}

const ROOT = path.join(__dirname, "..");
const CRYSTAL = fs.readFileSync(path.join(ROOT, "media/webview/crystal.js"), "utf8");
const SRC = fs.readFileSync(path.join(ROOT, "media/webview/controlCenter.js"), "utf8");

/** Every section id the strip offers, read from the source rather than retyped. */
const SECTIONS = (() => {
  const m = SRC.match(/var SECTIONS = \[[\s\S]*?\];/);
  if (!m) throw new Error("SECTIONS not found in controlCenter.js");
  return [...m[0].matchAll(/\["([a-z]+)",\s*"/g)].map((x) => x[1]);
})();

function boot() {
  const errors = [];
  const vc = new VirtualConsole();
  // An exception inside a listener does not propagate to dispatchEvent, so a
  // renderer that throws would otherwise look exactly like one that rendered
  // nothing. jsdom reports those here.
  vc.on("jsdomError", (e) => errors.push(String(e && e.message ? e.message : e)));
  vc.on("error", (e) => errors.push(String(e)));

  const dom = new JSDOM(`<!doctype html><html><body><div id="root"></div></body></html>`, {
    runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: vc,
  });
  const w = dom.window;
  const sent = [];
  w.__kx = { api: { postMessage: (m) => sent.push(m), getState: () => null, setState: () => {} } };
  w.eval(CRYSTAL);
  w.eval(SRC);

  const d = w.document;
  const send = (m) => w.dispatchEvent(new w.MessageEvent("message", { data: m }));
  const click = (sel) => {
    const el = d.querySelector(sel);
    if (!el) return false;
    el.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    return true;
  };
  const pane = () => d.getElementById("pane");
  return { dom, w, d, sent, errors, send, click, pane };
}

const CAPS = {
  streaming: true, tools: true, toolChoice: true, vision: true,
  systemRole: "message", contextWindow: 128000, maxOutputTokens: 4096,
  tokenCounting: "heuristic", maxImageBytes: 1500000, parallelToolCalls: false,
  promptCaching: "none", cacheTtl: "5m", parallelToolExecution: true,
};

function profile(over = {}) {
  return {
    id: "gateway", description: "Internal gateway", model: "gpt-4o", wire: "openai",
    baseUrl: "https://llm.internal", chatPath: null, status: "ready",
    sourceFile: ".agent/endpoints/gateway.yaml", active: true,
    authKind: "bearer", authSummary: "${secret:key}", authCache: null,
    tls: { ca: ["system"], clientCert: null, minVersion: "TLSv1.2", servername: null, insecure: false },
    proxy: { url: null, fromEnv: true, noProxy: [] },
    capabilities: { ...CAPS }, headers: {}, query: {}, extraBody: {},
    timeoutMs: 120000, retries: 2, transform: null, http2: false,
    ...over,
  };
}

/** A full McpServerDto, so a fixture cannot pass by being unlike the real thing. */
function server(over = {}) {
  return {
    name: "srv", state: "ready", command: "npx -y @modelcontextprotocol/server-filesystem .",
    toolCount: 0, tools: [], approval: "ask", ...over,
  };
}

function state(over = {}) {
  return {
    workspace: { open: true, name: "repo" },
    running: false, phase: "act", status: { state: "ok", label: "OK" },
    endpoint: "gateway", profiles: [profile()],
    skills: [{ name: "lin-test-review", description: "Review tests", source: "workspace", enabled: true, files: ["SKILL.md"] }],
    skillWarnings: [], config: {
      approvalMode: "ask", activeProfile: "gateway", caBundlePath: "",
      profileDirectory: ".agent/endpoints", skillsDirectory: ".agent/skills", ui: {},
    },
    tlsError: null, rungs: [], tracing: false, todos: [], checkpoints: [],
    sessions: [], selection: null, context: null, models: [], logs: [],
    session: { id: "s", title: "t", messages: [] },
    mcp: { servers: [], warnings: [] },
    ...over,
  };
}

const sync = (b, over) => b.send({ type: "stateSync", state: state(over) });

/* ── 1. it mounts ───────────────────────────────────────────────────────── */
{
  const b = boot();
  ok("mounts before any state arrives", !!b.d.getElementById("cc"));
  ok("with the strip and the pane", !!b.d.getElementById("strip") && !!b.pane());
  ok("and the wordmark", /Genesis/.test(b.d.querySelector(".cc-wordmark").textContent));
  ok("the chip says there is no profile yet",
    /no profile/.test(b.d.getElementById("ccChip").textContent));
  // Nothing has been sent, so the panel must not claim a folder is open.
  ok("and the pane offers the no-folder explainer",
    /No folder open/.test(b.pane().textContent), b.pane().textContent.slice(0, 40));
  ok("mounting throws nothing", b.errors.length === 0, b.errors.join(" | "));
  b.dom.window.close();
}

/* ── 2. every section renders ───────────────────────────────────────────── */
/* The failure this is for: a section whose branch was never written, or one
   that reads a field off a sub-object the host did not send. Both look like an
   empty pane, and neither shows up until someone clicks that tab. */
{
  const b = boot();
  sync(b, {
    rungs: [
      { name: "DNS", status: "pass", detail: "resolved", ms: 12 },
      { name: "TLS handshake", status: "fail", detail: "self signed", fix: "Add the CA.", ms: 88 },
    ],
    checkpoints: [{ hash: "abc1234", label: "before edit", when: "2h ago" }],
    logs: [{ t: Date.now(), level: "error", msg: "something failed" },
           { t: Date.now(), level: "info", msg: "hello" }],
    mcp: {
      servers: [
        server({ name: "filesystem", state: "ready", toolCount: 2, tools: ["read_file", "write_file"] }),
        server({ name: "github", state: "failed", error: "spawn ENOENT" }),
        server({ name: "docs", state: "disabled" }),
      ],
      warnings: ["one server is disabled"],
    },
  });
  ok("the strip offers every section", SECTIONS.length === 8, String(SECTIONS.length));

  for (const id of SECTIONS) {
    const before = b.errors.length;
    const clicked = b.click(`[data-section="${id}"]`);
    ok(`${id}: has a tab in the strip`, clicked);
    const html = b.pane().innerHTML;
    const text = b.pane().textContent.trim();
    ok(`${id}: renders something`, text.length > 20, `${text.length} chars`);
    ok(`${id}: renders without throwing`, b.errors.length === before,
      b.errors.slice(before).join(" | "));
    // The bug the file's own comments record: a missing count key printed the
    // word "undefined" into the panel. It is worth catching everywhere, not
    // only where it happened.
    // NOT `\bundefined\b`. `textContent` runs a kv row's label straight into
    // its value with no separator, so an unguarded field reads as
    // "Timeoutundefined ms" - and `\b` needs a non-word character before the
    // "u", which there is not. The word-bounded form silently passed the one
    // shape this table actually produces. Bare, because the panel has no
    // business printing that string anywhere, glued or not.
    ok(`${id}: prints no undefined`, !/undefined/.test(text),
      text.slice(Math.max(0, text.indexOf("undefined") - 30), text.indexOf("undefined") + 20));
    ok(`${id}: prints no [object Object]`, !/\[object Object\]/.test(text));
    // Not asserting on `${` here: a profile's auth summary is *supposed* to
    // read `${secret:key}`, since showing the template rather than the value
    // is the whole point of it.
    ok(`${id}: builds real elements rather than escaped markup`,
      !/&lt;(div|span|button)/.test(html));
    ok(`${id}: marks its tab selected`,
      b.d.querySelector(`[data-section="${id}"]`).getAttribute("aria-selected") === "true");
  }
  b.dom.window.close();
}

/* ── 3. every section survives an empty workspace ───────────────────────── */
/* A first run has no profiles, no skills, no logs and no servers. Every count
   is zero and every list is empty, which is the state most likely to reach a
   branch that assumed at least one of something. */
{
  const b = boot();
  b.send({ type: "stateSync", state: state({
    profiles: [], skills: [], checkpoints: [], logs: [], rungs: [],
    mcp: { servers: [], warnings: [] },
  }) });
  for (const id of SECTIONS) {
    const before = b.errors.length;
    b.click(`[data-section="${id}"]`);
    ok(`${id}: renders with nothing configured`, b.pane().textContent.trim().length > 10);
    ok(`${id}: throws nothing when empty`, b.errors.length === before,
      b.errors.slice(before).join(" | "));
    ok(`${id}: prints no undefined when empty`, !/undefined/.test(b.pane().textContent));
  }
  ok("the chip falls back to no profile",
    /no profile/.test(b.d.getElementById("ccChip").textContent));
  b.dom.window.close();
}

/* ── 4. a profile that would not parse ──────────────────────────────────── */
/* `capabilities` is null for these - the host says so in the DTO - and every
   card that reads a capability has to cope. This is the exact shape a user
   with one bad YAML file sees. */
{
  const b = boot();
  sync(b, {
    profiles: [
      profile({ id: "broken", status: "error", error: "Missing required field(s): baseUrl, model",
        capabilities: null, active: false, baseUrl: "", model: "" }),
      profile({ id: "good", active: true }),
    ],
  });
  for (const id of SECTIONS) {
    const before = b.errors.length;
    b.click(`[data-section="${id}"]`);
    ok(`${id}: survives a profile with null capabilities`, b.errors.length === before,
      b.errors.slice(before).join(" | "));
    ok(`${id}: prints no undefined for it`, !/undefined/.test(b.pane().textContent));
  }
  b.click('[data-section="endpoints"]');
  ok("the parse error is shown to the user",
    /Missing required field/.test(b.pane().textContent));
  ok("and the strip badge counts it",
    /1!/.test(b.d.querySelector('[data-section="endpoints"]').textContent),
    b.d.querySelector('[data-section="endpoints"]').textContent);
  b.dom.window.close();
}

/* ── 5. nothing a file calls itself becomes markup ──────────────────────── */
/* Every string here arrives from something outside the extension: a YAML file
   in the repo, an MCP server's own name, a log line quoting an error. The
   panel builds its DOM by string concatenation, so this is the one class of
   bug in the file that is a security bug rather than a cosmetic one. */
{
  const XSS = '<img src=x onerror="window.__pwned=1">';
  const b = boot();
  sync(b, {
    profiles: [profile({
      id: XSS, description: XSS, model: XSS, baseUrl: XSS,
      sourceFile: XSS, authSummary: XSS,
      tls: { ca: [XSS], clientCert: XSS, minVersion: XSS, servername: XSS, insecure: false },
      proxy: { url: XSS, fromEnv: false, noProxy: [XSS] },
      headers: { [XSS]: XSS }, transform: XSS,
    })],
    skills: [{ name: XSS, description: XSS, source: "workspace", enabled: true, files: [XSS] }],
    skillWarnings: [XSS],
    checkpoints: [{ hash: "deadbee", label: XSS, when: XSS }],
    logs: [{ t: Date.now(), level: "error", msg: XSS }],
    rungs: [{ name: "DNS", status: "fail", detail: XSS, fix: XSS, ms: 3 }],
    mcp: { servers: [server({ name: XSS, state: "failed", error: XSS, command: XSS, tools: [XSS] })], warnings: [XSS] },
  });

  for (const id of SECTIONS) {
    b.click(`[data-section="${id}"]`);
    ok(`${id}: injects no live element`, b.pane().querySelector("img[onerror]") === null);
  }
  ok("nothing executed", b.w.__pwned === undefined);
  ok("no error was raised by the attempt", b.errors.length === 0, b.errors.join(" | "));
  // The header chip is built from the same untrusted id.
  ok("the chip escapes it too",
    b.d.getElementById("ccChip").querySelector("img") === null);
  b.click('[data-section="logs"]');
  ok("and the hostile string is still shown, as text",
    b.pane().textContent.includes("onerror"), b.pane().textContent.slice(0, 60));
  b.dom.window.close();
}

/* ── 6. the strip is a status display, not decoration ───────────────────── */
{
  const b = boot();
  const badge = (id) => b.d.querySelector(`[data-section="${id}"] .nav-badge`);
  sync(b, {
    profiles: [profile({ id: "a" }), profile({ id: "b", active: false })],
    skills: [
      { name: "one", description: "d", source: "workspace", enabled: true, files: [] },
      { name: "two", description: "d", source: "bundled", enabled: false, files: [] },
    ],
    checkpoints: [{ hash: "h1", label: "l", when: "now" }, { hash: "h2", label: "l", when: "now" }],
    logs: [{ t: 1, level: "error", msg: "bad" }],
    mcp: { servers: [server({ name: "fs", state: "ready", toolCount: 7, tools: ["a"] })], warnings: [] },
  });
  ok("endpoints badge counts profiles", badge("endpoints").textContent === "2",
    badge("endpoints").textContent);
  ok("skills badge counts only the enabled ones", badge("skills").textContent === "1",
    badge("skills").textContent);
  ok("checkpoints badge counts them", badge("checkpoints").textContent === "2",
    badge("checkpoints").textContent);
  // The regression the source comments record by name: this key was missing
  // and the panel rendered the word "undefined" for every user.
  ok("mcp badge shows the tool count when servers are up",
    badge("mcp").textContent === "7", badge("mcp").textContent);
  ok("conn badge names the wire format", badge("conn").textContent === "OAI",
    badge("conn").textContent);

  // A failure has to change the badge, not just a colour nobody reads.
  b.send({ type: "mcpChanged", servers: [
    server({ name: "fs", state: "ready", toolCount: 7, tools: ["a"] }),
    server({ name: "gh", state: "failed", error: "no" }),
  ], warnings: [] });
  ok("a failed server turns the badge into a failure count",
    badge("mcp").textContent === "1!", badge("mcp").textContent);
  ok("and flags it as an alert", badge("mcp").classList.contains("alert"));

  sync(b, { tlsError: { endpoint: "a", subject: "s", issuer: "i", settingKey: "tls.caBundle", message: "bad cert" } });
  ok("a TLS failure overrides the wire format", badge("conn").textContent === "TLS!",
    badge("conn").textContent);
  ok("and is an alert", badge("conn").classList.contains("alert"));
  ok("no server means a dash, not a zero", true);
  b.dom.window.close();
}

/* ── 7. the request shape card ──────────────────────────────────────────── */
/* These three numbers are the ones a person goes looking for when a request is
   rejected for being too large or too long, so each has to be on screen and
   has to be the profile's own figure. */
{
  const b = boot();
  sync(b);
  // The card lives on Endpoints, beside the profile it describes, not on
  // Connection - which is about how the socket is made, not what is sent.
  b.click('[data-section="endpoints"]');
  const text = () => b.pane().textContent;
  ok("context window is shown", /128000/.test(text()));
  ok("max output is shown", /4096/.test(text()));
  ok("image budget is shown in KB", /1465 KB per request/.test(text()),
    (text().match(/Image budget[^A-Z]{0,30}/) || [""])[0]);

  // A text-only profile has no image budget worth showing: it is a limit on
  // something that never happens.
  sync(b, { profiles: [profile({ capabilities: { ...CAPS, vision: false } })] });
  b.click('[data-section="endpoints"]');
  ok("and is withheld when the endpoint cannot see", !/KB per request/.test(text()));
  ok("while the other two stay", /128000/.test(text()) && /4096/.test(text()));
  b.dom.window.close();
}

/* ── 8. it talks back to the host ───────────────────────────────────────── */
{
  const b = boot();
  sync(b);
  ok("the first state with a profile asks for a health sweep",
    b.sent.some((m) => m.type === "healthCheck"), b.sent.map((m) => m.type).join(","));
  const before = b.sent.filter((m) => m.type === "healthCheck").length;
  sync(b);
  ok("and does not ask again on every sync",
    b.sent.filter((m) => m.type === "healthCheck").length === before);

  b.click("#ccReload");
  ok("the reload button posts", b.sent.some((m) => m.type === "reloadProfiles"),
    b.sent.map((m) => m.type).join(","));
  b.dom.window.close();
}

/* ── 9. a section survives its own live updates ─────────────────────────── */
/* The panel re-renders on six different host messages. Each one replaces a
   slice of the store, and a renderer reading a slice that a *different*
   message just emptied is the shape of crash that only happens in use. */
{
  const b = boot();
  sync(b);
  const before = b.errors.length;
  b.click('[data-section="mcp"]');
  b.send({ type: "mcpChanged", servers: [], warnings: [] });
  b.send({ type: "healthStarted", ids: ["gateway"] });
  b.send({ type: "healthResult", id: "gateway", ok: true, ms: 42, detail: "" });
  b.send({ type: "capsDetected", results: [{ name: "vision", supported: true, ms: 10, detail: "" }], patch: {} });
  b.send({ type: "profilesReloaded", profiles: [] });
  b.send({ type: "skillsReloaded", skills: [], warnings: [] });
  b.send({ type: "configChanged", config: state().config });
  ok("six live updates in a row throw nothing", b.errors.length === before,
    b.errors.slice(before).join(" | "));
  ok("and the panel is still showing a section", b.pane().textContent.trim().length > 10);
  // Unknown messages are the ones a newer host sends to an older webview.
  b.send({ type: "somethingFromTheFuture", payload: 1 });
  b.send({});
  b.send(null);
  ok("an unknown message is ignored rather than fatal", b.errors.length === before,
    b.errors.slice(before).join(" | "));
  b.dom.window.close();
}

/* A PARTIAL capabilities object, which is the common case rather than the
   exotic one: a profile may declare a context window and say nothing about
   max output. Guarding only the container (`a.capabilities ? ... : "-"`) let
   the literal string "undefined" reach the card, which is what the panel
   actually showed. */
{
  const b = boot();
  sync(b, { profiles: [profile({ capabilities: { contextWindow: 200000 } })] });
  for (const id of SECTIONS) {
    b.click(`[data-section="${id}"]`);
    ok(`${id}: prints no undefined for partial capabilities`,
      !/undefined/.test(b.pane().textContent));
  }
  b.click('[data-section="endpoints"]');
  ok("an undeclared capability reads as a dash",
    /Max output[\s\S]{0,40}-/.test(b.pane().textContent));
  // jsdom is booted with pretendToBeVisual, which starts a requestAnimationFrame
  // loop. Leaving the window open holds the event loop and the whole suite hangs
  // AFTER printing its summary - every other block here closes for this reason.
  b.dom.window.close();
}

/* The same gap, one field further out: a profile that declares no TIMEOUT and
   no RETRIES.
   Both are optional in src/endpoints/profile.ts, so this is what most profiles
   look like - and the fixture above supplies them, which is the only reason
   the `prints no undefined` loop had never seen the Request-shape card without
   them. The assertion was already right; it had simply never been handed this
   input. Guarding the four rows below Timeout and leaving those two bare let
   "Timeout: undefined ms" reach the card. */
{
  const b = boot();
  sync(b, { profiles: [profile({ timeoutMs: undefined, retries: undefined })] });
  for (const id of SECTIONS) {
    b.click(`[data-section="${id}"]`);
    ok(`${id}: prints no undefined without a timeout or retries`,
      !/undefined/.test(b.pane().textContent));
  }
  b.click('[data-section="endpoints"]');
  const text = b.pane().textContent;
  ok("an unset timeout reads as a dash", /Timeout[\s\S]{0,40}-/.test(text));
  ok("and so does an unset retry count", /Retries[\s\S]{0,40}-/.test(text));
  // As above: jsdom's rAF loop holds the event loop open if the window is not
  // closed, and the suite hangs after printing its summary.
  b.dom.window.close();
}

if (failures.length) {
  for (const f of failures) console.log("FAIL  " + f);
}
console.log(`\n──── ${pass} passed, ${failures.length} failed ────`);
process.exitCode = failures.length ? 1 : 0;
