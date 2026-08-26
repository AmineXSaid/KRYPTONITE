/* GENESIS sidebar frontend. Plain DOM, zero dependencies.
 *
 * The store mirrors what the host sends; nothing here is authoritative. The
 * transcript is append-only — a full re-render on every stream delta would
 * discard scroll position and expanded tool cards — while the diagnostics
 * panes re-render wholesale because they are small and always coherent.
 *
 * roundel.js must have run first — see the same guard in controlCenter.js.
 */
(function _boot() {
  if (!window.__kxRoundel) { setTimeout(_boot, 5); return; }
  _sbRun();
})();
function _sbRun() {
(function () {
  "use strict";

  var api = window.__kx.api;

  /* ─────────────────────────── constants ─────────────────────────── */

  var ROUNDEL_DEFS = window.__kxRoundel.defs;

  var S6 = 'stroke="currentColor" fill="none"';
  var ICON_DEFS =
    '<symbol id="i-plus" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" ' + S6 + ' stroke-width="1.7"/></symbol>' +
    '<symbol id="i-clock" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" ' + S6 + ' stroke-width="1.6"/><path d="M12 8v4.4l3 1.7" ' + S6 + ' stroke-width="1.6"/></symbol>' +
    '<symbol id="i-dots" viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.5" fill="currentColor"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/><circle cx="19" cy="12" r="1.5" fill="currentColor"/></symbol>' +
    '<symbol id="i-chev" viewBox="0 0 10 10"><path d="M2.5 0.5L7 5l-4.5 4.5" ' + S6 + ' stroke-width="1.4"/></symbol>' +
    '<symbol id="i-caret" viewBox="0 0 10 10"><path d="M1 3l4 4.5L9 3" ' + S6 + ' stroke-width="1.3"/></symbol>' +
    '<symbol id="i-file" viewBox="0 0 24 24"><path d="M6 3h7l5 5v13H6z" ' + S6 + ' stroke-width="1.5"/><path d="M13 3v5h5" ' + S6 + ' stroke-width="1.5"/></symbol>' +
    '<symbol id="i-term" viewBox="0 0 24 24"><rect x="3" y="4.5" width="18" height="15" rx="1.5" ' + S6 + ' stroke-width="1.5"/><path d="M7 10l3 2.5L7 15M12.5 15.5h4.5" ' + S6 + ' stroke-width="1.5"/></symbol>' +
    '<symbol id="i-search" viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5" ' + S6 + ' stroke-width="1.6"/><path d="M16 16l4.5 4.5" ' + S6 + ' stroke-width="1.6"/></symbol>' +
    '<symbol id="i-book" viewBox="0 0 24 24"><path d="M4 5.5c3-1.2 5.5-1.2 8 .5v13c-2.5-1.7-5-1.7-8-.5zM20 5.5c-3-1.2-5.5-1.2-8 .5v13c2.5-1.7 5-1.7 8-.5z" ' + S6 + ' stroke-width="1.5"/></symbol>' +
    '<symbol id="i-check" viewBox="0 0 24 24"><path d="M4.5 12.5l5 5 10-11" ' + S6 + ' stroke-width="2"/></symbol>' +
    '<symbol id="i-x" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" ' + S6 + ' stroke-width="2"/></symbol>' +
    '<symbol id="i-warn" viewBox="0 0 24 24"><path d="M12 3l9.5 17H2.5z" ' + S6 + ' stroke-width="1.5"/><path d="M12 9.5v5M12 17v.5" ' + S6 + ' stroke-width="1.6"/></symbol>' +
    '<symbol id="i-clip" viewBox="0 0 24 24"><path d="M17.5 10.5l-6.8 6.8a3 3 0 01-4.2-4.2l7.5-7.5a4.5 4.5 0 016.4 6.4l-7.5 7.5" ' + S6 + ' stroke-width="1.5"/></symbol>' +
    '<symbol id="i-up" viewBox="0 0 24 24"><path d="M12 19V5M6 11l6-6 6 6" ' + S6 + ' stroke-width="1.7"/></symbol>' +
    '<symbol id="i-stop" viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" fill="currentColor"/></symbol>' +
    '<symbol id="i-globe" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5" ' + S6 + ' stroke-width="1.5"/><path d="M3.5 12h17M12 3.5c-4.5 5-4.5 12 0 17 4.5-5 4.5-12 0-17z" ' + S6 + ' stroke-width="1.4"/></symbol>' +
    '<symbol id="i-monitor" viewBox="0 0 24 24"><rect x="3" y="4.5" width="18" height="12" rx="1.5" ' + S6 + ' stroke-width="1.5"/><path d="M9 20h6M12 16.5V20" ' + S6 + ' stroke-width="1.5"/></symbol>' +
    '<symbol id="i-pencil" viewBox="0 0 24 24"><path d="M16.5 3.8l3.7 3.7L8.4 19.3l-4.7.9.9-4.7z" ' + S6 + ' stroke-width="1.5"/></symbol>' +
    '<symbol id="i-trash" viewBox="0 0 24 24"><path d="M4 6.5h16M9.5 6.5V4h5v2.5M6.5 6.5l1 14h9l1-14" ' + S6 + ' stroke-width="1.5"/></symbol>' +
    '<symbol id="i-copy" viewBox="0 0 24 24"><rect x="8.5" y="8.5" width="12" height="12" rx="1.5" ' + S6 + ' stroke-width="1.5"/><path d="M15.5 8.5v-3a1.5 1.5 0 00-1.5-1.5H5a1.5 1.5 0 00-1.5 1.5v9A1.5 1.5 0 005 16h3" ' + S6 + ' stroke-width="1.5"/></symbol>' +
    '<symbol id="i-refresh" viewBox="0 0 24 24"><path d="M20 12a8 8 0 11-2.4-5.7M20 3.5V9h-5.5" ' + S6 + ' stroke-width="1.6"/></symbol>' +
    '<symbol id="i-folder" viewBox="0 0 24 24"><path d="M3 6h6l2 3h10v10H3z" ' + S6 + ' stroke-width="1.5"/></symbol>' +
    '<symbol id="i-diff" viewBox="0 0 24 24"><path d="M6 3.5v17M3 7h6M3 17h6" ' + S6 + ' stroke-width="1.6"/><path d="M15 3.5h6v6h-6zM15 14.5h6v6h-6z" ' + S6 + ' stroke-width="1.5"/></symbol>' +
    '<symbol id="i-hand" viewBox="0 0 24 24"><path d="M9 11.4V5.6a1.4 1.4 0 0 1 2.8 0v5.8m0 0V4.7a1.4 1.4 0 0 1 2.8 0v6.7m0 0V6.6a1.4 1.4 0 0 1 2.8 0V13c0 4.4-2.3 7.6-6.1 7.6S6.2 17.4 6.2 13v-2.1a1.4 1.4 0 0 1 2.8 0v.5" ' + S6 + ' stroke-width="1.5"/></symbol>' +
    '<symbol id="i-code" viewBox="0 0 24 24"><path d="M9.5 7.5L5 12l4.5 4.5M14.5 7.5L19 12l-4.5 4.5" ' + S6 + ' stroke-width="1.7"/></symbol>' +
    '<symbol id="i-bolt" viewBox="0 0 24 24"><path d="M13.2 3L6 13.6h4.6L10.2 21 17.4 10.4h-4.6z" ' + S6 + ' stroke-width="1.5"/></symbol>';

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
    anthropic: "roundel", "openai-compatible": "i-globe", azure: "i-globe",
    local: "i-monitor", custom: "i-globe", raw: "i-globe", openai: "i-globe"
  };

  var MODES = [
    { v: "ask", icon: "i-hand", label: "Ask every time", desc: "Genesis proposes every file edit and shell command and waits for your decision." },
    { v: "edits-auto", icon: "i-code", label: "Auto-approve edits", desc: "File edits apply without asking. Shell commands still wait for approval." },
    { v: "full-auto", icon: "i-bolt", label: "Full auto", desc: "Edits and shell commands both run without asking. Use with a workspace you trust." }
  ];
  var MODE_SHORT = { ask: "Ask", "edits-auto": "Auto-edit", "full-auto": "Full auto" };
  /* The button carries its mode's icon as well as its word. Without it, a bare
     "ASK" sitting a few pixels from the PLAN/ACT segment reads as a third
     phase, which it is not — this control is about what may run unattended. */
  var MODE_ICON = { ask: "i-hand", "edits-auto": "i-code", "full-auto": "i-bolt" };

  var INLINE_LIMIT = 100000;
  var MODEL_TRUNCATION = 60000;
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
    sessionTitle: "",
    selection: null,
    context: null,
    models: [],
    /* local-only */
    tab: "session",
    qp: null,
    qpIndex: 0,
    modelOpen: false,
    modeSheetOpen: false,
    histOpen: false,
    histQuery: "",
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
    sessionId: null,
    changedFiles: [],
    chgOpen: false
  };

  /* transcript element handles */
  var logEl, aiEl = null, streamEl = null, pendingTool = null, todoEl = null, stepsEl = null;

  /* ───────────────────────────── helpers ─────────────────────────── */

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
  function roundel(size, cls, variant) { return window.__kxRoundel.svg(size, cls, variant); }
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

  /** Split "dir/file.ext" into a dim-directory span and a bright basename span. */
  function pathParts(p) {
    var s = String(p || "");
    var i = s.lastIndexOf("/");
    if (i < 0) return '<span>' + esc(s) + "</span>";
    return '<span class="dim">' + esc(s.slice(0, i + 1)) + '</span><span>' + esc(s.slice(i + 1)) + "</span>";
  }

  /* ─────────────────────────── shell ─────────────────────────── */

  function mount() {
    var root = $("root");
    root.innerHTML =
      '<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>' +
      ROUNDEL_DEFS + ICON_DEFS + '</defs></svg>' +
      '<div id="app">' +
        '<header class="gx-header">' +
          roundel(18, "", "sm") +
          '<span class="gx-wordmark">GENESIS</span><span class="sp"></span>' +
          '<button class="icon-btn" id="newBtn" title="New chat" aria-label="New chat">' + icon("i-plus") + '</button>' +
          '<button class="icon-btn" id="histBtn" title="History" aria-label="Chat history" aria-haspopup="dialog" aria-expanded="false">' + icon("i-clock") + '</button>' +
          '<button class="icon-btn" id="moreBtn" title="More" aria-label="More actions" aria-haspopup="menu" aria-expanded="false">' + icon("i-dots") + '</button>' +
          '<div class="popover" id="morePop" role="menu" hidden>' +
            '<button class="pop-row" role="menuitem" data-more="control">' + roundel(15, "", "full") + '<span>Control Center</span></button>' +
            '<button class="pop-row" role="menuitem" data-more="settings"><span>Settings…</span></button>' +
            '<button class="pop-row" role="menuitem" data-more="docs"><span>Documentation</span></button>' +
            '<button class="pop-row" role="menuitem" data-more="issue"><span>Report Issue</span></button>' +
          '</div>' +
        '</header>' +
        '<nav class="gx-tabs" role="tablist">' +
          '<button class="gx-tab" id="tabSession" role="tab" aria-selected="true" aria-controls="viewSession">' +
            '<span class="lbl9">Session</span></button>' +
          '<button class="gx-tab" id="tabDiag" role="tab" aria-selected="false" aria-controls="viewDiag">' +
            '<span class="lbl9">Diagnostics</span><span class="n" id="tabDot" hidden></span></button>' +
        '</nav>' +
        '<div class="gx-banner" id="planBanner" hidden>' +
          '<span class="dot"></span><span class="lbl9 l">Plan phase</span>' +
          '<span class="m">read-only · no edits applied</span>' +
        '</div>' +
        '<section class="view" id="viewSession" role="tabpanel" aria-labelledby="tabSession">' +
          '<div class="turn-title" id="turnTitle" hidden></div>' +
          '<div id="log" aria-live="polite"></div>' +
          '<div class="chg-strip" id="chgStrip" data-open="0" hidden>' +
            '<div class="chg-head">' +
              '<button class="chg-toggle" id="chgToggle" aria-expanded="false">' +
                icon("i-chev", "ic-8 chev") + icon("i-diff", "ic-11") +
                '<span class="t" id="chgTitle">0 files changed</span>' +
                '<span class="s" id="chgStat"></span>' +
              '</button>' +
              '<button class="chg-clear" id="chgClear" title="Clear the list. The files are not touched." aria-label="Clear the change list">' + icon("i-x", "ic-9") + '</button>' +
            '</div>' +
            '<div class="chg-list" id="chgList" hidden></div>' +
          '</div>' +
          '<div class="composer-wrap" id="modeAnchor">' +
            '<div class="tip-row" id="tipRow">' +
              '<span class="k">Tip</span>' +
              '<span class="tx">Type <b>/</b> for a command, <b>@</b> to reference a file.</span><span class="sp"></span>' +
              '<button class="x" id="tipX" title="Dismiss" aria-label="Dismiss tip">' + icon("i-x", "ic-9") + '</button>' +
            '</div>' +
            '<div class="qp" id="qp" role="listbox" hidden></div>' +
            '<div id="modeSheet"></div>' +
            '<div class="composer">' +
              '<div class="sel-pill" id="selPill" hidden>' + icon("i-file", "ic-13") +
                '<span id="selText"></span><span class="sp"></span>' +
                '<button class="tb-btn" id="selClear" title="Dismiss selection" aria-label="Dismiss selection" style="width:18px;height:18px">' + icon("i-x", "ic-9") + '</button>' +
              '</div>' +
              '<div class="att-strip" id="attachStrip" hidden></div>' +
              '<textarea id="draft" rows="1" aria-label="Message" placeholder="Ask Genesis anything…"></textarea>' +
              '<div class="toolbar">' +
                '<div class="seg" id="phaseSeg" role="radiogroup" aria-label="Phase">' +
                  '<button data-phase="plan" data-on="0" title="Plan — read-only, proposes before acting">Plan</button>' +
                  '<button data-phase="act" data-on="1" title="Act — makes changes directly">Act</button>' +
                '</div>' +
                '<div class="model-wrap">' +
                  '<button id="modelBtn" aria-haspopup="listbox" aria-expanded="false">' +
                    '<span class="dot"></span><span class="nm ell" id="modelName">No model</span>' +
                    icon("i-caret", "ic-8 caret") +
                  '</button>' +
                '</div>' +
                '<span class="sp"></span>' +
                '<button class="mode-btn" id="modeBtn" aria-haspopup="dialog" aria-expanded="false" title="Select mode — what Genesis may do without asking">Ask</button>' +
                '<button class="tb-btn" id="atBtn" title="Reference a file" aria-label="Reference a file">@</button>' +
                '<button class="tb-btn" id="clipBtn" title="Attach files" aria-label="Attach files">' + icon("i-clip", "ic-13") + '</button>' +
                '<button id="sendBtn" data-ready="0" data-mode="send" title="Send" aria-label="Send">' + icon("i-up", "ic-13") + '</button>' +
              '</div>' +
            '</div>' +
          '</div>' +
        '</section>' +
        '<section class="view" id="viewDiag" role="tabpanel" aria-labelledby="tabDiag" hidden>' +
          '<button class="cc-card" id="ccBtn">' + roundel(19, "roundel", "full") +
            '<span class="col"><span class="t">Control Center</span>' +
            '<span class="s">Profiles · wire formats · auth · mTLS · proxy · checkpoints</span></span>' +
            icon("i-chev", "ic-9") + '</button>' +
          sectionShell("secTls", "TLS diagnostics", "tlsBadge", "tlsBody", true) +
          sectionShell("secEp", "Endpoints", "epBadge", "epBody", false) +
          sectionShell("secSk", "Skills", "skBadge", "skBody", false) +
        '</section>' +
        /* Sibling of the tab panels, not a child of the header: the scrim is
           position:absolute and would otherwise resolve against the 42px
           header box, clipping the dialog into the title bar. */
        '<div id="histModal"></div>' +
      '</div>';
    logEl = $("log");
  }

  function sectionShell(secId, label, badgeId, bodyId, open) {
    return '<div class="sec" id="' + secId + '" data-open="' + (open ? 1 : 0) + '">' +
      '<button class="sec-head" data-sec="' + secId + '" aria-expanded="' + open + '">' +
      icon("i-chev", "ic-8 chev") + '<span class="lbl9">' + label + '</span><span class="sp"></span>' +
      '<span class="badge" id="' + badgeId + '">—</span></button>' +
      '<div class="sec-body" id="' + bodyId + '"' + (open ? "" : " hidden") + '></div></div>';
  }

  /* ─────────────────────────── popovers / modals ─────────────────────────── */

  function closePops() {
    $("morePop").hidden = true;
    $("moreBtn").setAttribute("aria-expanded", "false");
  }

  function openHistory() {
    S.histOpen = true;
    S.histQuery = "";
    post("listSessions");
    renderHistory();
    setTimeout(function () { var i = $("histSearch"); if (i) i.focus(); }, 0);
  }
  function closeHistory() {
    S.histOpen = false;
    $("histModal").innerHTML = "";
    $("histBtn").setAttribute("aria-expanded", "false");
  }

  function renderHistory() {
    var wrap = $("histModal");
    if (!S.histOpen) { wrap.innerHTML = ""; return; }
    $("histBtn").setAttribute("aria-expanded", "true");

    var q = S.histQuery.trim().toLowerCase();
    var list = S.sessions.filter(function (s) {
      return !q || (s.title || "").toLowerCase().indexOf(q) >= 0;
    });

    var rows = "";
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      var n = s.count === 1 ? "1 message" : (s.count || 0) + " messages";
      rows += '<div class="hist-row" data-on="' + (s.active ? "1" : "0") + '">' +
        '<button class="pop-row" role="option" data-session="' + esc(s.id) + '">' +
          '<span class="hist-dot"></span>' +
          '<span class="ell"><span class="hist-t ell">' + esc(s.title) + '</span>' +
          '<span class="hist-m">' + esc(s.when) + ' · ' + n + '</span></span>' +
        '</button>' +
        '<button class="hist-del" data-del="' + esc(s.id) + '" title="Delete session" aria-label="Delete session">' +
          icon("i-trash", "ic-13") + '</button></div>';
    }

    wrap.innerHTML =
      '<div class="scrim" id="histScrim">' +
        '<div role="dialog" aria-modal="true" aria-label="Conversation history" class="modal" id="histDialog">' +
          '<div class="modal-head"><span class="lbl9">History</span><span class="sp"></span>' +
            '<span class="mono" style="font-size:9px;letter-spacing:.1em;color:var(--steel)">' + S.sessions.length + '</span>' +
            '<button class="modal-close" id="histClose" aria-label="Close history">' + icon("i-x", "ic-9") + '</button></div>' +
          '<div class="modal-search">' + icon("i-search", "ic-12") +
            '<input id="histSearch" type="text" aria-label="Search conversations" placeholder="Search conversations" value="' + esc(S.histQuery) + '"></div>' +
          '<div class="modal-body">' + (rows || '<div class="modal-empty">No conversation matches that.</div>') + '</div>' +
        '</div>' +
      '</div>';

    $("histScrim").addEventListener("click", function (e) { if (e.target === this) closeHistory(); });
    $("histDialog").addEventListener("click", function (e) { e.stopPropagation(); });
    $("histClose").addEventListener("click", closeHistory);
    $("histSearch").addEventListener("input", function (e) { S.histQuery = e.target.value; renderHistory(); setTimeout(function () { var i = $("histSearch"); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }, 0); });
    wrap.querySelector(".modal-body").addEventListener("click", function (e) {
      var del = e.target.closest("[data-del]");
      if (del) { e.stopPropagation(); post("deleteSession", { id: del.getAttribute("data-del") }); return; }
      var b = e.target.closest("[data-session]");
      if (!b) return;
      closeHistory();
      post("loadSession", { id: b.getAttribute("data-session") });
    });
  }

  function openModeSheet() {
    S.modeSheetOpen = true;
    renderModeSheet();
  }
  function closeModeSheet() {
    S.modeSheetOpen = false;
    $("modeSheet").innerHTML = "";
    $("modeBtn").setAttribute("aria-expanded", "false");
  }
  function renderModeSheet() {
    var wrap = $("modeSheet");
    if (!S.modeSheetOpen) { wrap.innerHTML = ""; return; }
    $("modeBtn").setAttribute("aria-expanded", "true");
    var current = S.config.approvalMode;
    var rows = "";
    for (var i = 0; i < MODES.length; i++) {
      var m = MODES[i];
      var on = m.v === current;
      rows += '<button type="button" role="radio" aria-checked="' + on + '" data-mode="' + m.v + '" class="mode-row">' +
        icon(m.icon, "ic-16") +
        '<span><span class="lbl">' + esc(m.label) + '</span><span class="ds">' + esc(m.desc) + '</span></span>' +
        '<span class="mode-ring"><span class="mode-dot"></span></span></button>';
    }
    wrap.innerHTML =
      '<div class="mode-sheet" id="modeScrim"><div class="mode-panel" role="dialog" aria-modal="true" aria-label="Select mode" id="modePanel">' +
        '<div class="mode-grab"><i></i></div>' +
        '<div class="mode-head">' +
          '<button class="modal-close" id="modeClose" aria-label="Close" style="position:absolute;left:12px;top:6px;width:28px;height:28px">' + icon("i-x", "ic-15") + '</button>' +
          '<div class="t">Select mode</div><div class="s">Choose how Genesis should work</div>' +
        '</div>' + rows +
      '</div></div>';
    $("modeScrim").addEventListener("click", function (e) { if (e.target === this) closeModeSheet(); });
    $("modePanel").addEventListener("click", function (e) { e.stopPropagation(); });
    $("modeClose").addEventListener("click", closeModeSheet);
    wrap.querySelector(".mode-panel").addEventListener("click", function (e) {
      var b = e.target.closest("[data-mode]");
      if (!b) return;
      var v = b.getAttribute("data-mode");
      S.config.approvalMode = v;
      post("setConfig", { key: "approvalMode", value: v });
      closeModeSheet();
      syncComposer();
    });
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

  /* ─────────────────── transcript primitives ─────────────────── */

  function atBottom() {
    return logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 40;
  }
  function scroll() { logEl.scrollTop = logEl.scrollHeight; }
  function add(el) {
    var stick = atBottom();
    var welcome = logEl.querySelector(".welcome");
    if (welcome) welcome.remove();
    logEl.appendChild(el);
    /* The streaming row is created the moment a turn starts, so everything
       appended afterwards would otherwise stack *below* it and leave
       "Thinking…" stranded above the work it describes. Keep it trailing. */
    if (streamEl && el !== streamEl) logEl.appendChild(streamEl);
    if (stick) scroll();
    return el;
  }
  function clearTranscript() {
    logEl.innerHTML = "";
    aiEl = null; streamEl = null; pendingTool = null; todoEl = null; stepsEl = null;
  }

  function renderTurnTitle() {
    var el = $("turnTitle");
    if (S.tab !== "session" || !S.sessionTitle || logEl.querySelector(".welcome")) { el.hidden = true; return; }
    el.textContent = S.sessionTitle;
    el.hidden = false;
  }

  function renderWelcome() {
    clearTranscript();
    $("turnTitle").hidden = true;
    var body;
    if (!S.workspace.open) {
      body = roundel(46, "roundel", "full") +
        '<span class="word">GENESIS</span>' +
        '<span class="line">Open a folder to use Genesis. It reads endpoint profiles and skills from the folder you have open, and edits files inside it.</span>';
    } else if (!hasEndpoint()) {
      body = roundel(46, "roundel", "full") +
        '<span class="word">GENESIS</span>' +
        '<span class="line">No endpoint configured. Genesis works against endpoint profiles defined in .agent/endpoints/.</span>' +
        '<div class="starter-list">' +
          '<button class="starter-row" data-act="newEndpoint">' + icon("i-file", "ic-11") + '<span class="t">Create endpoint profile</span></button>' +
          '<button class="starter-row" data-act="ccEndpoints">' + icon("i-file", "ic-11") + '<span class="t">Open Control Center</span></button>' +
        '</div>';
    } else {
      body = roundel(34, "roundel", "full") +
        '<span class="word">GENESIS</span>' +
        '<span class="line">Connected and ready. Ask anything, or pick a starting point.</span>' +
        '<span class="lbl9" style="color:var(--steel);margin-bottom:8px">Try</span>' +
        '<div class="starter-list">' +
          '<button class="starter-row" data-sug="Add retry logic to fetch_json()">' + icon("i-file", "ic-11") + '<span class="t">Add retry logic to fetch_json()</span>' + icon("i-chev", "ic-8") + '</button>' +
          '<button class="starter-row" data-sug="Write tests for api.py">' + icon("i-file", "ic-11") + '<span class="t">Write tests for api.py</span>' + icon("i-chev", "ic-8") + '</button>' +
          '<button class="starter-row" data-act="doctor">' + icon("i-file", "ic-11") + '<span class="t">Run TLS diagnostics</span>' + icon("i-chev", "ic-8") + '</button>' +
        '</div>';
      if (S.sessions.length) {
        var rows = "";
        for (var i = 0; i < Math.min(4, S.sessions.length); i++) {
          var r = S.sessions[i];
          rows += '<button class="recent-row" data-session="' + esc(r.id) + '"><span class="dot"></span>' +
            '<span class="t ell">' + esc(r.title) + '</span><span class="ago">' + esc(r.when) + '</span></button>';
        }
        body += '<div class="recent-block">' +
          '<div style="display:flex;align-items:baseline;gap:8px;margin-bottom:8px">' +
            '<span class="lbl9" style="color:var(--steel)">Recent</span><span class="sp"></span>' +
            '<button class="btn-text steel" id="recentAll" style="font-size:9px">All</button></div>' +
          '<div style="border-top:1px solid var(--slate)">' + rows + '</div></div>';
      }
    }
    logEl.appendChild(div("welcome", body));
    var all = $("recentAll");
    if (all) all.addEventListener("click", openHistory);
    var recentRows = logEl.querySelectorAll(".recent-row");
    for (var j = 0; j < recentRows.length; j++) {
      recentRows[j].addEventListener("click", function () { post("loadSession", { id: this.getAttribute("data-session") }); });
    }
  }

  function addUser(content) {
    var html;
    if (typeof content === "string") {
      html = '<span class="tx">' + esc(content) + "</span>";
    } else if (Array.isArray(content)) {
      var parts = "";
      for (var i = 0; i < content.length; i++) {
        var b = content[i];
        if (b.type === "image") {
          parts += '<img class="msg-img" src="data:' + esc(b.mediaType) + ';base64,' + b.data + '" alt="attached image">';
        } else if (b.type === "text") {
          parts += "<span>" + esc(b.text) + "</span>";
        }
      }
      html = '<span class="tx">' + parts + "</span>";
    } else {
      html = '<span class="tx">' + esc(String(content)) + "</span>";
    }
    add(div("msg-user", '<span class="rail"></span>' + html));
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

  /* ───────────────────────── tool steps ───────────────────────── */

  function stepsWrap() {
    if (!stepsEl) {
      aiEl = null;
      stepsEl = add(div("steps-wrap"));
      stepsEl.setAttribute("data-open", "1");
      stepsEl.innerHTML =
        '<button class="steps-head" type="button">' + icon("i-chev", "ic-8 chev") +
          '<span class="cnt">0 steps</span><span class="sp"></span><span class="time"></span></button>' +
        '<div class="steps-body"></div>';
      stepsEl.querySelector(".steps-head").addEventListener("click", function () {
        var open = stepsEl.getAttribute("data-open") === "1";
        stepsEl.setAttribute("data-open", open ? "0" : "1");
        stepsEl.querySelector(".steps-body").hidden = open;
      });
      stepsEl._n = 0;
      stepsEl._t0 = Date.now();
    }
    return stepsEl;
  }

  function toolStart(name, args) {
    aiEl = null;
    var wrap = stepsWrap();
    var body = wrap.querySelector(".steps-body");
    var row = div("step-row");
    row.innerHTML =
      '<button type="button" class="step-line" data-live="1">' +
        '<span class="step-spin">' + roundel(10, "", "notch") + '</span>' +
        '<span class="verb">' + esc(TOOL_VERB[name] || name) + '</span>' +
        '<span class="arg ell">' + pathParts(argOf(name, args)) + '</span>' +
      '</button><div class="step-dump" hidden></div>';
    row.querySelector(".step-line").addEventListener("click", function () {
      var d = row.querySelector(".step-dump");
      if (!d.textContent) return;
      d.hidden = !d.hidden;
    });
    body.appendChild(row);
    wrap._n++;
    wrap.querySelector(".cnt").textContent = wrap._n + (wrap._n === 1 ? " step" : " steps");
    pendingTool = row;
    S.gerund = GERUND[name] || "Thinking…";
    tickGerund();
    return row;
  }

  function toolEnd(name, args, result, isError) {
    var row = pendingTool;
    pendingTool = null;
    if (!row) row = toolStart(name, args);
    var line = row.querySelector(".step-line");
    line.removeAttribute("data-live");
    var spin = line.querySelector(".step-spin");
    if (spin) spin.remove();
    var mark = document.createElement("span");
    mark.className = "ok" + (isError ? " fail" : "");
    mark.textContent = isError ? "✕" : "✓";
    line.insertBefore(mark, line.firstChild);

    var text = result == null ? "" : String(result);
    var dump = row.querySelector(".step-dump");
    if (text) {
      dump.textContent = text.length > INLINE_LIMIT ? text.slice(0, INLINE_LIMIT) + "\n… truncated for display" : text;
    }
    if (text.length > MODEL_TRUNCATION) {
      var note = div("trunc-note", icon("i-warn", "ic-11") + "<span>Output truncated to 60,000 characters for the model</span>");
      row.appendChild(note);
    }
    if (isError) dump.hidden = false;

    var wrap = stepsEl;
    if (wrap) wrap.querySelector(".time").textContent = ((Date.now() - wrap._t0) / 1000).toFixed(1) + "s";
    S.gerund = "Thinking…";
    tickGerund();
  }

  /* ───────────────────────── diff cards ───────────────────────── */

  function parsePatch(patch) {
    var rows = [], oldN = 0, newN = 0, started = false, prevEnd = 1;
    var lines = String(patch).split("\n");
    for (var i = 0; i < lines.length; i++) {
      var raw = lines[i];
      var hunk = raw.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,\d+)? @@/);
      if (hunk) {
        var start = Number(hunk[1]);
        /* Never surface the raw `@@ -12,7 +12,7 @@` header — say how much
           context is being skipped instead. `prevEnd` is where the last hunk
           stopped, so the first boundary reads "N lines above" and every
           later one reads "N lines skipped". */
        var skipped = started ? start - prevEnd : start - 1;
        rows.push({
          kind: "hunk",
          text: skipped > 0
            ? skipped + (skipped === 1 ? " line " : " lines ") + (started ? "skipped" : "above")
            : "",
        });
        oldN = start; newN = Number(hunk[3]);
        prevEnd = start + (hunk[2] === undefined ? 1 : Number(hunk[2]));
        started = true;
        continue;
      }
      if (!started) continue;
      if (raw.charAt(0) === "\\") continue;
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

  /** Longest-common-subsequence word diff between one removed and one added
      line, so only the changed token gets the saturated highlight instead of
      tinting the whole line. Falls back to a plain span on any mismatch. */
  function wordDiffHtml(oldText, newText, cls) {
    var a = oldText.split(/(\s+)/), b = newText.split(/(\s+)/);
    var n = a.length, m = b.length;
    var dp = new Array(n + 1);
    for (var i = 0; i <= n; i++) dp[i] = new Array(m + 1).fill(0);
    for (i = n - 1; i >= 0; i--) {
      for (var j = m - 1; j >= 0; j--) {
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    var out = "", ii = 0, jj = 0;
    var pickFrom = cls === "del" ? a : b;
    var other = cls === "del" ? b : a;
    var oi = 0, oj = 0;
    while (oi < a.length || oj < b.length) {
      if (oi < a.length && oj < b.length && a[oi] === b[oj]) {
        out += esc(cls === "del" ? a[oi] : b[oj]);
        oi++; oj++;
      } else if (oj < b.length && (oi >= a.length || dp[oi][oj + 1] >= dp[oi + 1][oj])) {
        if (cls === "add") out += '<span class="wd">' + esc(b[oj]) + "</span>";
        oj++;
      } else if (oi < a.length) {
        if (cls === "del") out += '<span class="wd">' + esc(a[oi]) + "</span>";
        oi++;
      }
    }
    return out;
  }

  function addDiff(m) {
    aiEl = null;
    stepsEl = null;
    var rows = parsePatch(m.patch), body = "";
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r.kind === "hunk") {
        if (!r.text) continue; /* hunk starts at line 1 — nothing was skipped */
        body += '<div class="dl hunk"><span class="rail"></span><span class="g"></span><span class="g"></span><span class="m"></span>' +
          '<span class="c">' + esc(r.text) + "</span></div>";
        continue;
      }
      var content;
      if (r.kind === "del" && rows[i + 1] && rows[i + 1].kind === "add" &&
          (!rows[i - 1] || rows[i - 1].kind !== "del") && (!rows[i + 2] || rows[i + 2].kind !== "add")) {
        content = wordDiffHtml(r.text, rows[i + 1].text, "del");
      } else if (r.kind === "add" && rows[i - 1] && rows[i - 1].kind === "del" &&
          (!rows[i - 2] || rows[i - 2].kind !== "del") && (!rows[i + 1] || rows[i + 1].kind !== "add")) {
        content = wordDiffHtml(rows[i - 1].text, r.text, "add");
      } else {
        content = esc(r.text);
      }
      var mark = r.kind === "add" ? "+" : r.kind === "del" ? "−" : "";
      body += '<div class="dl ' + r.kind + '">' +
        '<span class="rail"></span>' +
        '<span class="g">' + (r.oldNo == null ? "" : r.oldNo) + "</span>" +
        '<span class="g">' + (r.newNo == null ? "" : r.newNo) + "</span>" +
        '<span class="m">' + mark + "</span>" +
        '<span class="c">' + content + "</span></div>";
    }

    var card = div("diff-wrap");
    card.setAttribute("data-open", "1");
    card.innerHTML =
      '<div class="diff-head">' +
        '<button type="button" class="chev-btn" aria-label="Collapse diff">' + icon("i-chev", "ic-8 chev") + '</button>' +
        '<span class="f">' + pathParts(m.file) + '</span>' +
        '<span class="add">+' + m.added + '</span><span class="del">−' + m.removed + '</span>' +
      '</div>' +
      '<div class="diff-body"><div class="diff-rows">' + body + '</div></div>' +
      (m.truncated ? '<div class="trunc-note" style="margin:6px 0 0">' + icon("i-warn", "ic-11") + "<span>Patch truncated at 30,000 characters</span></div>" : "") +
      '<div class="diff-actions">' + roundel(14, "roundel", "full") +
        '<span class="stat">' + m.added + ' addition' + (m.added === 1 ? "" : "s") + ' · ' + m.removed + ' deletion' + (m.removed === 1 ? "" : "s") + '</span>' +
        '<button type="button" class="btn-line" data-diff="accept">Accept</button>' +
        '<button type="button" class="btn-text" data-diff="reject">Reject</button>' +
        '<button type="button" class="btn-text" data-diff="view">Open diff</button></div>';

    card.dataset.turn = m.turnId;
    card.dataset.file = m.file;
    card.querySelector(".chev-btn").addEventListener("click", function () {
      var open = card.getAttribute("data-open") === "1";
      card.setAttribute("data-open", open ? "0" : "1");
      card.querySelector(".diff-body").hidden = open;
    });
    card.addEventListener("click", function (e) {
      var b = e.target.closest("[data-diff]");
      if (!b) return;
      var action = b.getAttribute("data-diff");
      if (action === "view") { post("openFile", { path: m.file }); return; }
      post("resolveDiff", { turnId: m.turnId, file: m.file, decision: action });
    });
    add(card);
    trackChangedFile(m.file, m.added, m.removed);
  }

  function resolveDiffCard(turnId, file, decision) {
    var cards = logEl.querySelectorAll(".diff-wrap");
    for (var i = 0; i < cards.length; i++) {
      var c = cards[i];
      if (c.dataset.turn !== turnId || c.dataset.file !== file) continue;
      var foot = c.querySelector(".diff-actions");
      if (!foot) return;
      foot.replaceWith(div("diff-resolved", decision === "accept"
        ? "Applied to " + esc(file) + " · checkpoint saved"
        : "Rejected · " + esc(file) + " restored from checkpoint"));
      return;
    }
  }

  /* ─────────────────── changed-files strip ─────────────────── */

  function trackChangedFile(path, added, removed) {
    var existing = null;
    for (var i = 0; i < S.changedFiles.length; i++) {
      if (S.changedFiles[i].path === path) { existing = S.changedFiles[i]; break; }
    }
    if (existing) { existing.added = added; existing.removed = removed; }
    else S.changedFiles.push({ path: path, added: added, removed: removed });
    renderChangedFiles();
  }
  function onFileTouched(path) {
    for (var i = 0; i < S.changedFiles.length; i++) if (S.changedFiles[i].path === path) return;
    S.changedFiles.push({ path: path, added: null, removed: null });
    renderChangedFiles();
  }
  function renderChangedFiles() {
    var strip = $("chgStrip");
    if (!S.changedFiles.length) { strip.hidden = true; return; }
    strip.hidden = false;
    strip.setAttribute("data-open", S.chgOpen ? "1" : "0");
    $("chgToggle").setAttribute("aria-expanded", S.chgOpen ? "true" : "false");
    $("chgTitle").textContent = S.changedFiles.length + (S.changedFiles.length === 1 ? " file changed" : " files changed");
    var addT = 0, delT = 0;
    for (var i = 0; i < S.changedFiles.length; i++) { addT += S.changedFiles[i].added || 0; delT += S.changedFiles[i].removed || 0; }
    $("chgStat").innerHTML = (addT || delT) ? '<span style="color:var(--green)">+' + addT + '</span> <span style="color:var(--red-400)">−' + delT + '</span>' : "";
    var list = $("chgList");
    list.hidden = !S.chgOpen;
    var rows = "";
    for (var j = 0; j < S.changedFiles.length; j++) {
      var f = S.changedFiles[j];
      rows += '<button type="button" class="chg-row" data-file="' + esc(f.path) + '"><span class="m">M</span>' +
        '<span class="f">' + esc(f.path) + '</span>' +
        '<span class="s">' + (f.added != null ? '<span style="color:var(--green)">+' + f.added + '</span> <span style="color:var(--red-400)">−' + f.removed + '</span>' : "") + '</span></button>';
    }
    list.innerHTML = rows;
  }

  /* ───────────────────── todo / permission ───────────────────── */

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
      var isActive = !isDone && !activeMarked && (t.status === "in_progress" || !anyInProgress);
      if (isActive) activeMarked = true;
      var color = isDone ? "var(--steel)" : isActive ? "var(--cream)" : "var(--fog)";
      var weight = isActive ? "600" : "400";
      items += '<li><span class="rule" style="background:' + (isDone ? "var(--green)" : isActive ? "var(--oxide)" : "var(--slate)") + '"></span>' +
        '<button type="button">' +
          '<span class="gl">' + (isDone ? "✓" : "") + '</span>' +
          '<span class="tx" style="color:' + color + ';font-weight:' + weight + '">' + esc(t.content) + '</span>' +
        '</button></li>';
    }
    var pct = Math.round((done / S.todos.length) * 100);
    var html =
      '<div class="todos-head"><span class="lbl9" style="color:var(--steel)">Todos</span>' +
      '<span class="n">' + done + "/" + S.todos.length + "</span>" +
      '<span class="bar"><i style="width:' + pct + '%"></i></span></div>' +
      '<ul class="todo-list">' + items + "</ul>";

    if (todoEl) { todoEl.innerHTML = html; return; }
    aiEl = null;
    todoEl = add(div("todos", html));
  }

  function addPermission(m) {
    aiEl = null;
    var el = add(div("perm-gate",
      '<div class="lbl9">Permission required</div>' +
      '<div class="row"><span class="cmd">' + esc(m.summary) + '</span>' +
        '<span class="actions">' +
          '<button type="button" class="btn-line" data-perm="allow">Allow once</button>' +
          '<button type="button" class="always" data-perm="always">Always allow</button>' +
          '<button type="button" class="always" data-perm="deny">Deny</button>' +
        '</span></div>' +
      (m.detail ? '<div class="perm-detail">' + esc(String(m.detail).slice(0, 4000)) + '</div>' : "")));
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
      el.innerHTML =
        '<span class="k ' + (decision === "deny" ? "deny" : "allow") + '">' + (decision === "deny" ? "Denied" : "Allowed") + '</span>' +
        '<span class="tx">' + esc(label) + '</span>';
      return;
    }
  }

  /* ───────────────────── streaming indicator ───────────────────── */

  function startStream() {
    if (!streamEl) {
      streamEl = add(div("stream-row",
        '<span class="mark"><span class="base">' + roundel(20, "", "dim") + '</span><span class="idx">' + roundel(20, "", "notch") + '</span></span>' +
        '<span class="col"><span class="verb"></span><span class="hint">Working · <b>esc</b> to interrupt</span></span>' +
        '<span class="meter tnum"></span>'));
      streamEl.setAttribute("role", "status");
      streamEl.setAttribute("aria-live", "polite");
      S.elapsed = 0;
    }
    tickGerund();
    if (!S.timer) S.timer = setInterval(function () { S.elapsed++; tickGerund(); }, 1000);
  }
  function tickGerund() {
    if (!streamEl) return;
    streamEl.querySelector(".verb").textContent = S.gerund;
    var used = S.context ? S.context.used : 0;
    streamEl.querySelector(".meter").textContent = S.elapsed + "s · " + fmtK(used);
  }
  function endStream() {
    if (S.timer) { clearInterval(S.timer); S.timer = null; }
    var finalElapsed = S.elapsed;
    if (streamEl) { streamEl.remove(); streamEl = null; }
    S.gerund = "Thinking…";
    var used = S.context ? S.context.used : 0;
    add(div("idle-row", roundel(20, "roundel", "dim") +
      '<span class="lbl9">Finished</span><span class="meter tnum">' + finalElapsed + "s · " + fmtK(used) + "</span>"));
  }

  /* ───────────────────────── composer ───────────────────────── */

  function syncComposer() {
    var draft = $("draft");
    var blocked = !S.workspace.open || !hasEndpoint();
    draft.disabled = blocked;
    draft.placeholder = blocked
      ? "Configure an endpoint first…"
      : S.phase === "plan" ? "Describe what to plan…" : "Ask Genesis anything…";

    var send = $("sendBtn");
    if (S.running) {
      send.setAttribute("data-mode", "stop");
      send.setAttribute("data-ready", "0");
      send.title = "Interrupt"; send.setAttribute("aria-label", "Interrupt");
      send.innerHTML = icon("i-stop", "ic-11");
      send.disabled = false;
    } else {
      send.setAttribute("data-mode", "send");
      var hasContent = draft.value.trim() || (S.attachments && S.attachments.length);
      send.setAttribute("data-ready", !blocked && hasContent ? "1" : "0");
      send.title = "Send"; send.setAttribute("aria-label", "Send");
      send.innerHTML = icon("i-up", "ic-13");
      send.disabled = blocked;
    }
    $("atBtn").disabled = blocked;
    $("modelBtn").disabled = !hasEndpoint();
    var mv = S.config.approvalMode || "ask";
    $("modeBtn").innerHTML = icon(MODE_ICON[mv] || "i-hand", "ic-11") +
      "<span>" + esc(MODE_SHORT[mv] || "Ask") + "</span>";
    $("modeBtn").title = "Approvals: " + (MODE_SHORT[mv] || "Ask") +
      " — what Genesis may run without stopping to ask. Not the same as the Plan/Act phase.";

    draft.style.height = "auto";
    var natural = draft.scrollHeight;
    draft.style.height = Math.min(Math.max(natural, 52), 168) + "px";
    draft.style.overflow = natural > 168 ? "auto" : "hidden";
  }

  function detectQuickPick() {
    if (S.modelOpen) return;
    var v = $("draft").value;
    if (/^\/[^\s]*$/.test(v)) {
      S.qp = { kind: "cmd", q: v.slice(1) };
    } else {
      var m = v.match(/(?:^|\s)@([\w./-]*)$/);
      if (m) { S.qp = { kind: "file", q: m[1] }; scheduleSearch(m[1]); }
      else S.qp = null;
    }
    S.qpIndex = 0;
    renderQuickPick();
  }

  function scheduleSearch(query) {
    if (S.searchTimer) clearTimeout(S.searchTimer);
    S.searchTimer = setTimeout(function () { S.fileQuery = query; post("searchFiles", { query: query }); }, 150);
  }

  function qpItems() {
    if (S.modelOpen) {
      var rows = [];
      var current = activeProfile();
      for (var i = 0; i < S.models.length; i++) {
        var g = S.models[i];
        rows.push({ group: g.group });
        for (var j = 0; j < g.models.length; j++) {
          rows.push({ endpoint: g.group, model: g.models[j], active: Boolean(current && current.id === g.group) });
        }
      }
      return rows;
    }
    if (!S.qp) return [];
    var q = S.qp.q.toLowerCase();
    if (S.qp.kind === "cmd") {
      return CMDS.filter(function (c) { return c[0].slice(1).indexOf(q) === 0; }).map(function (c) { return { cmd: c[0], desc: c[1] }; });
    }
    return S.files.map(function (f) { return { file: f.path, badge: f.kind }; });
  }

  function renderQuickPick() {
    var qp = $("qp");
    if (S.modelOpen) { renderModelPop(); qp.hidden = true; return; }
    $("modelBtn").setAttribute("aria-expanded", "false");
    $("modelBtn").querySelector(".model-pop") && 0;
    var mp = document.getElementById("modelPop");
    if (mp) mp.remove();

    var items = qpItems();
    var selectable = items.filter(function (r) { return !r.group; });
    if (!items.length) {
      if (S.qp && S.qp.kind === "file") { qp.innerHTML = '<div class="qp-empty">No matching files</div>'; qp.hidden = false; }
      else qp.hidden = true;
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
          icon("i-term", "ic-13") + '<span class="n">' + esc(r.cmd) + "</span><span class=\"d ell\">" + esc(r.desc) + "</span></button>";
      } else if (r.file) {
        html += '<button class="qp-row" role="option" data-active="' + on + '" data-i="' + idx + '">' +
          icon("i-file", "ic-13") + '<span class="n ell">@' + esc(r.file) + "</span><span class=\"d\">" + esc(r.badge) + "</span></button>";
      }
    }
    qp.innerHTML = html;
    qp.hidden = false;
    var active = qp.querySelector('[data-active="1"]');
    if (active && active.scrollIntoView) active.scrollIntoView({ block: "nearest" });
  }

  function renderModelPop() {
    var wrap = $("modeAnchor");
    var mp = document.getElementById("modelPop");
    if (mp) mp.remove();
    var current = activeProfile();
    var rows = "";
    for (var i = 0; i < S.models.length; i++) {
      var g = S.models[i];
      for (var j = 0; j < g.models.length; j++) {
        var on = Boolean(current && current.id === g.group);
        var idx = rows.split('data-i="').length - 1;
        rows += '<button type="button" class="model-opt" role="option" aria-selected="' + on + '" data-i="' + idx + '">' +
          '<span class="dot"></span><span class="col"><span class="nm">' + esc(g.models[j]) + '</span><span class="note">' + esc(g.group) + '</span></span></button>';
      }
    }
    var pop = div("model-pop");
    pop.id = "modelPop";
    pop.setAttribute("role", "listbox");
    pop.innerHTML = '<div class="model-pop-head">Model</div>' + (rows || '<div class="qp-empty">No endpoints configured</div>');
    wrap.appendChild(pop);
    $("modelBtn").setAttribute("aria-expanded", "true");
    pop.addEventListener("click", function (e) {
      var b = e.target.closest("[data-i]");
      if (!b) return;
      S.qpIndex = Number(b.getAttribute("data-i"));
      acceptQuickPick();
    });
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
      case "/clear": draft.value = ""; post("newChat"); break;
      case "/doctor": draft.value = ""; setTab("diagnostics"); openSection("secTls"); post("runTrace"); break;
      case "/endpoints": draft.value = ""; setTab("diagnostics"); openSection("secEp"); renderEndpoints(); break;
      case "/model": draft.value = ""; S.modelOpen = true; S.qpIndex = 0; renderQuickPick(); return;
      case "/checkpoint": draft.value = ""; post("openControlCenter", { section: "checkpoints" }); break;
      case "/review": draft.value = ""; sendText(REVIEW_PROMPT); break;
      case "/skill:": {
        var names = S.skills.filter(function (s) { return s.enabled; }).map(function (s) { return s.name; });
        draft.value = "/skill:" + (names[0] || "");
        break;
      }
      case "/help": {
        draft.value = "";
        var lines = CMDS.map(function (c) { return c[0] + "  —  " + c[1]; }).join("\n");
        aiEl = null; stepsEl = null;
        add(div("note-box", esc("Available commands\n\n" + lines)));
        break;
      }
      default: draft.value = cmd + " ";
    }
  }

  function sendText(text) {
    var trimmed = String(text).trim();
    if (!trimmed) return;
    if (!S.workspace.open) { addError("Open a folder first."); return; }
    if (!hasEndpoint()) { addError("Select an endpoint profile first."); return; }
    if (S.running) { addError("Already working — interrupt first."); return; }
    addUser(trimmed);
    aiEl = null; stepsEl = null;
    S.gerund = S.phase === "plan" ? "Planning…" : "Thinking…";
    S.running = true;
    startStream();
    syncComposer();
    var payload = { text: trimmed };
    if (S.attachments && S.attachments.length) {
      payload.attachments = S.attachments.map(function (a) { return { name: a.name, mediaType: a.mediaType, data: a.data }; });
    }
    post("sendMessage", payload);
    S.attachments = [];
    renderAttachments();
  }

  function addError(message) {
    aiEl = null; stepsEl = null;
    add(div("err-box", esc(message)));
  }

  /* ───────────────────────── footer / model name ───────────────────────── */

  function renderFooter() {
    var active = activeProfile();
    var name = active ? active.id : "No endpoint";
    $("modelName").textContent = S.tlsError ? name + " — TLS error" : (active ? active.model : "No model");
    $("modelBtn").querySelector(".dot").style.background = S.tlsError ? "var(--red-400)" : "var(--oxide)";
  }

  /* ─────────────────────── diagnostics: TLS ─────────────────────── */

  function renderTls() {
    var e = S.tlsError;
    var badge = $("tlsBadge");
    badge.textContent = e ? "1" : S.traceRun ? "OK" : "—";
    badge.className = e ? "badge alert" : "badge";
    $("tabDot").hidden = !e;
    if (e) $("tabDot").textContent = "1";

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
      html += '<div class="errc"><div class="errc-h">' + icon("i-x", "ic-14") + "TLS handshake failed" +
        '<span class="who">' + esc(e.profile) + "</span></div>" +
        '<div class="errc-raw">' + esc(e.message) + "</div>" +
        '<div class="errc-grid">' +
          '<span class="k">Endpoint</span><span class="v ell" title="' + esc(e.endpoint) + '">' + esc(e.endpoint) + "</span>" +
          (e.proxied ? "" :
            '<span class="k">Cert subject</span><span class="v ell">' + esc(e.certSubject || "—") + "</span>" +
            '<span class="k">Cert issuer</span><span class="v ell">' + esc(e.certIssuer || "—") + "</span>" +
            '<span class="k">TLS version</span><span class="v">' + esc(e.tlsVersion || "—") + "</span>") +
        "</div>" +
        (e.proxied ? '<div class="proxied-note">Certificate details unavailable — the failing certificate was presented inside the CONNECT tunnel.</div>' : "") +
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
        html += '<div class="tls-actions">' +
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
      '<span class="ms">' + (status === "pass" || status === "fail" || status === "warn" ? (ms ? ms + "ms" : "—") : "—") + "</span></div>";
  }

  /* ──────────────────── diagnostics: endpoints ──────────────────── */

  function renderEndpoints() {
    $("epBadge").textContent = String(S.profiles.length);
    var rows = "";
    for (var i = 0; i < S.profiles.length; i++) {
      var p = S.profiles[i];
      var iconId = p.status === "error" ? "i-warn" : (EP_ICON[p.wire] || "i-globe");
      rows += '<div class="trow" data-status="' + p.status + '">' +
        (iconId === "roundel"
          ? '<span style="color:var(--cream)">' + roundel(16, "", "full") + "</span>"
          : '<span style="color:var(--steel)">' + icon(iconId, "ic-14") + "</span>") +
        '<span class="ell"><span class="id ell">' + esc(p.id) + "</span>" +
        '<span class="url ell" title="' + esc(p.status === "error" ? p.error || "" : p.baseUrl) + '">' +
        esc(p.status === "error" ? (p.error || "Failed to parse") : p.baseUrl) + "</span></span>" +
        '<span class="acts">' +
          '<button class="mini" data-ep="edit" data-id="' + esc(p.id) + '" title="Edit endpoint" aria-label="Edit endpoint">' + icon("i-pencil", "ic-13") + "</button>" +
          '<button class="mini danger" data-ep="del" data-id="' + esc(p.id) + '" title="Delete endpoint" aria-label="Delete endpoint">' + icon("i-trash", "ic-13") + "</button>" +
        "</span></div>";
    }
    var html = rows ? '<div class="tbl">' + rows + "</div>" : '<div class="empty">No profiles in .agent/endpoints/</div>';
    html += '<div><button class="btn sm" data-ep="add">+ Add endpoint</button></div>';

    if (S.epForm) {
      var f = S.epForm;
      var types = ["anthropic", "openai-compatible", "azure", "local", "custom"], opts = "";
      for (var t = 0; t < types.length; t++) opts += '<option value="' + types[t] + '"' + (f.type === types[t] ? " selected" : "") + ">" + types[t] + "</option>";
      html += '<div class="form"><div class="t">' + (f.isNew ? "New endpoint" : "Edit endpoint") + "</div>" +
        '<div class="fgrid">' +
          '<label for="fId">id</label><input id="fId" value="' + esc(f.id) + '" placeholder="corp-gateway">' +
          '<label for="fName">name</label><input id="fName" value="' + esc(f.name) + '" placeholder="Corp Gateway">' +
          '<label for="fUrl">url</label><input id="fUrl" value="' + esc(f.url) + '" placeholder="https://llm.corp.example/v1">' +
          '<label for="fType">type</label><select id="fType">' + opts + "</select>" +
        "</div>" +
        '<div class="row"><button class="btn-text steel" data-ep="cancel">Cancel</button>' +
        '<button class="btn-line" data-ep="save">Save</button></div></div>';
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
      rows += '<button class="skill" data-src="' + esc(s.source) + '" data-on="' + (s.enabled ? "1" : "0") + '" data-skill="' + esc(s.name) +
        '" role="checkbox" aria-checked="' + (s.enabled ? "true" : "false") + '">' +
        '<span class="cbx">' + (s.enabled ? icon("i-check", "ic-9") : "") + "</span>" +
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
      (S.skillWarnings.length ? '<div class="warn-line">' + esc(S.skillWarnings.join(" ")) + "</div>" : "");
  }

  /* ───────────────────── session restore rendering ───────────────────── */

  function renderSession(messages) {
    clearTranscript();
    S.changedFiles = [];
    renderChangedFiles();
    if (!messages || !messages.length) { renderWelcome(); return; }

    var resultFor = {};
    for (var i = 0; i < messages.length; i++) {
      var m = messages[i];
      if (m.role === "tool" && m.toolCallId) resultFor[m.toolCallId] = textOf(m.content);
    }

    for (var j = 0; j < messages.length; j++) {
      var msg = messages[j];
      if (msg.role === "user") { addUser(msg.content); stepsEl = null; continue; }
      if (msg.role !== "assistant") continue;

      var body = textOf(msg.content);
      var calls = msg.toolCalls || [];
      if (calls.length) {
        stepsEl = null;
        for (var k = 0; k < calls.length; k++) {
          var call = calls[k];
          var row = toolStart(call.name, call.arguments);
          var line = row.querySelector(".step-line");
          line.removeAttribute("data-live");
          var spin = line.querySelector(".step-spin");
          if (spin) spin.remove();
          var ok = document.createElement("span");
          ok.className = "ok"; ok.textContent = "✓";
          line.insertBefore(ok, line.firstChild);
          var res = resultFor[call.id];
          if (res) row.querySelector(".step-dump").textContent = res.length > INLINE_LIMIT ? res.slice(0, INLINE_LIMIT) : res;
        }
      }
      if (body) { aiEl = null; stepsEl = null; appendAi(body); aiEl = null; }
    }
    scroll();
  }

  function textOf(content) {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content.filter(function (b) { return b && b.type === "text"; }).map(function (b) { return b.text; }).join("\n");
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
    S.sessionTitle = state.session ? state.session.title : "";

    applyPhase(S.phase, true);
    renderSession(state.session ? state.session.messages : []);
    todoEl = null;
    renderTodos(S.todos);
    renderTurnTitle();
    renderSelection();
    renderFooter();
    renderTls();
    renderEndpoints();
    renderSkills();
    syncComposer();
    if (S.running) startStream();
    S.hydrated = true;
  }

  function renderSelection() {
    var pill = $("selPill");
    if (!S.selection) { pill.hidden = true; return; }
    $("selText").textContent = "Selection: " + S.selection.file + " L" + S.selection.startLine + "–L" + S.selection.endLine;
    pill.hidden = false;
  }

  function renderAttachments() {
    var strip = $("attachStrip");
    if (!S.attachments || !S.attachments.length) { strip.hidden = true; strip.innerHTML = ""; return; }
    var html = "";
    for (var i = 0; i < S.attachments.length; i++) {
      var a = S.attachments[i];
      var isImg = a.mediaType.indexOf("image/") === 0;
      var size = a.size < 1024 ? a.size + " B" : a.size < 1048576 ? (a.size / 1024).toFixed(1) + " KB" : (a.size / 1048576).toFixed(1) + " MB";
      html += '<span class="att-pill" data-att="' + i + '">' +
        (isImg ? '<img class="att-thumb" src="data:' + esc(a.mediaType) + ';base64,' + a.data + '" alt="">' : icon("i-file", "ic-13")) +
        '<span class="att-name ell">' + esc(a.name) + '</span><span class="att-size">' + size + '</span>' +
        '<button class="att-x" data-att-rm="' + i + '" title="Remove" aria-label="Remove ' + esc(a.name) + '">' + icon("i-x", "ic-9") + '</button></span>';
    }
    strip.innerHTML = html;
    strip.hidden = false;
  }

  /* ───────────────────────── wiring ───────────────────────── */

  function wire() {
    $("newBtn").addEventListener("click", function () {
      closePops();
      post("newChat");
      $("draft").value = "";
      syncComposer();
      $("draft").focus();
    });
    $("histBtn").addEventListener("click", function (e) {
      e.stopPropagation();
      if (S.histOpen) closeHistory(); else { closePops(); openHistory(); }
    });
    $("moreBtn").addEventListener("click", function (e) {
      e.stopPropagation();
      var wasClosed = $("morePop").hidden;
      closePops();
      if (wasClosed) { $("morePop").hidden = false; $("moreBtn").setAttribute("aria-expanded", "true"); }
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
    document.addEventListener("click", function (e) {
      if (!e.target.closest(".gx-header")) closePops();
      if (S.modelOpen && !e.target.closest("#modelBtn") && !e.target.closest("#modelPop")) { S.modelOpen = false; renderQuickPick(); }
    });

    $("tabSession").addEventListener("click", function () { setTab("session"); renderTurnTitle(); });
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

    $("modeBtn").addEventListener("click", function (e) {
      e.stopPropagation();
      if (S.modeSheetOpen) closeModeSheet(); else openModeSheet();
    });

    $("chgToggle").addEventListener("click", function () { S.chgOpen = !S.chgOpen; renderChangedFiles(); });
    $("chgClear").addEventListener("click", function () { S.changedFiles = []; S.chgOpen = false; renderChangedFiles(); });
    $("chgList").addEventListener("click", function (e) {
      var b = e.target.closest("[data-file]");
      if (b) post("openFile", { path: b.getAttribute("data-file") });
    });
    $("tipX").addEventListener("click", function () { $("tipRow").hidden = true; });

    logEl.addEventListener("click", function (e) {
      var sug = e.target.closest("[data-sug]");
      if (sug) { sendText(sug.getAttribute("data-sug")); return; }
      var sess = e.target.closest(".welcome [data-session]");
      if (sess) { post("loadSession", { id: sess.getAttribute("data-session") }); return; }
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
      S.qp = null; S.qpIndex = 0;
      renderQuickPick();
    });
    $("atBtn").addEventListener("click", function () {
      draft.value += (draft.value && !/\s$/.test(draft.value) ? " " : "") + "@";
      draft.focus(); syncComposer(); detectQuickPick();
    });
    $("clipBtn").addEventListener("click", function () { post("attachFiles"); });
    $("attachStrip").addEventListener("click", function (e) {
      var btn = e.target.closest("[data-att-rm]");
      if (!btn) return;
      var idx = parseInt(btn.getAttribute("data-att-rm"), 10);
      if (!isNaN(idx) && S.attachments) { S.attachments.splice(idx, 1); renderAttachments(); syncComposer(); }
    });
    $("selClear").addEventListener("click", function () { S.selection = null; renderSelection(); });
    $("sendBtn").addEventListener("click", function () {
      if (S.running) { post("interrupt"); return; }
      sendText(draft.value);
      draft.value = ""; S.attachments = [];
      renderAttachments(); syncComposer();
    });

    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape") return;
      if (S.modeSheetOpen) { closeModeSheet(); return; }
      if (S.histOpen) { closeHistory(); return; }
      if (!$("qp").hidden || S.modelOpen) return;
      if (S.running) post("interrupt");
    });

    $("tlsBody").addEventListener("click", onTlsClick);
    $("epBody").addEventListener("click", onEpClick);
    $("skBody").addEventListener("click", onSkillClick);
  }

  function onDraftKey(e) {
    var draft = $("draft");
    var pickerOpen = !$("qp").hidden || S.modelOpen;
    if (pickerOpen) {
      var n = qpItems().filter(function (r) { return !r.group; }).length;
      if (n) {
        if (e.key === "ArrowDown") { e.preventDefault(); S.qpIndex = (S.qpIndex + 1) % n; renderQuickPick(); return; }
        if (e.key === "ArrowUp") { e.preventDefault(); S.qpIndex = (S.qpIndex - 1 + n) % n; renderQuickPick(); return; }
        if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); acceptQuickPick(); return; }
      }
      if (e.key === "Escape") { e.preventDefault(); S.qp = null; S.modelOpen = false; renderQuickPick(); return; }
    }
    if (e.key === "Tab" && e.shiftKey) { e.preventDefault(); applyPhase(S.phase === "plan" ? "act" : "plan"); return; }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendText(draft.value); draft.value = ""; syncComposer(); }
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
    else if (a === "saveCa") { post("saveCaBundle", { path: S.caUpload.path }); S.caUpload = null; renderTls(); }
    else if (a === "copy") {
      post("copyText", { text: '"' + S.tlsError.fixKey + '": "' + S.tlsError.fixValue + '"' });
      S.copied = true; renderTls();
      setTimeout(function () { S.copied = false; renderTls(); }, 1500);
    }
  }

  function onEpClick(e) {
    var b = e.target.closest("[data-ep]");
    if (!b) return;
    var a = b.getAttribute("data-ep"), id = b.getAttribute("data-id");
    if (a === "add") { S.epForm = { isNew: true, id: "", name: "", url: "", type: "openai-compatible" }; renderEndpoints(); }
    else if (a === "cancel") { S.epForm = null; renderEndpoints(); }
    else if (a === "edit") {
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
    } else if (a === "del") post("deleteEndpoint", { id: id });
    else if (a === "save") {
      var form = { id: $("fId").value.trim(), name: $("fName").value.trim(), url: $("fUrl").value.trim(), type: $("fType").value };
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
        if (S.skills[i].name === name) { S.skills[i].enabled = !S.skills[i].enabled; post("toggleSkill", { name: name, enabled: S.skills[i].enabled }); }
      }
      renderSkills();
      return;
    }
    var b = e.target.closest("[data-sk]");
    if (!b) return;
    if (b.getAttribute("data-sk") === "reload") {
      post("reloadSkills"); S.reloaded = true; renderSkills();
      setTimeout(function () { S.reloaded = false; renderSkills(); }, 1400);
    } else post("openSkillsFolder");
  }

  /* ───────────────────────── inbound ───────────────────────── */

  window.addEventListener("message", function (event) {
    var m = event.data;
    if (!m || !m.type) return;

    switch (m.type) {
      case "stateSync": hydrate(m.state); break;
      case "streamDelta": S.running = true; startStream(); appendAi(m.text); syncComposer(); break;
      case "toolStart": toolStart(m.tool.name, m.tool.args); break;
      case "toolEnd": toolEnd(m.tool.name, m.tool.args, m.tool.result, m.tool.isError); break;
      case "todosUpdated": renderTodos(m.todos); break;
      case "permissionRequest": addPermission(m); break;
      case "permissionResolved": resolvePermissionCard(m.id, m.decision); break;
      case "diffPending": addDiff(m); break;
      case "diffResolved": resolveDiffCard(m.turnId, m.file, m.decision); break;
      case "fileTouched": onFileTouched(m.path); break;
      case "turnEnd":
        S.running = false; endStream(); aiEl = null; stepsEl = null; pendingTool = null; syncComposer();
        break;
      case "error": addError(m.message); break;
      case "traceStarted": S.tracing = true; S.rungs = []; renderTls(); break;
      case "traceUpdate": S.tracing = true; S.rungs = S.rungs.slice(0, m.index).concat([m.rung]); renderTls(); break;
      case "traceDone": S.tracing = false; S.traceRun = true; S.rungs = m.rungs || []; renderTls(); break;
      case "tlsError": S.tlsError = m.error; renderTls(); renderFooter(); break;
      case "profilesReloaded":
        S.profiles = m.profiles || []; renderEndpoints(); renderFooter(); syncComposer();
        if (logEl.querySelector(".welcome")) renderWelcome();
        break;
      case "skillsReloaded": S.skills = m.skills || []; S.skillWarnings = m.warnings || []; renderSkills(); break;
      case "contextUsage": S.context = { used: m.used, limit: m.limit }; break;
      case "selectionChanged": S.selection = m.selection; renderSelection(); break;
      case "attachmentsReady":
        if (!S.attachments) S.attachments = [];
        for (var ai = 0; ai < m.files.length; ai++) S.attachments.push(m.files[ai]);
        renderAttachments(); syncComposer(); $("draft").focus();
        break;
      case "sessionSwitched":
        S.sessionId = m.id; S.sessionTitle = m.title; S.running = false; endStream();
        aiEl = null; stepsEl = null; todoEl = null; S.todos = []; S.context = null; S.attachments = [];
        renderSession(m.messages); renderTurnTitle(); renderAttachments(); renderTodos([]); syncComposer();
        break;
      case "sessionsListed": S.sessions = m.sessions || []; if (S.histOpen) renderHistory(); break;
      case "configChanged": S.config = m.config; syncComposer(); break;
      case "phaseChanged": applyPhase(m.phase, true); break;
      case "endpointChanged": S.endpoint = m.endpoint; renderFooter(); syncComposer(); break;
      case "statusChanged": break;
      case "caBundlePicked": if (S.caUpload) { S.caUpload.path = m.path; renderTls(); } break;
      case "fileResults":
        if (m.query !== S.fileQuery) break;
        S.files = m.files || []; S.qpIndex = 0; renderQuickPick();
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
}
