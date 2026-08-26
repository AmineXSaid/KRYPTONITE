/**
 * The two surfaces the model kind actually shows up on: the picker row and
 * the endpoint form.
 *
 * Driven in jsdom against the real sidebar.js, because what is being asserted
 * is behaviour rather than markup - that exactly one row claims to be the
 * selection, that the badge says the endpoint's kind and not a guess, and that
 * Save refuses without one while KEEPING what was typed. That last one is the
 * point of validating in the panel at all: the host also refuses, but a thrown
 * save closes the form and loses the work.
 *
 * Run: node test/llm-kind-ui.cjs
 */
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`PASS  ${label}${detail ? "  — " + detail : ""}`); return; }
  failures.push(label + (detail ? "  — " + detail : ""));
  console.log(`FAIL  ${label}${detail ? "  — " + detail : ""}`);
}

const ROOT = path.join(__dirname, "..");
const CRYSTAL = fs.readFileSync(path.join(ROOT, "media/webview/crystal.js"), "utf8");
const SRC = fs.readFileSync(path.join(ROOT, "media/webview/sidebar.js"), "utf8");
const CSS = fs.readFileSync(path.join(ROOT, "media/webview/sidebar.css"), "utf8");

function boot() {
  const dom = new JSDOM(`<!doctype html><html><body><div id="root"></div></body></html>`, {
    runScripts: "outside-only", pretendToBeVisual: true,
  });
  const w = dom.window;
  if (!w.TextEncoder) w.TextEncoder = TextEncoder;
  const sent = [];
  w.__kx = { api: { postMessage: (m) => sent.push(m), getState: () => null, setState: () => {} } };
  w.eval(CRYSTAL);
  w.eval(SRC);
  return { w, d: w.document, sent };
}

const PROFILE = (id, kind, model, active) => ({
  id, description: id, wire: "openai", kind, model,
  baseUrl: "https://gw.example/v1", chatPath: null, status: "ready", sourceFile: null,
  active, authKind: "bearer", authSummary: "${secret:" + id + "/api_key}", authCache: null,
  tls: { ca: [], clientCert: null, minVersion: null, servername: null, insecure: false },
  proxy: { url: null, fromEnv: true, noProxy: [] },
  capabilities: { contextWindow: 128000 }, headers: {}, query: {}, extraBody: {},
  timeoutMs: 120000, retries: 2, transform: null, http2: false,
});

const STATE = (over = {}) => ({ type: "stateSync", state: {
  workspace: { open: true, name: "repo" }, running: false, phase: "act",
  status: { state: "ok", label: "OK · ACT" }, endpoint: "gw",
  profiles: [
    PROFILE("gw", "chat", "gpt-4o", true),
    PROFILE("think", "reasoning", "o4-xl", false),
    PROFILE("eyes", "multimodal", "vl-72b", false),
  ],
  skills: [], skillWarnings: [], agents: [], agentWarnings: [], activeAgent: "",
  config: { approvalMode: "ask", activeProfile: "", caBundlePath: "", ui: {} },
  tlsError: null, rungs: [], tracing: false, todos: [], checkpoints: [], sessions: [],
  selection: null, context: null, changes: [],
  models: [
    { group: "gw", kind: "chat", models: ["gpt-4o"] },
    { group: "think", kind: "reasoning", models: ["o4-xl"] },
    { group: "eyes", kind: "multimodal", models: ["vl-72b"] },
  ],
  logs: [], session: { id: "s1", title: "New chat", messages: [] },
  mcp: { servers: [], warnings: [] },
  ...over,
} });

