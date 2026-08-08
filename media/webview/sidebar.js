/* KRYPTONITE sidebar frontend. Plain DOM, zero dependencies.
 *
 * The store mirrors what the host sends; nothing here is authoritative. The
 * transcript is append-only — a full re-render on every stream delta would
 * discard scroll position and expanded tool cards — while the diagnostics
 * panes re-render wholesale because they are small and always coherent.
 *
 * crystal.js must have run first — see the same guard in controlCenter.js.
 */
(function _boot() {
  if (!window.__kxCrystal) { setTimeout(_boot, 5); return; }
  _sbRun();
})();
function _sbRun() {
(function () {
  "use strict";

  var api = window.__kx.api;

  /* ─────────────────────────── constants ─────────────────────────── */

  /* The crystal artwork lives in crystal.js so both surfaces share one copy. */
  var CRYSTAL_DEFS = window.__kxCrystal.defs;

  var S6 = 'stroke="currentColor" fill="none"';
  var ICON_DEFS =
    '<symbol id="i-plus" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" ' + S6 + ' stroke-width="1.7"/></symbol>' +
    '<symbol id="i-clock" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" ' + S6 + ' stroke-width="1.6"/><path d="M12 8v4.4l3 1.7" ' + S6 + ' stroke-width="1.6"/></symbol>' +
    '<symbol id="i-dots" viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.5" fill="currentColor"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/><circle cx="19" cy="12" r="1.5" fill="currentColor"/></symbol>' +
    '<symbol id="i-chev" viewBox="0 0 10 10"><path d="M2.5 0.5L7 5l-4.5 4.5" ' + S6 + ' stroke-width="1.4"/></symbol>' +
    '<symbol id="i-caret" viewBox="0 0 10 10"><path d="M1 3l4 4.5L9 3" ' + S6 + ' stroke-width="1.3"/></symbol>' +
    '<symbol id="i-file" viewBox="0 0 24 24"><path d="M6 3h7l5 5v13H6z" ' + S6 + ' stroke-width="1.5"/><path d="M13 3v5h5" ' + S6 + ' stroke-width="1.5"/></symbol>' +
    '<symbol id="i-term" viewBox="0 0 24 24"><rect x="3" y="4.5" width="18" height="15" rx="2" ' + S6 + ' stroke-width="1.5"/><path d="M7 10l3 2.5L7 15M12.5 15.5h4.5" ' + S6 + ' stroke-width="1.5"/></symbol>' +
    '<symbol id="i-search" viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5" ' + S6 + ' stroke-width="1.6"/><path d="M16 16l4.5 4.5" ' + S6 + ' stroke-width="1.6"/></symbol>' +
    '<symbol id="i-book" viewBox="0 0 24 24"><path d="M4 5.5c3-1.2 5.5-1.2 8 .5v13c-2.5-1.7-5-1.7-8-.5zM20 5.5c-3-1.2-5.5-1.2-8 .5v13c2.5-1.7 5-1.7 8-.5z" ' + S6 + ' stroke-width="1.5"/></symbol>' +
    '<symbol id="i-check" viewBox="0 0 24 24"><path d="M4.5 12.5l5 5 10-11" ' + S6 + ' stroke-width="2"/></symbol>' +
    '<symbol id="i-x" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" ' + S6 + ' stroke-width="2"/></symbol>' +
    '<symbol id="i-warn" viewBox="0 0 24 24"><path d="M12 3l9.5 17H2.5z" ' + S6 + ' stroke-width="1.5"/><path d="M12 9.5v5M12 17v.5" ' + S6 + ' stroke-width="1.6"/></symbol>' +
    '<symbol id="i-clip" viewBox="0 0 24 24"><path d="M17.5 10.5l-6.8 6.8a3 3 0 01-4.2-4.2l7.5-7.5a4.5 4.5 0 016.4 6.4l-7.5 7.5" ' + S6 + ' stroke-width="1.5"/></symbol>' +
    '<symbol id="i-up" viewBox="0 0 24 24"><path d="M12 19V5M6 11l6-6 6 6" ' + S6 + ' stroke-width="1.7"/></symbol>' +
    '<symbol id="i-stop" viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor"/></symbol>' +
    '<symbol id="i-globe" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5" ' + S6 + ' stroke-width="1.5"/><path d="M3.5 12h17M12 3.5c-4.5 5-4.5 12 0 17 4.5-5 4.5-12 0-17z" ' + S6 + ' stroke-width="1.4"/></symbol>' +
    '<symbol id="i-monitor" viewBox="0 0 24 24"><rect x="3" y="4.5" width="18" height="12" rx="1.5" ' + S6 + ' stroke-width="1.5"/><path d="M9 20h6M12 16.5V20" ' + S6 + ' stroke-width="1.5"/></symbol>' +
    '<symbol id="i-pencil" viewBox="0 0 24 24"><path d="M16.5 3.8l3.7 3.7L8.4 19.3l-4.7.9.9-4.7z" ' + S6 + ' stroke-width="1.5"/></symbol>' +
    '<symbol id="i-trash" viewBox="0 0 24 24"><path d="M4 6.5h16M9.5 6.5V4h5v2.5M6.5 6.5l1 14h9l1-14" ' + S6 + ' stroke-width="1.5"/></symbol>' +
    '<symbol id="i-copy" viewBox="0 0 24 24"><rect x="8.5" y="8.5" width="12" height="12" rx="1.5" ' + S6 + ' stroke-width="1.5"/><path d="M15.5 8.5v-3a1.5 1.5 0 00-1.5-1.5H5a1.5 1.5 0 00-1.5 1.5v9A1.5 1.5 0 005 16h3" ' + S6 + ' stroke-width="1.5"/></symbol>' +
    '<symbol id="i-refresh" viewBox="0 0 24 24"><path d="M20 12a8 8 0 11-2.4-5.7M20 3.5V9h-5.5" ' + S6 + ' stroke-width="1.6"/></symbol>' +
    '<symbol id="i-folder" viewBox="0 0 24 24"><path d="M3 6h6l2 3h10v10H3z" ' + S6 + ' stroke-width="1.5"/></symbol>';

  /* Ladder rung name -> the short label the design shows. */
  var RUNG_LABELS = {
    "Certificates and keys": "Config", "Profile": "Config", "DNS": "DNS", "TCP": "TCP",
    "TLS handshake": "TLS", "Authentication": "Auth", "Completion": "HTTP",
    "Streaming": "Stream", "Tool calling": "Tools"
  };

  var TOOL_ICON = {
    read_file: "i-file", write_file: "i-file", edit_file: "i-file", list_files: "i-folder",
    search: "i-search", run_command: "i-term", read_skill: "i-book", update_todos: "i-check"
  };
  var TOOL_VERB = {
    read_file: "Read", write_file: "Write", edit_file: "Edit", list_files: "List",
    search: "Search", run_command: "Bash", read_skill: "Skill", update_todos: "Todos"
  };
  var GERUND = {
    read_file: "Reading…", list_files: "Listing…", search: "Searching…", read_skill: "Loading skill…",
    write_file: "Editing…", edit_file: "Editing…", run_command: "Running…", update_todos: "Updating todos…"
  };

  var CMDS = [
    ["/clear", "Clear conversation history"],
    ["/doctor", "Run TLS connection diagnostics"],
    ["/endpoints", "Manage endpoint profiles"],
    ["/model", "Select a model"],
    ["/review", "Review current changes"],
    ["/skill:", "Insert a skill into this turn"],
    ["/checkpoint", "Restore a previous checkpoint"],
    ["/help", "Show available commands"]
  ];

  var REVIEW_PROMPT =
    "Review the changes currently in the workspace. Read the modified files, " +
    "summarise what changed, and flag anything risky or inconsistent.";

  var EP_ICON = {
    anthropic: "i-kx", "openai-compatible": "i-globe", azure: "i-globe",
    local: "i-monitor", custom: "i-globe", raw: "i-globe", openai: "i-globe"
  };

  var INLINE_LIMIT = 100000;    /* chars rendered before the Show-more expander */
  var MODEL_TRUNCATION = 60000; /* what loop.ts hands the model                */
  var MAX_DIFF_ROWS = 600;

  /* ───────────────────────────── store ───────────────────────────── */

  var S = {
    hydrated: false,
    workspace: { open: false, name: null },
    running: false,
    phase: "act",
    endpoint: null,
    profiles: [],
    skills: [],
    skillWarnings: [],
    config: { approvalMode: "ask", activeProfile: "", caBundlePath: "", ui: {} },
    tlsError: null,
    rungs: [],
    tracing: false,
    traceRun: false,
    todos: [],
    sessions: [],
    selection: null,
    context: null,
    models: [],
    /* local-only */
    tab: "session",
    qp: null,
    qpIndex: 0,
    modelOpen: false,
    epForm: null,
    caUpload: null,
    files: [],
    fileQuery: "",
    copied: false,
    reloaded: false,
    gerund: "Thinking…",
    elapsed: 0,
    timer: null,
    searchTimer: null,
    attachments: [],
    sessionId: null
  };

  /* transcript element handles */
  var logEl, aiEl = null, streamEl = null, pendingTool = null, todoEl = null;

  /* ───────────────────────────── helpers ───────────────────────────── */

  function post(type, payload) {
    var m = payload || {};
    m.type = type;
    api.postMessage(m);
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  function icon(id, cls) {
    return '<svg class="ic ' + (cls || "") + '" aria-hidden="true"><use href="#' + id + '"/></svg>';
  }
  /* Height-driven: the mark is portrait (42:48) and a width/height pair at a
     call site is how aspect-ratio bugs get in. */
  function crystal(h, cls) { return window.__kxCrystal.svg(h, cls); }
  function $(id) { return document.getElementById(id); }
  function div(cls, html) {
    var d = document.createElement("div");
    d.className = cls;
    if (html != null) d.innerHTML = html;
    return d;
  }
  function fmtK(n) {
    if (!n) return "0";
    return n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n);
  }
  function readyProfiles() {
    return S.profiles.filter(function (p) { return p.status === "ready"; });
  }
  function hasEndpoint() { return readyProfiles().length > 0; }
  function activeProfile() {
    var ready = readyProfiles();
    for (var i = 0; i < ready.length; i++) if (ready[i].active) return ready[i];
    return ready[0] || null;
  }

  /* Markdown-lite: fenced code, paragraphs, inline code, bold. */
  function md(t) {
    var parts = String(t).split("```");
    var out = "";
    for (var i = 0; i < parts.length; i++) {
      if (i % 2) {
        out += "<pre>" + esc(parts[i].replace(/^[a-z]*\n/i, "")) + "</pre>";
        continue;
      }
      var blocks = parts[i].split(/\n{2,}/);
      for (var j = 0; j < blocks.length; j++) {
        if (!blocks[j].trim()) continue;
        out += "<p>" + esc(blocks[j])
          .replace(/`([^`]+)`/g, "<code>$1</code>")
          .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
          .replace(/\n/g, "<br>") + "</p>";
      }
    }
    return out;
  }

  function argOf(name, a) {
    if (!a || typeof a !== "object") return "";
    if (name === "run_command") return a.command || "";
    if (name === "search") return a.pattern || "";
    if (name === "read_skill") return a.name || "";
    if (name === "update_todos") return Array.isArray(a.todos) ? a.todos.length + " items" : "";
    return a.path || "";
  }

  /* ─────────────────────────── shell ─────────────────────────── */

  function mount() {
    var root = $("root");
    root.innerHTML =
      '<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>' +
      CRYSTAL_DEFS + ICON_DEFS + '</defs></svg>' +
      '<div id="app">' +
        '<header class="kx-header">' +
          crystal(24) +
          '<span class="kx-wordmark">Kryptonite</span><span class="sp"></span>' +
          '<button class="icon-btn" id="newBtn" title="New chat" aria-label="New chat">' + icon("i-plus") + '</button>' +
          '<button class="icon-btn" id="histBtn" title="History" aria-label="Chat history" aria-haspopup="menu" aria-expanded="false">' + icon("i-clock") + '</button>' +
          '<button class="icon-btn" id="moreBtn" title="More" aria-label="More actions" aria-haspopup="menu" aria-expanded="false">' + icon("i-dots") + '</button>' +
          '<div class="popover" id="historyPop" role="menu" hidden></div>' +
          '<div class="popover" id="morePop" role="menu" hidden>' +
            '<button class="pop-row" role="menuitem" data-more="control">' + crystal(15) + '<span class="t">Control Center</span></button>' +
            '<div class="pop-div"></div>' +
            '<button class="pop-row" role="menuitem" data-more="settings"><span class="t">Settings…</span></button>' +
            '<button class="pop-row" role="menuitem" data-more="docs"><span class="t">Documentation</span></button>' +
            '<button class="pop-row" role="menuitem" data-more="issue"><span class="t">Report Issue</span></button>' +
          '</div>' +
        '</header>' +
        '<nav class="kx-tabs" role="tablist">' +
          '<button class="kx-tab" id="tabSession" role="tab" aria-selected="true" aria-controls="viewSession">Session</button>' +
          '<button class="kx-tab" id="tabDiag" role="tab" aria-selected="false" aria-controls="viewDiag">Diagnostics<span class="err-dot" id="tabDot" hidden></span></button>' +
        '</nav>' +
        '<div class="plan-banner" id="planBanner" hidden>' +
          '<span class="dot"></span><span class="lbl">Plan phase</span>' +
          '<span class="sub">read-only tools · no edits applied</span>' +
        '</div>' +
        '<section class="view" id="viewSession" role="tabpanel" aria-labelledby="tabSession">' +
          '<div id="log" aria-live="polite"></div>' +
          '<div class="composer-wrap">' +
            '<div class="qp" id="qp" role="listbox" hidden></div>' +
            '<div class="composer">' +
              '<div class="sel-pill" id="selPill" hidden>' + icon("i-file", "ic-13") +
                '<span id="selText"></span><span class="sp"></span>' +
                '<button class="tb-btn" id="selClear" title="Dismiss selection" aria-label="Dismiss selection" style="width:18px;height:18px">' + icon("i-x", "ic-9") + '</button>' +
              '</div>' +
              '<div class="att-strip" id="attachStrip" hidden></div>' +
              '<textarea id="draft" rows="1" aria-label="Message" placeholder="Ask Kryptonite anything…   ( / commands · @ files )"></textarea>' +
              '<div class="toolbar">' +
                '<div class="seg" id="phaseSeg" role="group" aria-label="Phase">' +
                  '<button data-phase="plan" data-on="0">Plan</button>' +
                  '<button data-phase="act" data-on="1">Act</button>' +
                '</div>' +
                '<span class="hint" title="Shift+Tab to switch phase">&#8679;&#8677;</span>' +
                '<button id="modelBtn" aria-haspopup="listbox" aria-expanded="false">' +
                  '<span class="nm ell" id="modelName">No model</span>' + icon("i-caret", "ic-9") +
                '</button>' +
                '<span class="sp"></span>' +
                '<button class="tb-btn" id="atBtn" title="Reference a file" aria-label="Reference a file">@</button>' +
                '<button class="tb-btn" id="clipBtn" title="Attach files" aria-label="Attach files">' + icon("i-clip", "ic-13") + '</button>' +
                '<button id="sendBtn" data-ready="0" data-mode="send" title="Send" aria-label="Send">' + icon("i-up", "ic-13") + '</button>' +
              '</div>' +
            '</div>' +
            '<div class="footer">' +
              '<span id="ctxText" class="tnum">0 / 0</span>' +
              '<span id="ctxBar"><i id="ctxFill"></i></span><span>·</span>' +
              '<span class="ep" id="epInd" data-err="0"><span class="dot"></span><span class="nm ell" id="epName">No endpoint</span></span>' +
            '</div>' +
          '</div>' +
        '</section>' +
        '<section class="view" id="viewDiag" role="tabpanel" aria-labelledby="tabDiag" hidden>' +
          '<button class="cc-card" id="ccBtn">' + crystal(19) +
            '<span class="col"><span class="t">Control Center</span>' +
            '<span class="s ell">Profiles, wire formats, auth, mTLS, proxy, agent loop, checkpoints</span></span>' +
            icon("i-chev", "ic-9") + '</button>' +
          sectionShell("secTls", "TLS diagnostics", "tlsBadge", "tlsBody", true) +
          sectionShell("secEp", "Endpoints", "epBadge", "epBody", false) +
          sectionShell("secSk", "Skills", "skBadge", "skBody", false) +
        '</section>' +
      '</div>';
    logEl = $("log");
  }

  function sectionShell(secId, label, badgeId, bodyId, open) {
    return '<div class="sec" id="' + secId + '" data-open="' + (open ? 1 : 0) + '">' +
      '<button class="sec-head" data-sec="' + secId + '" aria-expanded="' + open + '">' +
      icon("i-chev", "ic-9 chev") + '<span class="lbl">' + label + '</span><span class="sp"></span>' +
      '<span class="badge" id="' + badgeId + '">—</span></button>' +
      '<div class="sec-body" id="' + bodyId + '"' + (open ? "" : " hidden") + '></div></div>';
  }

  /* ─────────────────────────── popovers ─────────────────────────── */

  function closePops() {
    $("historyPop").hidden = true;
    $("morePop").hidden = true;
    $("histBtn").setAttribute("aria-expanded", "false");
    $("moreBtn").setAttribute("aria-expanded", "false");
  }

  /* Each row is one stored conversation. The message count and the active dot
     are there so it is obvious that a session holds a transcript rather than a
     single message — the old list showed only a title and a timestamp, which
     read identically whether a session had one message or forty. */
  function renderHistory() {
    var html = "";
    for (var i = 0; i < S.sessions.length; i++) {
      var s = S.sessions[i];
      var on = s.active ? "1" : "0";
      var n = s.count === 1 ? "1 message" : (s.count || 0) + " messages";
      html += '<div class="hist-row" data-on="' + on + '">' +
        '<button class="pop-row" role="menuitem" data-session="' + esc(s.id) + '">' +
          '<span class="hist-dot"></span>' +
          '<span class="ell"><span class="t ell">' + esc(s.title) + '</span>' +
          '<span class="m">' + esc(s.when) + ' · ' + n + '</span></span>' +
        '</button>' +
        '<button class="hist-del" data-del="' + esc(s.id) + '" title="Delete session" ' +
          'aria-label="Delete session">' + icon("i-trash", "ic-13") + '</button>' +
        '</div>';
    }
    $("historyPop").innerHTML = html ||
      '<div class="pop-row"><span class="m">No previous sessions</span></div>';
  }

  /* ─────────────────────────── tabs ─────────────────────────── */

  function setTab(tab) {
    S.tab = tab;
    var session = tab === "session";
    $("tabSession").setAttribute("aria-selected", session ? "true" : "false");
    $("tabDiag").setAttribute("aria-selected", session ? "false" : "true");
    $("viewSession").hidden = !session;
    $("viewDiag").hidden = session;
  }

  function openSection(secId) {
    var sec = $(secId);
    sec.setAttribute("data-open", "1");
    sec.querySelector(".sec-head").setAttribute("aria-expanded", "true");
    sec.querySelector(".sec-body").hidden = false;
  }

  /* ─────────────────────────── phase ─────────────────────────── */

  function applyPhase(phase, silent) {
    S.phase = phase;
    var segs = $("phaseSeg").querySelectorAll("[data-phase]");
    for (var i = 0; i < segs.length; i++) {
      segs[i].setAttribute("data-on", segs[i].getAttribute("data-phase") === phase ? "1" : "0");
    }
    $("planBanner").hidden = phase !== "plan";
    syncComposer();
    if (!silent) post("setPhase", { phase: phase });
  }

  /* ─────────────────────── transcript primitives ─────────────────────── */

  function atBottom() {
    return logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 40;
  }
  function scroll() { logEl.scrollTop = logEl.scrollHeight; }
  function add(el) {
    var stick = atBottom();
    var welcome = logEl.querySelector(".welcome");
    if (welcome) welcome.remove();
    logEl.appendChild(el);
    if (stick) scroll();
    return el;
  }
  function clearTranscript() {
    logEl.innerHTML = "";
    aiEl = null; streamEl = null; pendingTool = null; todoEl = null;
  }

  function renderWelcome() {
    clearTranscript();
    if (!S.workspace.open) {
      logEl.appendChild(div("welcome",
        crystal(46, "crystal") +
        "<h2>Open a folder to use Kryptonite</h2>" +
        "<p>Kryptonite reads endpoint profiles and skills from the folder you have open, and edits files inside it.</p>"));
      return;
    }
    if (!hasEndpoint()) {
      logEl.appendChild(div("welcome",
        crystal(46, "crystal") +
        "<h2>No endpoint configured</h2>" +
        "<p>Kryptonite works against endpoint profiles defined in .agent/endpoints/. Create one to get started.</p>" +
        '<div class="chips">' +
          '<button class="btn primary" data-act="newEndpoint">Create endpoint profile</button>' +
          '<button class="btn" data-act="ccEndpoints">Open Control Center</button>' +
        '</div>'));
      return;
    }
    logEl.appendChild(div("welcome",
      crystal(46, "crystal") +
      "<h2>How can I help?</h2>" +
      "<p>Kryptonite is connected and ready. Ask anything, or pick a starting point.</p>" +
      '<div class="chips">' +
        '<button class="chip-btn" data-sug="Add retry logic to fetch_json()">Add retry logic to fetch_json()</button>' +
        '<button class="chip-btn" data-sug="Write tests for api.py">Write tests for api.py</button>' +
        '<button class="chip-btn" data-act="doctor">Run TLS diagnostics</button>' +
      '</div>'));
  }

  function addUser(content) {
    if (typeof content === "string") { add(div("msg-user", esc(content))); return; }
    /* Content blocks: images + text */
    if (!Array.isArray(content)) { add(div("msg-user", esc(String(content)))); return; }
    var html = "";
    for (var i = 0; i < content.length; i++) {
      var b = content[i];
      if (b.type === "image") {
        html += '<img class="msg-img" src="data:' + esc(b.mediaType) + ';base64,' + b.data + '" alt="attached image">';
      } else if (b.type === "text") {
        html += '<span>' + esc(b.text) + '</span>';
      }
    }
    add(div("msg-user", html));
  }

  function appendAi(text) {
    if (!aiEl) {
      aiEl = add(div("msg-ai", ""));
      aiEl._raw = "";
    }
    aiEl._raw += text;
    aiEl.innerHTML = md(aiEl._raw);
    if (atBottom()) scroll();
  }

  /* ───────────────────────── tool cards ───────────────────────── */

  function toolStart(name, args) {
    aiEl = null;
    var el = div("tool");
    el.setAttribute("data-open", "0");
    el.innerHTML =
      '<button class="tool-head">' + icon("i-chev", "ic-9 chev") +
        icon(TOOL_ICON[name] || "i-file", "ic-14 tool-icon") +
        '<span class="tool-verb">' + esc(TOOL_VERB[name] || name) + "</span>" +
        '<span class="tool-arg ell">' + esc(argOf(name, args)) + "</span>" +
        '<span class="sp"></span><span class="tool-meta"></span></button>' +
      '<div class="tool-body" hidden></div>';
    el.querySelector(".tool-head").addEventListener("click", function () {
      var open = el.getAttribute("data-open") === "1";
      el.setAttribute("data-open", open ? "0" : "1");
      el.querySelector(".tool-body").hidden = open;
    });
    pendingTool = el;
    S.gerund = GERUND[name] || "Thinking…";
    tickGerund();
    return add(el);
  }

  function toolEnd(name, args, result, isError) {
    var el = pendingTool;
    pendingTool = null;
    if (!el) el = toolStart(name, args);
    el.setAttribute("data-error", isError ? "1" : "0");
    el.querySelector(".tool-meta").innerHTML = isError
      ? '<span class="tool-fail">' + icon("i-x", "ic-13") + "</span>"
      : '<span class="tool-ok">' + icon("i-check", "ic-13") + "</span>";

    var body = el.querySelector(".tool-body");
    body.innerHTML = "";
    var text = result == null ? "" : String(result);
    if (text) body.appendChild(resultBlock(text));
    if (text.length > MODEL_TRUNCATION) {
      body.appendChild(div("trunc-note",
        icon("i-warn", "ic-11") + "<span>Output truncated to 60,000 characters for the model</span>"));
    }
    if (isError) {
      el.setAttribute("data-open", "1");
      body.hidden = false;
    }
    S.gerund = "Thinking…";
    tickGerund();
  }

  /**
   * Large results are assigned as a single textContent write. Splitting them
   * per line would build tens of thousands of nodes and lock the webview.
   */
  function resultBlock(text) {
    var wrap = document.createElement("div");
    var pre = div("code-block");
    if (text.length > INLINE_LIMIT) {
      pre.textContent = text.slice(0, INLINE_LIMIT);
      wrap.appendChild(pre);
      var more = document.createElement("button");
      more.className = "show-more";
      more.textContent = "Show more (" + fmtK(text.length) + " characters)";
      more.addEventListener("click", function () {
        pre.textContent = text;
        more.remove();
      });
      wrap.appendChild(more);
    } else {
      pre.textContent = text;
      wrap.appendChild(pre);
    }
    return wrap;
  }

  /* ───────────────────────── diff cards ───────────────────────── */

  function parsePatch(patch) {
    var rows = [], oldN = 0, newN = 0, started = false;
    var lines = String(patch).split("\n");
    for (var i = 0; i < lines.length; i++) {
      var raw = lines[i];
      var hunk = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunk) {
        oldN = Number(hunk[1]); newN = Number(hunk[2]); started = true;
        rows.push({ kind: "hunk", text: raw });
        continue;
      }
      if (!started) continue;               /* skip the git header block */
      if (raw.charAt(0) === "\\") continue; /* "\ No newline at end of file" */
      if (raw.charAt(0) === "+") rows.push({ kind: "add", newNo: newN++, text: raw.slice(1) });
      else if (raw.charAt(0) === "-") rows.push({ kind: "del", oldNo: oldN++, text: raw.slice(1) });
      else rows.push({ kind: "ctx", oldNo: oldN++, newNo: newN++, text: raw.slice(1) });
      if (rows.length >= MAX_DIFF_ROWS) {
        rows.push({ kind: "hunk", text: "… diff truncated for display" });
        break;
      }
    }
    return rows;
  }

  function addDiff(m) {
    aiEl = null;
    var rows = parsePatch(m.patch), body = "";
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r.kind === "hunk") {
        body += '<div class="dl hunk"><span class="g"></span><span class="g"></span>' +
          '<span class="sg"></span><span class="c">' + esc(r.text) + "</span></div>";
        continue;
      }
      var sign = r.kind === "add" ? "+" : r.kind === "del" ? "\u2212" : "";
      body += '<div class="dl ' + r.kind + '">' +
        '<span class="g">' + (r.oldNo == null ? "" : r.oldNo) + "</span>" +
        '<span class="g">' + (r.newNo == null ? "" : r.newNo) + "</span>" +
        '<span class="sg">' + sign + "</span>" +
        '<span class="c">' + esc(r.text) + "</span></div>";
    }

    var card = div("diff-card",
      '<div class="diff-head">' + icon("i-file", "ic-13") +
        '<span class="f ell">' + esc(m.file) + "</span>" +
        '<span class="s"><span class="add-n">+' + m.added + '</span> ' +
        '<span class="del-n">\u2212' + m.removed + "</span></span></div>" +
      '<div class="diff-body">' + body + "</div>" +
      (m.truncated ? '<div class="trunc-note" style="padding:0 9px 6px">' + icon("i-warn", "ic-11") +
        "<span>Patch truncated at 30,000 characters</span></div>" : "") +
      '<div class="diff-foot">' + crystal(16) +
        "<span>Kryptonite: " + m.added + " additions, " + m.removed + " deletions</span>" +
        '<span class="sp"></span>' +
        '<button class="btn sm primary" data-diff="accept">Accept</button>' +
        '<button class="btn sm" data-diff="reject">Reject</button>' +
        '<button class="btn sm" data-diff="view">Diff view</button></div>');

    card.dataset.turn = m.turnId;
    card.dataset.file = m.file;
    card.addEventListener("click", function (e) {
      var b = e.target.closest("[data-diff]");
      if (!b) return;
      var action = b.getAttribute("data-diff");
      if (action === "view") { post("openFile", { path: m.file }); return; }
      post("resolveDiff", { turnId: m.turnId, file: m.file, decision: action });
    });
    add(card);
  }

  function resolveDiffCard(turnId, file, decision) {
    var cards = logEl.querySelectorAll(".diff-card");
    for (var i = 0; i < cards.length; i++) {
      var c = cards[i];
      if (c.dataset.turn !== turnId || c.dataset.file !== file) continue;
      var foot = c.querySelector(".diff-foot");
      if (!foot) return;
      foot.replaceWith(div("diff-resolved", decision === "accept"
        ? "Applied to " + esc(file) + " · checkpoint saved"
        : "Rejected · " + esc(file) + " restored from checkpoint"));
      return;
    }
  }

  /* ───────────────────── todo / permission / plan ───────────────────── */

  function renderTodos(todos) {
    S.todos = todos || [];
    if (!S.todos.length) {
      if (todoEl) { todoEl.remove(); todoEl = null; }
      return;
    }
    var done = 0, items = "", activeMarked = false;
    var anyInProgress = S.todos.some(function (x) { return x.status === "in_progress"; });
    for (var i = 0; i < S.todos.length; i++) {
      var t = S.todos[i];
      var isDone = t.status === "completed";
      if (isDone) done++;
      var isActive = !isDone && !activeMarked &&
        (t.status === "in_progress" || !anyInProgress);
      if (isActive) activeMarked = true;
      items += '<li class="' + (isDone ? "done" : isActive ? "doing" : "") + '">' +
        '<span class="cbx">' + (isDone ? icon("i-check", "ic-9") : "") + "</span>" +
        '<span class="tx">' + esc(t.content) + "</span></li>";
    }
    var pct = Math.round((done / S.todos.length) * 100);
    var html =
      '<div class="todo-head"><span class="t">Todos</span>' +
      '<span class="n">' + done + "/" + S.todos.length + "</span>" +
      '<span class="todo-bar"><i style="width:' + pct + '%"></i></span></div>' +
      '<ul class="todo-list">' + items + "</ul>";

    if (todoEl) { todoEl.innerHTML = html; return; }
    aiEl = null;
    todoEl = add(div("card", html));
  }

  function addPermission(m) {
    aiEl = null;
    var el = add(div("perm",
      '<div class="perm-t">' + icon("i-warn", "ic-14") + "Permission required</div>" +
      '<div class="perm-b">Kryptonite wants to:</div>' +
      '<div class="perm-cmd">' + esc(m.summary) + "</div>" +
      (m.detail ? '<div class="perm-cmd" style="margin-top:6px">' + esc(String(m.detail).slice(0, 4000)) + "</div>" : "") +
      '<div class="perm-actions">' +
        '<button class="btn primary" data-perm="allow">Allow</button>' +
        '<button class="btn" data-perm="always">Always allow</button>' +
        '<button class="btn" data-perm="deny">Deny</button></div>'));
    el.dataset.perm = m.id;
    el.dataset.summary = m.summary;
    el.addEventListener("click", function (e) {
      var b = e.target.closest("[data-perm]");
      if (!b) return;
      post("resolvePermission", { id: m.id, decision: b.getAttribute("data-perm") });
    });
  }

  function resolvePermissionCard(id, decision) {
    var cards = logEl.querySelectorAll("[data-perm]");
    for (var i = 0; i < cards.length; i++) {
      var el = cards[i];
      if (el.dataset.perm !== id) continue;
      var summary = el.dataset.summary || "";
      var isCommand = summary.indexOf("Run:") === 0;
      var label = decision === "allow"
        ? "Allowed once · " + summary
        : decision === "always"
          ? (isCommand ? "Always allowed in this workspace · " : "Always allowed this session · ") + summary
          : "Denied · not run";
      el.className = "perm-done";
      el.innerHTML = (decision === "deny"
        ? '<span style="color:var(--vscode-editorError-foreground);display:flex">' + icon("i-x", "ic-13") + "</span>"
        : '<span style="color:var(--vscode-testing-iconPassed);display:flex">' + icon("i-check", "ic-13") + "</span>") +
        "<span>" + esc(label) + "</span>";
      return;
    }
  }

  function addPlan(m) {
    aiEl = null;
    var steps = "";
    for (var i = 0; i < m.steps.length; i++) {
      steps += '<li><span class="n">' + (i + 1) + '</span><span>' + esc(m.steps[i]) + "</span></li>";
    }
    var el = add(div("plan-card",
      '<div class="plan-h"><span class="dot"></span><span class="t">Proposed plan</span>' +
      '<span class="m">' + esc(m.meta) + "</span></div>" +
      '<ul class="plan-steps">' + steps + "</ul>" +
      '<div class="plan-foot">' +
        '<button class="btn primary" data-plan="run">Approve &amp; run</button>' +
        '<button class="btn" data-plan="keep">Keep planning</button></div>'));
    el.addEventListener("click", function (e) {
      var b = e.target.closest("[data-plan]");
      if (!b) return;
      if (b.getAttribute("data-plan") === "run") {
        applyPhase("act", true);
        post("approvePlan");
      }
      var foot = el.querySelector(".plan-foot");
      if (foot) foot.remove();
    });
  }

  /* ───────────────────── streaming indicator ───────────────────── */

  function startStream() {
    if (!streamEl) {
      streamEl = add(div("stream",
        '<span class="rad"><span class="ring"></span><span class="core"></span>' +
        crystal(21, "crystal") + "</span>" +
        '<span class="g"></span><span class="m"></span>'));
      S.elapsed = 0;
    }
    tickGerund();
    if (!S.timer) {
      S.timer = setInterval(function () { S.elapsed++; tickGerund(); }, 1000);
    }
  }
  function tickGerund() {
    if (!streamEl) return;
    streamEl.querySelector(".g").textContent = S.gerund;
    streamEl.querySelector(".m").textContent = "(esc to interrupt · " + S.elapsed + "s)";
  }
  function endStream() {
    if (S.timer) { clearInterval(S.timer); S.timer = null; }
    if (streamEl) { streamEl.remove(); streamEl = null; }
    S.gerund = "Thinking…";
  }

  /* ───────────────────────── composer ───────────────────────── */

  function syncComposer() {
    var draft = $("draft");
    var blocked = !S.workspace.open || !hasEndpoint();
    draft.disabled = blocked;
    draft.placeholder = blocked
      ? "Configure an endpoint first…"
      : S.phase === "plan"
        ? "Describe what to plan…   ( / commands · @ files )"
        : "Ask Kryptonite anything…   ( / commands · @ files )";

    var send = $("sendBtn");
    if (S.running) {
      send.setAttribute("data-mode", "stop");
      send.setAttribute("data-ready", "0");
      send.title = "Interrupt";
      send.setAttribute("aria-label", "Interrupt");
      send.innerHTML = icon("i-stop", "ic-13");
      send.disabled = false;
    } else {
      send.setAttribute("data-mode", "send");
      var hasContent = draft.value.trim() || (S.attachments && S.attachments.length);
      send.setAttribute("data-ready", !blocked && hasContent ? "1" : "0");
      send.title = "Send";
      send.setAttribute("aria-label", "Send");
      send.innerHTML = icon("i-up", "ic-13");
      send.disabled = blocked;
    }
    $("atBtn").disabled = blocked;
    $("modelBtn").disabled = !hasEndpoint();

    /* Reset to auto so scrollHeight reflects the real content height, not a
       previous clamp. Then set overflow: the scrollbar must only appear once the
       content exceeds max-height — showing it on an empty textarea was the bug. */
    draft.style.height = "auto";
    var natural = draft.scrollHeight;
    draft.style.height = Math.min(natural, 120) + "px";
    draft.style.overflow = natural > 120 ? "auto" : "hidden";
  }

  function detectQuickPick() {
    if (S.modelOpen) return;
    var v = $("draft").value;
    if (/^\/[^\s]*$/.test(v)) {
      S.qp = { kind: "cmd", q: v.slice(1) };
    } else {
      var m = v.match(/(?:^|\s)@([\w./-]*)$/);
      if (m) {
        S.qp = { kind: "file", q: m[1] };
        scheduleSearch(m[1]);
      } else {
        S.qp = null;
      }
    }
    S.qpIndex = 0;
    renderQuickPick();
  }

  function scheduleSearch(query) {
    if (S.searchTimer) clearTimeout(S.searchTimer);
    S.searchTimer = setTimeout(function () {
      S.fileQuery = query;
      post("searchFiles", { query: query });
    }, 150);
  }

  function qpItems() {
    if (S.modelOpen) {
      var rows = [];
      var current = activeProfile();
      for (var i = 0; i < S.models.length; i++) {
        var g = S.models[i];
        rows.push({ group: g.group });
        for (var j = 0; j < g.models.length; j++) {
          rows.push({
            endpoint: g.group,
            model: g.models[j],
            active: Boolean(current && current.id === g.group)
          });
        }
      }
      return rows;
    }
    if (!S.qp) return [];
    var q = S.qp.q.toLowerCase();
    if (S.qp.kind === "cmd") {
      return CMDS.filter(function (c) { return c[0].slice(1).indexOf(q) === 0; })
        .map(function (c) { return { cmd: c[0], desc: c[1] }; });
    }
    return S.files.map(function (f) { return { file: f.path, badge: f.kind }; });
  }

  function renderQuickPick() {
    var qp = $("qp");
    var items = qpItems();
    var selectable = items.filter(function (r) { return !r.group; });
    if (!items.length) {
      if (S.qp && S.qp.kind === "file") {
        qp.innerHTML = '<div class="qp-empty">No matching files</div>';
        qp.hidden = false;
      } else {
        qp.hidden = true;
      }
      $("modelBtn").setAttribute("aria-expanded", "false");
      return;
    }
    if (S.qpIndex >= selectable.length) S.qpIndex = 0;

    var idx = -1, html = "";
    for (var i = 0; i < items.length; i++) {
      var r = items[i];
      if (r.group) { html += '<div class="qp-group">' + esc(r.group) + "</div>"; continue; }
      idx++;
      var on = idx === S.qpIndex ? "1" : "0";
      if (r.cmd) {
        html += '<button class="qp-row" role="option" data-active="' + on + '" data-i="' + idx + '">' +
          icon("i-term", "ic-13") + '<span class="n">' + esc(r.cmd) + "</span>" +
          '<span class="d ell">' + esc(r.desc) + "</span></button>";
      } else if (r.file) {
        html += '<button class="qp-row" role="option" data-active="' + on + '" data-i="' + idx + '">' +
          icon("i-file", "ic-13") + '<span class="n ell">@' + esc(r.file) + "</span>" +
          '<span class="d">' + esc(r.badge) + "</span></button>";
      } else {
        html += '<button class="qp-row" role="option" data-active="' + on + '" data-i="' + idx + '">' +
          '<span class="qp-check">' + (r.active ? icon("i-check", "ic-13") : "") + "</span>" +
          '<span class="n ell">' + esc(r.model) + "</span></button>";
      }
    }
    qp.innerHTML = html;
    qp.hidden = false;
    $("modelBtn").setAttribute("aria-expanded", S.modelOpen ? "true" : "false");
    var active = qp.querySelector('[data-active="1"]');
    if (active && active.scrollIntoView) active.scrollIntoView({ block: "nearest" });
  }

  function acceptQuickPick() {
    var items = qpItems().filter(function (r) { return !r.group; });
    var r = items[S.qpIndex];
    if (!r) return;
    var draft = $("draft");

    if (r.cmd) {
      runSlash(r.cmd, draft);
    } else if (r.file) {
      draft.value = draft.value.replace(/@([\w./-]*)$/, "@" + r.file + " ");
    } else {
      post("selectModel", { endpoint: r.endpoint, model: r.model });
      S.modelOpen = false;
    }
    S.qp = null;
    renderQuickPick();
    syncComposer();
    draft.focus();
  }

  function runSlash(cmd, draft) {
    switch (cmd) {
      case "/clear":
        draft.value = ""; post("newChat"); break;
      case "/doctor":
        draft.value = ""; setTab("diagnostics"); openSection("secTls"); post("runTrace"); break;
      case "/endpoints":
        draft.value = ""; setTab("diagnostics"); openSection("secEp"); renderEndpoints(); break;
      case "/model":
        draft.value = ""; S.modelOpen = true; S.qpIndex = 0; renderQuickPick(); return;
      case "/checkpoint":
        draft.value = ""; post("openControlCenter", { section: "checkpoints" }); break;
      case "/review":
        draft.value = ""; sendText(REVIEW_PROMPT); break;
      case "/skill:": {
        var names = S.skills.filter(function (s) { return s.enabled; })
          .map(function (s) { return s.name; });
        draft.value = "/skill:" + (names[0] || "");
        break;
      }
      case "/help": {
        draft.value = "";
        var lines = CMDS.map(function (c) { return c[0] + "  —  " + c[1]; }).join("\n");
        aiEl = null;
        add(div("note-box", esc("Available commands\n\n" + lines)));
        break;
      }
      default:
        draft.value = cmd + " ";
    }
  }

  function sendText(text) {
    var trimmed = String(text).trim();
    if (!trimmed) return;
    if (!S.workspace.open) { addError("Open a folder first."); return; }
    if (!hasEndpoint()) { addError("Select an endpoint profile first."); return; }
    if (S.running) { addError("Already working — interrupt first."); return; }
    addUser(trimmed);
    aiEl = null;
    S.gerund = S.phase === "plan" ? "Planning…" : "Thinking…";
    S.running = true;
    startStream();
    syncComposer();
    var payload = { text: trimmed };
    if (S.attachments && S.attachments.length) {
      payload.attachments = S.attachments.map(function (a) {
        return { name: a.name, mediaType: a.mediaType, data: a.data };
      });
    }
    post("sendMessage", payload);
    S.attachments = [];
    renderAttachments();
  }

  function addError(message) {
    aiEl = null;
    add(div("err-box", esc(message)));
  }

  /* ───────────────────────── footer ───────────────────────── */

  function renderFooter() {
    var used = S.context ? S.context.used : 0;
    var limit = S.context ? S.context.limit : 0;
    $("ctxText").textContent = fmtK(used) + " / " + fmtK(limit);
    $("ctxFill").style.width = limit ? Math.min(100, (used / limit) * 100) + "%" : "0";

    var active = activeProfile();
    var name = active ? active.id : "No endpoint";
    $("epName").textContent = S.tlsError ? name + " — TLS error" : name;
    $("epInd").setAttribute("data-err", S.tlsError ? "1" : "0");
    $("modelName").textContent = active ? active.model : "No model";
  }

  /* ─────────────────────── diagnostics: TLS ─────────────────────── */

  function renderTls() {
    var e = S.tlsError;
    var badge = $("tlsBadge");
    badge.textContent = e ? "1" : S.traceRun ? "OK" : "—";
    badge.className = e ? "badge alert" : "badge";
    $("tabDot").hidden = !e;

    var html = "";
    if (!e) {
      if (!S.traceRun && !S.rungs.length) {
        html += '<div class="ok-state"><p>No trace yet — run diagnostics to check the connection.</p>' +
          '<div><button class="btn sm primary" data-tls="trace">Run trace</button></div></div>';
      } else if (!S.tracing && S.rungs.every(function (r) { return r.status !== "fail"; })) {
        html += '<div class="ok-state"><div class="h">' + icon("i-check", "ic-14") + "No TLS errors</div>" +
          "<p>All endpoint connections are healthy. This panel populates automatically when a TLS or network error occurs.</p></div>";
      }
    } else {
      html += '<div class="errc"><div class="errc-h">' + icon("i-x", "ic-14") +
        "TLS handshake failed" +
        '<span class="who">' + esc(e.profile) + "</span></div>" +
        '<div class="errc-raw">' + esc(e.message) + "</div>" +
        '<div class="errc-grid">' +
          '<span class="k">Endpoint</span><span class="v ell" title="' + esc(e.endpoint) + '">' + esc(e.endpoint) + "</span>" +
          (e.proxied ? "" :
            '<span class="k">Cert subject</span><span class="v ell">' + esc(e.certSubject || "—") + "</span>" +
            '<span class="k">Cert issuer</span><span class="v ell">' + esc(e.certIssuer || "—") + "</span>" +
            '<span class="k">TLS version</span><span class="v">' + esc(e.tlsVersion || "—") + "</span>") +
        "</div>" +
        (e.proxied
          ? '<div class="proxied-note">Certificate details unavailable — the failing certificate was presented inside the CONNECT tunnel.</div>'
          : "") +
        "</div>";

      html += '<div class="fixk"><div class="l">Exact fix — set this configuration key:</div>' +
        '<div class="row"><code>"' + esc(e.fixKey) + '": "' + esc(e.fixValue) + '"</code>' +
        '<button class="mini" data-tls="copy" title="Copy" aria-label="Copy fix key">' + icon("i-copy", "ic-13") + "</button></div>" +
        (S.copied ? '<div class="copied">Copied to clipboard</div>' : "") + "</div>";

      if (S.caUpload) {
        html += '<div class="upload"><label for="caPath">CA bundle file (.pem, .crt, .cer)</label>' +
          '<div class="split"><input id="caPath" readonly placeholder="No file selected…" value="' + esc(S.caUpload.path) + '">' +
          '<button class="btn" data-tls="browse">Browse…</button></div>' +
          '<div class="hint2">The selected path will be written to <code>kryptonite.caBundlePath</code> (Workspace settings).</div>' +
          '<div class="row"><button class="btn" data-tls="cancelUpload">Cancel</button>' +
          '<button class="btn primary" data-tls="saveCa"' + (S.caUpload.path ? "" : " disabled") + ">Save &amp; Retry</button></div></div>";
      } else {
        html += '<div class="actions">' +
          '<button class="btn primary" data-tls="upload">Upload Custom CA Bundle</button>' +
          '<button class="btn" data-tls="system">Use System Trust Store</button>' +
          '<button class="btn" data-tls="trace">Retry Connection</button></div>';
      }
    }

    html += '<div class="trace-h"><span class="l">Connection trace</span><span class="sp"></span>' +
      '<button class="btn sm" data-tls="trace"' + (S.tracing ? " disabled" : "") + ">" +
      icon("i-refresh", "ic-13") + "<span>" + (S.tracing ? "Running…" : "Re-run trace") + "</span></button></div>";

    if (!S.rungs.length && !S.tracing) {
      html += '<div class="empty">No trace yet.</div>';
    } else {
      for (var i = 0; i < S.rungs.length; i++) {
        var r = S.rungs[i];
        html += rungRow(r.name, r.status, r.detail, r.fix, r.ms);
      }
      if (S.tracing) html += rungRow("", "pending", "Running…", undefined, null);
    }
    $("tlsBody").innerHTML = html;
  }

  function rungRow(name, status, detail, fix, ms) {
    return '<div class="rung" data-s="' + esc(status) + '">' +
      '<span class="rail"><span class="node"></span></span>' +
      '<span class="nm">' + esc(RUNG_LABELS[name] || name || "") + "</span>" +
      '<span class="body"><span class="dt">' + esc(detail) + "</span>" +
      (fix ? '<div class="fx">' + esc(fix) + "</div>" : "") + "</span>" +
      '<span class="ms">' + (status === "pass" || status === "fail" || status === "warn"
        ? (ms ? ms + "ms" : "—") : "—") + "</span></div>";
  }

  /* ──────────────────── diagnostics: endpoints ──────────────────── */

  function renderEndpoints() {
    $("epBadge").textContent = String(S.profiles.length);
    var rows = "";
    for (var i = 0; i < S.profiles.length; i++) {
      var p = S.profiles[i];
      var iconId = p.status === "error" ? "i-warn" : (EP_ICON[p.wire] || "i-globe");
      rows += '<div class="trow" data-status="' + p.status + '">' +
        (iconId === "i-kx"
          ? "<span>" + crystal(16) + "</span>"
          : '<span style="color:var(--vscode-descriptionForeground)">' + icon(iconId, "ic-14") + "</span>") +
        '<span class="ell"><span class="id ell">' + esc(p.id) + "</span>" +
        '<span class="url ell" title="' + esc(p.status === "error" ? p.error || "" : p.baseUrl) + '">' +
        esc(p.status === "error" ? (p.error || "Failed to parse") : p.baseUrl) + "</span></span>" +
        '<span class="acts">' +
          '<button class="mini" data-ep="edit" data-id="' + esc(p.id) + '" title="Edit endpoint" aria-label="Edit endpoint">' + icon("i-pencil", "ic-13") + "</button>" +
          '<button class="mini danger" data-ep="del" data-id="' + esc(p.id) + '" title="Delete endpoint" aria-label="Delete endpoint">' + icon("i-trash", "ic-13") + "</button>" +
        "</span></div>";
    }

    var html = rows
      ? '<div class="tbl">' + rows + "</div>"
      : '<div class="empty">No profiles in .agent/endpoints/</div>';
    html += '<div style="margin-top:8px"><button class="btn sm" data-ep="add">+ Add endpoint</button></div>';

    if (S.epForm) {
      var f = S.epForm;
      var types = ["anthropic", "openai-compatible", "azure", "local", "custom"], opts = "";
      for (var t = 0; t < types.length; t++) {
        opts += '<option value="' + types[t] + '"' + (f.type === types[t] ? " selected" : "") + ">" + types[t] + "</option>";
      }
      html += '<div class="form"><div class="t">' + (f.isNew ? "Add endpoint" : "Edit endpoint") + "</div>" +
        '<div class="fgrid">' +
          '<label for="fId">ID</label><input id="fId" value="' + esc(f.id) + '" placeholder="corp-gateway">' +
          '<label for="fName">Display Name</label><input id="fName" value="' + esc(f.name) + '" placeholder="Corp Gateway">' +
          '<label for="fUrl">Base URL</label><input id="fUrl" value="' + esc(f.url) + '" placeholder="https://llm.corp.example/v1">' +
          '<label for="fType">Provider Type</label><select id="fType">' + opts + "</select>" +
        "</div>" +
        '<div class="row"><button class="btn" data-ep="cancel">Cancel</button>' +
        '<button class="btn primary" data-ep="save">Save</button></div></div>';
    }
    $("epBody").innerHTML = html;
  }

  /* ───────────────────── diagnostics: skills ───────────────────── */

  function renderSkills() {
    $("skBadge").textContent = String(S.skills.length);
    var rows = "", enabled = 0;
    for (var i = 0; i < S.skills.length; i++) {
      var s = S.skills[i];
      if (s.enabled) enabled++;
      rows += '<button class="skill" data-src="' + esc(s.source) + '" data-skill="' + esc(s.name) +
        '" role="checkbox" aria-checked="' + (s.enabled ? "true" : "false") + '">' +
        '<span class="cbx"' + (s.enabled
          ? ' style="background:var(--kx-accent);border-color:var(--kx-accent);color:var(--vscode-sideBar-background)"'
          : "") + ">" + (s.enabled ? icon("i-check", "ic-9") : "") + "</span>" +
        '<span class="nm ell">' + esc(s.name) + "</span>" +
        '<span class="ds ell" title="' + esc(s.description) + '">' + esc(s.description) + "</span>" +
        '<span class="src">' + esc(s.source) + "</span></button>";
    }
    var tokens = enabled * 62;
    $("skBody").innerHTML =
      (rows || '<div class="empty">No skills found in .agent/skills/</div>') +
      '<div class="sk-foot"><span>' + enabled + " enabled · ~" + tokens + " tokens in system prompt</span>" +
      '<span class="sp"></span>' +
      '<button class="btn sm" data-sk="reload">' + (S.reloaded ? "Reloaded" : "Reload") + "</button>" +
      '<button class="btn sm" data-sk="open">Open skills folder</button></div>' +
      (S.skillWarnings.length
        ? '<div class="warn-line">' + esc(S.skillWarnings.join(" ")) + "</div>"
        : "");
  }

  /* ───────────────────── session restore rendering ───────────────────── */

  function renderSession(messages) {
    clearTranscript();
    if (!messages || !messages.length) { renderWelcome(); return; }

    /* Tool results are consumed by the assistant call that produced them, so a
       restored transcript reads like the live one rather than a raw log. */
    var resultFor = {};
    for (var i = 0; i < messages.length; i++) {
      var m = messages[i];
      if (m.role === "tool" && m.toolCallId) resultFor[m.toolCallId] = textOf(m.content);
    }

    for (var j = 0; j < messages.length; j++) {
      var msg = messages[j];
      if (msg.role === "user") { addUser(msg.content); continue; }
      if (msg.role !== "assistant") continue;

      var body = textOf(msg.content);
      if (body) { aiEl = null; appendAi(body); aiEl = null; }

      var calls = msg.toolCalls || [];
      for (var k = 0; k < calls.length; k++) {
        var call = calls[k];
        var el = div("tool");
        el.setAttribute("data-open", "0");
        el.innerHTML =
          '<button class="tool-head">' + icon("i-chev", "ic-9 chev") +
            icon(TOOL_ICON[call.name] || "i-file", "ic-14 tool-icon") +
            '<span class="tool-verb">' + esc(TOOL_VERB[call.name] || call.name) + "</span>" +
            '<span class="tool-arg ell">' + esc(argOf(call.name, call.arguments)) + "</span>" +
            '<span class="sp"></span></button><div class="tool-body" hidden></div>';
        (function (element) {
          element.querySelector(".tool-head").addEventListener("click", function () {
            var open = element.getAttribute("data-open") === "1";
            element.setAttribute("data-open", open ? "0" : "1");
            element.querySelector(".tool-body").hidden = open;
          });
        })(el);
        var res = resultFor[call.id];
        if (res) el.querySelector(".tool-body").appendChild(resultBlock(res));
        add(el);
      }
    }
    scroll();
  }

  function textOf(content) {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content.filter(function (b) { return b && b.type === "text"; })
      .map(function (b) { return b.text; }).join("\n");
  }

  /* ───────────────────────── hydration ───────────────────────── */

  function hydrate(state) {
    S.workspace = state.workspace;
    S.running = state.running;
    S.phase = state.phase;
    S.endpoint = state.endpoint;
    S.profiles = state.profiles || [];
    S.skills = state.skills || [];
    S.skillWarnings = state.skillWarnings || [];
    S.config = state.config;
    S.tlsError = state.tlsError;
    S.rungs = state.rungs || [];
    S.tracing = state.tracing;
    S.traceRun = S.rungs.length > 0;
    S.todos = state.todos || [];
    S.sessions = state.sessions || [];
    S.selection = state.selection;
    S.context = state.context;
    S.models = state.models || [];

    S.sessionId = state.session ? state.session.id : null;

    applyPhase(S.phase, true);
    renderSession(state.session ? state.session.messages : []);
    todoEl = null;
    renderTodos(S.todos);
    renderSelection();
    renderFooter();
    renderTls();
    renderEndpoints();
    renderSkills();
    renderHistory();
    syncComposer();
    if (S.running) startStream();
    S.hydrated = true;
  }

  function renderSelection() {
    var pill = $("selPill");
    if (!S.selection) { pill.hidden = true; return; }
    $("selText").textContent =
      "Selection: " + S.selection.file + " L" + S.selection.startLine + "–L" + S.selection.endLine;
    pill.hidden = false;
  }

  /** Show attached-file pills between the selection pill and the textarea. */
  function renderAttachments() {
    var strip = $("attachStrip");
    if (!S.attachments || !S.attachments.length) {
      strip.hidden = true;
      strip.innerHTML = "";
      return;
    }
    var html = "";
    for (var i = 0; i < S.attachments.length; i++) {
      var a = S.attachments[i];
      var isImg = a.mediaType.indexOf("image/") === 0;
      var thumb = isImg
        ? '<img class="att-thumb" src="data:' + esc(a.mediaType) + ';base64,' + a.data.slice(0, 200) + '…" alt="">'
        : icon("i-file", "ic-13");
      var size = a.size < 1024 ? a.size + " B"
        : a.size < 1048576 ? (a.size / 1024).toFixed(1) + " KB"
        : (a.size / 1048576).toFixed(1) + " MB";
      html += '<span class="att-pill" data-att="' + i + '">' +
        (isImg ? '<img class="att-thumb" src="data:' + esc(a.mediaType) + ';base64,' + a.data + '" alt="">' : icon("i-file", "ic-13")) +
        '<span class="att-name ell">' + esc(a.name) + '</span>' +
        '<span class="att-size">' + size + '</span>' +
        '<button class="att-x" data-att-rm="' + i + '" title="Remove" aria-label="Remove ' + esc(a.name) + '">' +
          icon("i-x", "ic-9") + '</button></span>';
    }
    strip.innerHTML = html;
    strip.hidden = false;
  }

  /* ───────────────────────── wiring ───────────────────────── */

  function wire() {
    $("newBtn").addEventListener("click", function () {
      closePops();
      post("newChat");
      /* The transcript clears when the host answers with sessionSwitched; the
         draft is local, so it is cleared here. */
      $("draft").value = "";
      syncComposer();
      $("draft").focus();
    });

    $("histBtn").addEventListener("click", function (e) {
      e.stopPropagation();
      var wasClosed = $("historyPop").hidden;
      closePops();
      if (wasClosed) {
        post("listSessions");
        renderHistory();
        $("historyPop").hidden = false;
        $("histBtn").setAttribute("aria-expanded", "true");
      }
    });
    $("moreBtn").addEventListener("click", function (e) {
      e.stopPropagation();
      var wasClosed = $("morePop").hidden;
      closePops();
      if (wasClosed) {
        $("morePop").hidden = false;
        $("moreBtn").setAttribute("aria-expanded", "true");
      }
    });
    $("morePop").addEventListener("click", function (e) {
      var b = e.target.closest("[data-more]");
      if (!b) return;
      closePops();
      var a = b.getAttribute("data-more");
      if (a === "control") post("openControlCenter", {});
      else if (a === "settings") post("openSettings");
      else if (a === "docs") post("openControlCenter", { section: "logs" });
      else if (a === "issue") post("openControlCenter", { section: "logs" });
    });
    $("historyPop").addEventListener("click", function (e) {
      var del = e.target.closest("[data-del]");
      if (del) {
        /* Delete is nested inside the row, so the load handler must not also
           fire on the way up. */
        e.stopPropagation();
        post("deleteSession", { id: del.getAttribute("data-del") });
        return;
      }
      var b = e.target.closest("[data-session]");
      if (!b) return;
      closePops();
      post("loadSession", { id: b.getAttribute("data-session") });
    });
    document.addEventListener("click", function (e) {
      if (!e.target.closest(".kx-header")) closePops();
      if (S.modelOpen && !e.target.closest("#modelBtn") && !e.target.closest("#qp")) {
        S.modelOpen = false;
        renderQuickPick();
      }
    });

    $("tabSession").addEventListener("click", function () { setTab("session"); });
    $("tabDiag").addEventListener("click", function () { setTab("diagnostics"); });
    $("ccBtn").addEventListener("click", function () { post("openControlCenter", {}); });

    document.addEventListener("click", function (e) {
      var head = e.target.closest(".sec-head");
      if (!head) return;
      var sec = $(head.getAttribute("data-sec"));
      var open = sec.getAttribute("data-open") === "1";
      sec.setAttribute("data-open", open ? "0" : "1");
      head.setAttribute("aria-expanded", open ? "false" : "true");
      sec.querySelector(".sec-body").hidden = open;
    });

    $("phaseSeg").addEventListener("click", function (e) {
      var b = e.target.closest("[data-phase]");
      if (b) applyPhase(b.getAttribute("data-phase"));
    });

    logEl.addEventListener("click", function (e) {
      var sug = e.target.closest("[data-sug]");
      if (sug) { sendText(sug.getAttribute("data-sug")); return; }
      var act = e.target.closest("[data-act]");
      if (!act) return;
      var a = act.getAttribute("data-act");
      if (a === "doctor") { setTab("diagnostics"); openSection("secTls"); post("runTrace"); }
      else if (a === "newEndpoint") post("newEndpoint");
      else if (a === "ccEndpoints") post("openControlCenter", { section: "endpoints" });
    });

    var draft = $("draft");
    draft.addEventListener("input", function () { syncComposer(); detectQuickPick(); });
    draft.addEventListener("keydown", onDraftKey);

    $("qp").addEventListener("click", function (e) {
      var b = e.target.closest("[data-i]");
      if (!b) return;
      S.qpIndex = Number(b.getAttribute("data-i"));
      acceptQuickPick();
    });
    $("modelBtn").addEventListener("click", function (e) {
      e.stopPropagation();
      S.modelOpen = !S.modelOpen;
      S.qp = null;
      S.qpIndex = 0;
      renderQuickPick();
    });
    $("atBtn").addEventListener("click", function () {
      draft.value += (draft.value && !/\s$/.test(draft.value) ? " " : "") + "@";
      draft.focus();
      syncComposer();
      detectQuickPick();
    });
    $("clipBtn").addEventListener("click", function () {
      post("attachFiles");
    });
    $("attachStrip").addEventListener("click", function (e) {
      var btn = e.target.closest("[data-att-rm]");
      if (!btn) return;
      var idx = parseInt(btn.getAttribute("data-att-rm"), 10);
      if (!isNaN(idx) && S.attachments) {
        S.attachments.splice(idx, 1);
        renderAttachments();
        syncComposer();
      }
    });
    $("selClear").addEventListener("click", function () {
      S.selection = null;
      renderSelection();
    });
    $("sendBtn").addEventListener("click", function () {
      if (S.running) { post("interrupt"); return; }
      sendText(draft.value);
      draft.value = "";
      S.attachments = [];
      renderAttachments();
      syncComposer();
    });

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && S.running && $("qp").hidden) post("interrupt");
    });

    $("tlsBody").addEventListener("click", onTlsClick);
    $("epBody").addEventListener("click", onEpClick);
    $("skBody").addEventListener("click", onSkillClick);
  }

  function onDraftKey(e) {
    var draft = $("draft");
    var pickerOpen = !$("qp").hidden;
    if (pickerOpen) {
      var n = qpItems().filter(function (r) { return !r.group; }).length;
      if (n) {
        if (e.key === "ArrowDown") { e.preventDefault(); S.qpIndex = (S.qpIndex + 1) % n; renderQuickPick(); return; }
        if (e.key === "ArrowUp") { e.preventDefault(); S.qpIndex = (S.qpIndex - 1 + n) % n; renderQuickPick(); return; }
        if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); acceptQuickPick(); return; }
      }
      if (e.key === "Escape") {
        e.preventDefault();
        S.qp = null; S.modelOpen = false; renderQuickPick();
        return;
      }
    }
    if (e.key === "Tab" && e.shiftKey) {
      e.preventDefault();
      applyPhase(S.phase === "plan" ? "act" : "plan");
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendText(draft.value);
      draft.value = "";
      syncComposer();
    }
  }

  function onTlsClick(e) {
    var b = e.target.closest("[data-tls]");
    if (!b) return;
    var a = b.getAttribute("data-tls");
    if (a === "trace") { S.tracing = true; S.rungs = []; renderTls(); post("runTrace"); }
    else if (a === "system") post("useSystemTrust");
    else if (a === "upload") { S.caUpload = { path: "" }; renderTls(); }
    else if (a === "cancelUpload") { S.caUpload = null; renderTls(); }
    else if (a === "browse") post("browseCaBundle");
    else if (a === "saveCa") {
      post("saveCaBundle", { path: S.caUpload.path });
      S.caUpload = null;
      renderTls();
    } else if (a === "copy") {
      post("copyText", { text: '"' + S.tlsError.fixKey + '": "' + S.tlsError.fixValue + '"' });
      S.copied = true;
      renderTls();
      setTimeout(function () { S.copied = false; renderTls(); }, 1500);
    }
  }

  function onEpClick(e) {
    var b = e.target.closest("[data-ep]");
    if (!b) return;
    var a = b.getAttribute("data-ep"), id = b.getAttribute("data-id");
    if (a === "add") {
      S.epForm = { isNew: true, id: "", name: "", url: "", type: "openai-compatible" };
      renderEndpoints();
    } else if (a === "cancel") {
      S.epForm = null;
      renderEndpoints();
    } else if (a === "edit") {
      for (var i = 0; i < S.profiles.length; i++) {
        if (S.profiles[i].id !== id) continue;
        var p = S.profiles[i];
        S.epForm = {
          isNew: false, id: p.id, name: p.description || p.id,
          url: p.baseUrl === "—" ? "" : p.baseUrl,
          type: p.wire === "anthropic" ? "anthropic" : "openai-compatible",
          originalId: p.id
        };
        renderEndpoints();
        break;
      }
    } else if (a === "del") {
      post("deleteEndpoint", { id: id });
    } else if (a === "save") {
      var form = {
        id: $("fId").value.trim(),
        name: $("fName").value.trim(),
        url: $("fUrl").value.trim(),
        type: $("fType").value
      };
      if (S.epForm && S.epForm.originalId) form.originalId = S.epForm.originalId;
      S.epForm = null;
      renderEndpoints();
      if (form.id) post("saveEndpoint", { endpoint: form });
    }
  }

  function onSkillClick(e) {
    var t = e.target.closest("[data-skill]");
    if (t) {
      var name = t.getAttribute("data-skill");
      for (var i = 0; i < S.skills.length; i++) {
        if (S.skills[i].name === name) {
          S.skills[i].enabled = !S.skills[i].enabled;
          post("toggleSkill", { name: name, enabled: S.skills[i].enabled });
        }
      }
      renderSkills();
      return;
    }
    var b = e.target.closest("[data-sk]");
    if (!b) return;
    if (b.getAttribute("data-sk") === "reload") {
      post("reloadSkills");
      S.reloaded = true;
      renderSkills();
      setTimeout(function () { S.reloaded = false; renderSkills(); }, 1400);
    } else {
      post("openSkillsFolder");
    }
  }

  /* ───────────────────────── inbound ───────────────────────── */

  window.addEventListener("message", function (event) {
    var m = event.data;
    if (!m || !m.type) return;

    switch (m.type) {
      case "stateSync":
        hydrate(m.state);
        break;

      case "streamDelta":
        S.running = true;
        startStream();
        appendAi(m.text);
        syncComposer();
        break;

      case "toolStart":
        toolStart(m.tool.name, m.tool.args);
        break;

      case "toolEnd":
        toolEnd(m.tool.name, m.tool.args, m.tool.result, m.tool.isError);
        break;

      case "todosUpdated":
        renderTodos(m.todos);
        break;

      case "planProposed":
        addPlan(m);
        break;

      case "permissionRequest":
        addPermission(m);
        break;

      case "permissionResolved":
        resolvePermissionCard(m.id, m.decision);
        break;

      case "diffPending":
        addDiff(m);
        break;

      case "diffResolved":
        resolveDiffCard(m.turnId, m.file, m.decision);
        break;

      case "fileTouched":
        break;

      case "turnEnd":
        S.running = false;
        endStream();
        aiEl = null;
        pendingTool = null;
        syncComposer();
        break;

      case "error":
        addError(m.message);
        break;

      case "traceStarted":
        S.tracing = true;
        S.rungs = [];
        renderTls();
        break;

      case "traceUpdate":
        S.tracing = true;
        S.rungs = S.rungs.slice(0, m.index).concat([m.rung]);
        renderTls();
        break;

      case "traceDone":
        S.tracing = false;
        S.traceRun = true;
        S.rungs = m.rungs || [];
        renderTls();
        break;

      case "tlsError":
        S.tlsError = m.error;
        renderTls();
        renderFooter();
        break;

      case "profilesReloaded":
        S.profiles = m.profiles || [];
        renderEndpoints();
        renderFooter();
        syncComposer();
        if (logEl.querySelector(".welcome")) renderWelcome();
        break;

      case "skillsReloaded":
        S.skills = m.skills || [];
        S.skillWarnings = m.warnings || [];
        renderSkills();
        break;

      case "contextUsage":
        S.context = { used: m.used, limit: m.limit };
        renderFooter();
        break;

      case "selectionChanged":
        S.selection = m.selection;
        renderSelection();
        break;

      case "attachmentsReady":
        if (!S.attachments) S.attachments = [];
        for (var ai = 0; ai < m.files.length; ai++) S.attachments.push(m.files[ai]);
        renderAttachments();
        syncComposer();
        $("draft").focus();
        break;

      case "sessionSwitched":
        S.sessionId = m.id;
        S.running = false;
        endStream();
        aiEl = null;
        todoEl = null;
        S.todos = [];
        S.context = null;
        S.attachments = [];
        renderSession(m.messages);
        renderAttachments();
        renderTodos([]);
        renderFooter();
        syncComposer();
        break;

      case "sessionsListed":
        S.sessions = m.sessions || [];
        renderHistory();
        break;

      case "configChanged":
        S.config = m.config;
        break;

      case "phaseChanged":
        applyPhase(m.phase, true);
        break;

      case "endpointChanged":
        S.endpoint = m.endpoint;
        renderFooter();
        syncComposer();
        break;

      case "statusChanged":
        break;

      case "caBundlePicked":
        if (S.caUpload) { S.caUpload.path = m.path; renderTls(); }
        break;

      case "fileResults":
        if (m.query !== S.fileQuery) break;
        S.files = m.files || [];
        S.qpIndex = 0;
        renderQuickPick();
        break;

      case "checkpointsListed":
      case "checkpointRestored":
      case "bundleExported":
      case "logLine":
      case "navigate":
        break;
    }
  });

  /* ───────────────────────── boot ───────────────────────── */

  mount();
  wire();
  renderWelcome();
  renderFooter();
  renderTls();
  renderEndpoints();
  renderSkills();
  syncComposer();
  post("ready");
})();
} /* end _sbRun */