/* ── the picker ────────────────────────────────────────────────────────── */
console.log("\n──── the model picker says what each endpoint serves ────");
{
  const { w, d } = boot();
  w.dispatchEvent(new w.MessageEvent("message", { data: STATE() }));
  d.getElementById("modelBtn").click();

  const rows = [...d.querySelectorAll("#qp .qp-row.mdl")];
  ok("every model row uses the listbox row shape", rows.length >= 4, `${rows.length} rows`);
  ok("the popup declares which picker it is",
    d.getElementById("qp").getAttribute("data-mode") === "model");

  // The kind is a GROUP HEADER, not a per-row tag. Endpoint was the obvious
  // grouping and the wrong one: with one model per profile it put a header
  // above every single row. What is being chosen between here is capability,
  // so that is what the headers say.
  const heads = [...d.querySelectorAll("#qp .qp-group[data-kind]")].map((e) => e.textContent);
  ok("the list is split by kind", heads.length === 3, heads.join(" | "));
  ok("and the headers name the kinds",
    heads.join(",") === "Chat,Reasoning,Multimodal", heads.join(","));
  ok("in a fixed order, not whatever order the profiles loaded in",
    heads.indexOf("Chat") < heads.indexOf("Reasoning"), heads.join(","));
  ok("each header is hue-coded",
    [...d.querySelectorAll("#qp .qp-group[data-kind]")].every((e) => /color:/.test(e.getAttribute("style") || "")));
  // The endpoint moves onto the row, which is what distinguishes two models of
  // the same kind.
  const notes = [...d.querySelectorAll("#qp .mdl-note")].map((e) => e.textContent);
  ok("each row names the endpoint that serves it",
    notes.includes("gw") && notes.includes("think") && notes.includes("eyes"),
    notes.join(" | "));
  ok("and how much context it has",
    [...d.querySelectorAll("#qp .mdl-ctx")].map((e) => e.textContent).includes("128K"),
    [...d.querySelectorAll("#qp .mdl-ctx")].map((e) => e.textContent).join(" | "));

  // The bug this pins: `data-active` is the keyboard cursor and `data-on` is
  // the endpoint in force. Binding the dot to the cursor lit two rows at once.
  const on = rows.filter((r) => r.getAttribute("data-on") === "1");
  ok("exactly one row claims to be the selection", on.length === 1,
    on.map((r) => r.textContent.trim().slice(0, 24)).join(" / "));
  ok("and with nothing pinned it is Auto", on[0] && /Auto/.test(on[0].textContent));
  ok("Auto names the endpoint it resolved to",
    on[0] && /Following gw/.test(on[0].textContent), on[0] && on[0].textContent.trim());
}
{
  // Pinning moves the selection off Auto and onto exactly one model row.
  const { w, d } = boot();
  w.dispatchEvent(new w.MessageEvent("message", { data: STATE({
    config: { approvalMode: "ask", activeProfile: "think", caBundlePath: "", ui: {} },
  }) }));
  d.getElementById("modelBtn").click();
  const on = [...d.querySelectorAll("#qp .qp-row.mdl[data-on='1']")];
  ok("pinning an endpoint moves the selection to it", on.length === 1,
    on.map((r) => r.textContent.trim().slice(0, 30)).join(" / "));
  ok("and it is the pinned one", on[0] && /o4-xl/.test(on[0].textContent));
}
{
  // A gateway whose kind this build has never heard of must not throw.
  const { w, d } = boot();
  w.dispatchEvent(new w.MessageEvent("message", { data: STATE({
    models: [{ group: "gw", kind: "telepathy", models: ["gpt-4o"] }],
    profiles: [PROFILE("gw", "telepathy", "gpt-4o", true)],
  }) }));
  d.getElementById("modelBtn").click();
  // It must land in a bucket rather than vanishing: bucketing walks the known
  // kinds, so an unrecognised one has to resolve through llmKind() to chat.
  const head = d.querySelector("#qp .qp-group[data-kind]");
  ok("an unknown kind falls back rather than vanishing", Boolean(head), head && head.textContent);
  ok("and its row is still offered", d.querySelectorAll("#qp .qp-row.mdl").length >= 1);
}

/* ── the form ──────────────────────────────────────────────────────────── */
console.log("\n──── the endpoint form makes the kind mandatory ────");
{
  const { w, d, sent } = boot();
  w.dispatchEvent(new w.MessageEvent("message", { data: STATE() }));
  d.getElementById("tabDiag").click();
  const head = d.querySelector('[data-sec="secEp"]');
  if (d.getElementById("secEp").getAttribute("data-open") !== "1") head.click();
  d.querySelector('[data-ep="add"]').click();

  const sel = d.getElementById("fKind");
  ok("the form has a model-type control", Boolean(sel));
  ok("it is marked required for assistive tech", sel.getAttribute("aria-required") === "true");
  ok("a new form starts with nothing chosen", sel.value === "" &&
    sel.getAttribute("data-empty") === "1");
  ok("the label carries a required marker",
    Boolean(d.querySelector('label[for="fKind"] .req')));
  ok("every kind is offerable", sel.querySelectorAll("option[value]:not([value=''])").length === 5,
    `${sel.querySelectorAll("option[value]:not([value=''])").length} options`);

  // Save with no kind: refused, and - the part that matters - the form is
  // still there with what was typed still in it.
  d.getElementById("fId").value = "corp-gw";
  d.getElementById("fUrl").value = "https://corp.example/v1";
  const before = sent.length;
  d.querySelector('[data-ep="save"]').click();
  ok("saving with no kind sends nothing to the host", sent.length === before,
    JSON.stringify(sent.slice(before)));
  ok("the form stays open", Boolean(d.getElementById("fKind")));
  ok("and keeps what was typed", d.getElementById("fId").value === "corp-gw",
    d.getElementById("fId").value);
  const hint = d.getElementById("fKindHint");
  ok("the hint says what is wrong", /Choose what kind/.test(hint.textContent), hint.textContent);
  ok("and is flagged as an error", hint.getAttribute("data-err") === "1");

  // Choosing one explains what it will do, then saves.
  const s2 = d.getElementById("fKind");
  s2.value = "completion";
  s2.dispatchEvent(new w.Event("change", { bubbles: true }));
  const h2 = d.getElementById("fKindHint");
  ok("choosing a kind clears the error", h2.getAttribute("data-err") === null);
  ok("and says what it will do to the profile",
    /tools OFF/i.test(h2.textContent), h2.textContent);

  d.querySelector('[data-ep="save"]').click();
  const saved = sent.filter((m) => m.type === "saveEndpoint");
  ok("saving with a kind reaches the host", saved.length === 1);
  ok("and carries the kind", saved[0] && saved[0].endpoint.kind === "completion",
    saved[0] && saved[0].endpoint.kind);
}
{
  // Editing an existing profile arrives with its kind already answered.
  const { w, d } = boot();
  w.dispatchEvent(new w.MessageEvent("message", { data: STATE() }));
  d.getElementById("tabDiag").click();
  const head = d.querySelector('[data-sec="secEp"]');
  if (d.getElementById("secEp").getAttribute("data-open") !== "1") head.click();
  d.querySelector('[data-ep="edit"][data-id="eyes"]').click();
  const sel = d.getElementById("fKind");
  ok("editing pre-fills the profile's own kind", sel.value === "multimodal", sel.value);
  ok("and does not read as unanswered", sel.getAttribute("data-empty") === "0");
}

/* ── the endpoint list ─────────────────────────────────────────────────── */
console.log("\n──── the endpoints list carries it too ────");
{
  const { w, d } = boot();
  const broken = {
    id: "bad.yaml", description: "", wire: "openai", kind: "chat", model: "-",
    baseUrl: "-", chatPath: null, status: "error", error: "Missing required field(s): model",
    sourceFile: null, active: false, authKind: "none", authSummary: "None", authCache: null,
    tls: { ca: [], clientCert: null, minVersion: null, servername: null, insecure: false },
    proxy: { url: null, fromEnv: true, noProxy: [] }, capabilities: null,
    headers: {}, query: {}, extraBody: {}, timeoutMs: 0, retries: 0, transform: null, http2: false,
  };
  w.dispatchEvent(new w.MessageEvent("message", { data: STATE({
    profiles: [
      PROFILE("gw", "chat", "gpt-4o", true),
      PROFILE("eyes", "multimodal", "vl-72b", false),
      broken,
    ],
  }) }));
  d.getElementById("tabDiag").click();
  if (d.getElementById("secEp").getAttribute("data-open") !== "1") {
    d.querySelector('[data-sec="secEp"]').click();
  }
  const tags = [...d.querySelectorAll("#epBody .ep-kind")].map((e) => e.textContent);
  ok("a managed endpoint shows what kind it is",
    tags.includes("Chat") && tags.includes("Multimodal"), tags.join(" | "));
  // A profile that failed to parse has no kind to report, and the DTO's
  // placeholder must not be rendered as though it did.
  ok("a profile that failed to parse claims no kind", tags.length === 2, tags.join(" | "));
  ok("and still shows why it failed",
    /Missing required field/.test(d.querySelector('#epBody [data-status="error"]').textContent));
}

/* ── the stylesheet ────────────────────────────────────────────────────── */
console.log("\n──── the listbox is styled, not just marked up ────");
{
  const needed = [
    ".qp-row.mdl", ".mdl-dot", ".mdl-col", ".mdl-id", ".mdl-note", ".mdl-ctx",
    '.qp[data-mode="model"]',
  ];
  const missing = needed.filter((s) => !CSS.includes(s));
  ok("every class the rows use has a rule", missing.length === 0, missing.join(", "));
  // The two states are different things and must not collapse into one rule.
  ok("the selection lights the dot", CSS.includes('.qp-row.mdl[data-on="1"] .mdl-dot'));
  ok("the keyboard cursor moves the background",
    CSS.includes('.qp-row.mdl[data-active="1"] { background'));
}

console.log(`\n──── ${pass} passed, ${failures.length} failed ────`);
if (failures.length) { for (const f of failures) console.log("  FAIL " + f); process.exit(1); }

process.exit(0);
