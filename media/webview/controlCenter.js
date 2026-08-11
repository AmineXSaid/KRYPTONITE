/* KRYPTONITE Control Center frontend. Plain DOM, zero dependencies.
 *
 * Ten sections over one shared store. Only the active section is rendered, so
 * a broadcast re-renders at most one pane. Three toggles are functional; the
 * rest are disabled indicators that reflect the active profile or fixed engine
 * behaviour - showing them as interactive would be a lie.
 *
 * crystal.js must have executed before this script runs so that
 * `window.__kxCrystal` is available. Both scripts load via `<script src>`
 * tags in the shell, which in a VS Code webview can race: the second tag
 * may start parsing before the first finishes executing. The guard below
 * polls for readiness rather than assuming sequential execution.
 */
(function _boot() {
  if (!window.__kxCrystal) {
    setTimeout(_boot, 5);
    return;
  }
  _run();
})();
function _run() {
(function () {
  "use strict";

  var api = window.__kx.api;

  /* ─────────────────────────── artwork ─────────────────────────── */

  /* The crystal artwork lives in crystal.js so both surfaces share one copy. */
  var CRYSTAL_DEFS = window.__kxCrystal.defs;

  var SW = 'stroke="currentColor" fill="none"';

  var ICON_DEFS =
    '<symbol id="i-refresh" viewBox="0 0 24 24"><path d="M20 12a8 8 0 11-2.4-5.7M20 3.5V9h-5.5" ' + SW + ' stroke-width="1.6"/></symbol>' +
    '<symbol id="i-check" viewBox="0 0 24 24"><path d="M4.5 12.5l5 5 10-11" ' + SW + ' stroke-width="2"/></symbol>' +
    '<symbol id="i-x" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" ' + SW + ' stroke-width="2"/></symbol>' +
    '<symbol id="i-warn" viewBox="0 0 24 24"><path d="M12 3l9.5 17H2.5z" ' + SW + ' stroke-width="1.5"/><path d="M12 9.5v5M12 17v.5" ' + SW + ' stroke-width="1.6"/></symbol>' +
    '<symbol id="i-pencil" viewBox="0 0 24 24"><path d="M16.5 3.8l3.7 3.7L8.4 19.3l-4.7.9.9-4.7z" ' + SW + ' stroke-width="1.5"/></symbol>' +
    '<symbol id="i-trash" viewBox="0 0 24 24"><path d="M4 6.5h16M9.5 6.5V4h5v2.5M6.5 6.5l1 14h9l1-14" ' + SW + ' stroke-width="1.5"/></symbol>' +
    '<symbol id="i-copy" viewBox="0 0 24 24"><rect x="8.5" y="8.5" width="12" height="12" rx="1.5" ' + SW + ' stroke-width="1.5"/><path d="M15.5 8.5v-3a1.5 1.5 0 00-1.5-1.5H5a1.5 1.5 0 00-1.5 1.5v9A1.5 1.5 0 005 16h3" ' + SW + ' stroke-width="1.5"/></symbol>' +
    '<symbol id="i-file" viewBox="0 0 24 24"><path d="M6 3h7l5 5v13H6z" ' + SW + ' stroke-width="1.5"/><path d="M13 3v5h5" ' + SW + ' stroke-width="1.5"/></symbol>' +
    '<symbol id="i-globe" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5" ' + SW + ' stroke-width="1.5"/><path d="M3.5 12h17M12 3.5c-4.5 5-4.5 12 0 17 4.5-5 4.5-12 0-17z" ' + SW + ' stroke-width="1.4"/></symbol>' +
    '<symbol id="i-monitor" viewBox="0 0 24 24"><rect x="3" y="4.5" width="18" height="12" rx="1.5" ' + SW + ' stroke-width="1.5"/><path d="M9 20h6M12 16.5V20" ' + SW + ' stroke-width="1.5"/></symbol>' +
    '<symbol id="i-folder" viewBox="0 0 24 24"><path d="M3 6h6l2 3h10v10H3z" ' + SW + ' stroke-width="1.5"/></symbol>';

  var SECTIONS = [
    ["endpoints", "Endpoints"], ["wire", "Wire & transforms"], ["auth", "Auth & secrets"],
    ["tls", "TLS & mTLS"], ["proxy", "Proxy & network"], ["diag", "Diagnostics"],
    ["agent", "Agent & tools"], ["mcp", "MCP servers"], ["skills", "Skills"], ["checkpoints", "Checkpoints"],
    ["logs", "Logs & export"]
  ];

  var RUNG_LABELS = {
    "Certificates and keys": "Config", "Profile": "Config", "DNS": "DNS", "TCP": "TCP",
    "TLS handshake": "TLS", "Authentication": "Auth", "Completion": "HTTP",
    "Streaming": "Stream", "Tool calling": "Tools"
  };

  /* The fourteen read-only indicators, with why each is not interactive. */
  /* Latest health probe per profile id, and whether one is in flight. */
  var HEALTH = {};
  var HEALTH_BUSY = {};
  /* Auto-sync period in minutes, 0 being off. A single number drives both the
     timer and the control, so the two can never disagree about the state.
     Ten is the default: a stale "active" row that has been unreachable for an
     hour is worse than no row, and ten minutes sits well inside the socket
     keep-alive, so a check usually reuses a warm connection for one round trip. */
  var SYNC_MIN = 10;
  var SYNC_STEPS = [0, 1, 5, 10, 30];
  var autoTimer = null;
  var syncedOnce = false;
  var healthWatchdog = null;

  function armAutoSync() {
    if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
    if (SYNC_MIN > 0) autoTimer = setInterval(function () { post("healthCheck"); }, SYNC_MIN * 60000);
  }

  /* The first sync is the one that matters. A panel whose Health column reads
     "-" on every row until a timer fires ten minutes from now is a panel that
     is wrong exactly when it is being looked at, so opening the view is itself
     the trigger. Once per webview, as soon as there is a profile to probe. */
  function syncOnOpen() {
    if (syncedOnce || !S.profiles.length) return;
    syncedOnce = true;
    post("healthCheck");
    armAutoSync();
  }

  /* True while any profile is mid-probe, which is what the Sync button reads
     to swap its glyph for the spinner and refuse a second overlapping sweep. */
  function healthBusy() {
    for (var k in HEALTH_BUSY) if (HEALTH_BUSY[k]) return true;
    return false;
  }
  /* Bands, in ms. A number alone tells you nothing without a scale, so the
     colour does the reading and the figure confirms it. */
  var FAST = 400;
  var OK = 1200;

  /**
   * The waiting mark: three arcs from the palette on their own periods.
   *
   * One rotating ring reads as a stalled image; three at 1.1s, 1.7s and 2.6s
   * never repeat the same figure, so the eye keeps reading it as work.
   */
  function spinner(size) {
    var s = size || 12;
    return '<svg class="kx-spin" width="' + s + '" height="' + s + '" viewBox="0 0 24 24" ' +
      'fill="none" aria-hidden="true">' +
      '<circle class="a1" cx="12" cy="12" r="10" stroke="var(--kx-accent)" stroke-width="2.5" ' +
        'stroke-linecap="round" stroke-dasharray="16 47"/>' +
      '<circle class="a2" cx="12" cy="12" r="6.5" stroke="var(--kx-mcp)" stroke-width="2.5" ' +
        'stroke-linecap="round" stroke-dasharray="10 31"/>' +
      '<circle class="a3" cx="12" cy="12" r="3" stroke="var(--kx-active)" stroke-width="2.5" ' +
        'stroke-linecap="round" stroke-dasharray="5 14"/>' +
      "</svg>";
  }

  function healthCell(id) {
    if (HEALTH_BUSY[id]) return '<span class="hp" data-band="wait">' + spinner() + "</span>";
    var h = HEALTH[id];
    if (!h) return '<span class="hp muted">-</span>';
    if (!h.ok) {
      return '<span class="hp" data-band="down" title="' + esc(h.detail) + '">' +
        icon("i-x", "ic-10") + "<span>down</span></span>";
    }
    var band = h.ms <= FAST ? "fast" : h.ms <= OK ? "ok" : "slow";
    return '<span class="hp" data-band="' + band + '" title="Time to response headers">' +
      '<span class="spark" style="--w:' + Math.min(100, Math.round((h.ms / 2000) * 100)) + '%"></span>' +
      "<span>" + h.ms + "ms</span></span>";
  }

  var PROFILE_TIP = "Controlled by the active profile's YAML.";
  var ENGINE_TIP = "Always on - engine behavior.";

  var TOOLS = [
    ["read_file", "path, start?, end?", "workspace only"],
    ["write_file", "path, content", "workspace only · approval"],
    ["edit_file", "path, old_text, new_text", "workspace only · approval"],
    ["list_files", "path, depth?", "workspace only"],
    ["search", "pattern, glob?", "workspace only"],
    ["run_command", "command, reason", "shell · approval"],
    ["read_skill", "name", "enabled skills only"],
    ["update_todos", "todos[]", "no side effects"]
  ];

  var TRANSFORM_SAMPLE =
    "exports.transformRequest = (body, profile) => {\n" +
    "  // body is the fully-encoded wire body (openai or anthropic shape).\n" +
    "  // The streaming decision is made BEFORE this runs - do not hide it.\n" +
    "  return { envelope: { tenant: \"eng\", payload: body } };\n" +
    "};\n\n" +
    "exports.transformResponse = (json, profile) => {\n" +
    "  // Whole response when non-streaming; each parsed SSE frame otherwise.\n" +
    "  return json.envelope?.result ?? json;\n" +
    "};";

  /* ─────────────────────────── store ─────────────────────────── */

  var S = {
    section: "endpoints",
    workspace: { open: false, name: null },
    profiles: [],
    skills: [],
    skillWarnings: [],
    config: {
      approvalMode: "ask", activeProfile: "", caBundlePath: "",
      profileDirectory: ".agent/endpoints", skillsDirectory: ".agent/skills", ui: {}
    },
    tlsError: null,
    rungs: [],
    tracing: false,
    traceRun: false,
    checkpoints: [],
    logs: [],
    epForm: null,
    epCheck: null,
    mcp: { servers: [], warnings: [] },
    flash: {}
  };

  /* ─────────────────────────── helpers ─────────────────────────── */

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
  function crystal(h, cls) { return window.__kxCrystal.svg(h, cls); }
  function $(id) { return document.getElementById(id); }

  function readyProfiles() {
    return S.profiles.filter(function (p) { return p.status === "ready"; });
  }
  function active() {
    var ready = readyProfiles();
    for (var i = 0; i < ready.length; i++) if (ready[i].active) return ready[i];
    return ready[0] || null;
  }
  function errorCount() {
    return S.profiles.filter(function (p) { return p.status === "error"; }).length;
  }
  function flash(key, label, fallback) {
    return S.flash[key] ? label : fallback;
  }
  function setFlash(key, ms) {
    S.flash[key] = true;
    render();
    setTimeout(function () { delete S.flash[key]; render(); }, ms || 1500);
  }

  /* Row builders shared by several sections. */
  function kv(rows) {
    var html = '<div class="kv">';
    for (var i = 0; i < rows.length; i++) {
      html += '<span class="k">' + esc(rows[i][0]) + "</span>" +
        '<span class="v' + (rows[i][2] ? " wrap" : "") + '" title="' + esc(rows[i][1]) + '">' +
        esc(rows[i][1]) + "</span>";
    }
    return html + "</div>";
  }
  function card(title, inner) {
    return '<div class="card"><div class="t">' + esc(title) + "</div>" + inner + "</div>";
  }
  function toggle(key, label, hint, on, editable, tip, warn) {
    return '<div class="toggle-row">' +
      '<button class="switch" role="switch" aria-checked="' + (on ? "true" : "false") + '"' +
      (editable ? ' data-toggle="' + esc(key) + '"' : " disabled") +
      ' title="' + esc(editable ? "" : tip || "") + '" aria-label="' + esc(label) + '"></button>' +
      '<span class="txt"><span class="lbl">' + esc(label) + "</span>" +
      (hint ? '<span class="hint' + (warn ? " warn" : "") + '">' + esc(hint) + "</span>" : "") +
      "</span></div>";
  }
  function optGroup(name, options, current, editable) {
    var html = '<div class="opt-group">';
    for (var i = 0; i < options.length; i++) {
      var value = options[i][0], label = options[i][1];
      html += '<button class="opt" aria-pressed="' + (value === current ? "true" : "false") + '"' +
        (editable ? ' data-opt="' + esc(name) + '" data-value="' + esc(value) + '"' : " disabled") +
        ">" + esc(label) + "</button>";
    }
    return html + "</div>";
  }
  function mapEntries(obj) {
    var out = [];
    for (var k in obj) if (Object.prototype.hasOwnProperty.call(obj, k)) {
      out.push(k + ": " + String(obj[k]));
    }
    return out;
  }
  function rungRow(r) {
    return '<div class="rung" data-s="' + esc(r.status) + '">' +
      '<span class="rail"><span class="node"></span></span>' +
      '<span class="nm">' + esc(RUNG_LABELS[r.name] || r.name) + "</span>" +
      '<span class="body"><span class="dt">' + esc(r.detail) + "</span>" +
      (r.fix ? '<div class="fx">' + esc(r.fix) + "</div>" : "") + "</span>" +
      /* A rung still running has no time to report yet, and a bare "-" there
         is indistinguishable from one that finished without a measurement.
         The spinner says which of the two this is. */
      '<span class="ms">' + (r.status === "pending" ? spinner(12) : r.ms ? r.ms + "ms" : "-") +
      "</span></div>";
  }
  function rungByName(name) {
    for (var i = 0; i < S.rungs.length; i++) if (S.rungs[i].name === name) return S.rungs[i];
    return null;
  }

  /* ─────────────────────────── shell ─────────────────────────── */

  function mount() {
    $("root").innerHTML =
      '<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>' +
      CRYSTAL_DEFS + ICON_DEFS + "</defs></svg>" +
      '<div id="cc">' +
        '<header class="cc-header">' + crystal(22) +
          '<span class="cc-wordmark">Kryptonite</span>' +
          '<span class="cc-sub ell">Control Center</span><span class="sp"></span>' +
          '<span class="profile-chip ell" id="ccChip">no profile</span>' +
          '<button class="hdr-btn" id="ccReload" title="Reload profiles" aria-label="Reload profiles">' +
          icon("i-refresh", "ic-14") + "</button>" +
        "</header>" +
        '<nav class="strip" id="strip" role="tablist"></nav>' +
        '<div id="pane" role="tabpanel"></div>' +
      "</div>";
  }

  function authBadge(kind) {
    return kind === "exchange" ? "OAuth2" : kind === "exec" ? "helper"
      : kind === "bearer" ? "bearer" : kind === "header" ? "header" : "none";
  }

  function renderStrip() {
    var a = active();
    var counts = {
      endpoints: String(S.profiles.length),
      wire: a ? (a.wire === "openai" ? "OAI" : a.wire === "anthropic" ? "ANT" : "RAW") : "-",
      auth: a ? authBadge(a.authKind) : "-",
      tls: S.tlsError ? "1" : (a && a.tls && a.tls.ca && a.tls.ca.length ? String(a.tls.ca.length) : "-"),
      proxy: a ? (a.proxy && a.proxy.url ? "set" : a.proxy && a.proxy.fromEnv ? "env" : "off") : "-",
      diag: S.rungs.filter(function (r) { return r.status === "fail"; }).length || (S.traceRun ? "OK" : "-"),
      agent: "25",
      skills: String(S.skills.filter(function (s) { return s.enabled; }).length),
      checkpoints: String(S.checkpoints.length),
      logs: String(S.logs.filter(function (l) { return l.level === "error"; }).length || S.logs.length)
    };
    var alerts = {
      endpoints: errorCount() > 0,
      tls: Boolean(S.tlsError),
      diag: S.rungs.some(function (r) { return r.status === "fail"; }),
      logs: S.logs.some(function (l) { return l.level === "error"; })
    };

    var html = "";
    for (var i = 0; i < SECTIONS.length; i++) {
      var id = SECTIONS[i][0], label = SECTIONS[i][1];
      var badge = String(counts[id]);
      if (id === "endpoints" && errorCount()) badge = S.profiles.length + " · " + errorCount() + "!";
      html += '<button role="tab" data-section="' + id + '" aria-selected="' +
        (S.section === id ? "true" : "false") + '">' + esc(label) +
        '<span class="nav-badge' + (alerts[id] ? " alert" : "") + '">' + esc(badge) + "</span></button>";
    }
    $("strip").innerHTML = html;

    var chip = $("ccChip");
    chip.textContent = a ? a.id : "no profile";
    chip.title = a ? a.baseUrl : "No endpoint profile loaded.";
  }

  /* ───────────────────────── sections ───────────────────────── */

  function render() {
    renderStrip();
    var pane = $("pane");
    if (!S.workspace.open) {
      pane.innerHTML = "<h3>No folder open</h3>" +
        '<div class="explainer">Kryptonite reads endpoint profiles and skills from the folder you have open. ' +
        "Open a folder to configure it.</div>";
      return;
    }
    switch (S.section) {
      case "endpoints": pane.innerHTML = secEndpoints(); break;
      case "wire": pane.innerHTML = secWire(); break;
      case "auth": pane.innerHTML = secAuth(); break;
      case "tls": pane.innerHTML = secTls(); break;
      case "proxy": pane.innerHTML = secProxy(); break;
      case "diag": pane.innerHTML = secDiag(); break;
      case "agent": pane.innerHTML = secAgent(); break;
      case "mcp": pane.innerHTML = secMcp(); break;
      case "skills": pane.innerHTML = secSkills(); break;
      case "checkpoints": pane.innerHTML = secCheckpoints(); break;
      case "logs": pane.innerHTML = secLogs(); break;
    }
    // Set as a property, never interpolated into the markup above.
    if (S.epForm && S.epForm.apiKey && $("fKey")) $("fKey").value = S.epForm.apiKey;
  }

  /* ── endpoints ── */
  function secEndpoints() {
    var html = "<h3>Endpoints</h3>" +
      '<div class="explainer">Profiles are YAML files in <code>' +
      esc(S.config.profileDirectory || ".agent/endpoints") +
      "</code>. A file-system watcher reloads profiles and skills on change - no window restart, and the auth cache is cleared on reload.</div>";

    if (!S.profiles.length) {
      html += '<div class="empty">No profiles in ' + esc(S.config.profileDirectory || ".agent/endpoints") + "</div>" +
        '<div class="row-actions"><button class="btn primary" data-act="newEndpoint">New profile from template</button></div>';
    } else {
      var rows = '<div class="tr head"><span></span><span>Profile</span><span>Model &amp; wire</span>' +
        '<span>Health</span><span>Status</span><span></span></div>';
      for (var i = 0; i < S.profiles.length; i++) {
        var p = S.profiles[i];
        rows += '<div class="tr" data-status="' + p.status + '">' +
          '<span class="pdot' + (p.status === "error" ? " err" : "") + '"></span>' +
          '<span class="ell"><span class="id ell">' + esc(p.id) + "</span>" +
          '<span class="sub ell" title="' + esc(p.status === "error" ? p.error || "" : p.baseUrl) + '">' +
          esc(p.status === "error" ? (p.error || "Failed to parse") : p.baseUrl) + "</span></span>" +
          '<span class="ell"><span class="id ell">' + esc(p.model) + "</span>" +
          '<span class="sub ell">' + esc(p.wire) + "</span></span>" +
          healthCell(p.id) +
          '<span class="ell muted">' + (p.status === "error" ? "error" : p.active ? "active" : "ready") + "</span>" +
          '<span class="acts">' +
            '<button class="mini" data-ep="yaml" data-id="' + esc(p.id) + '" title="Open YAML" aria-label="Open YAML">' + icon("i-file", "ic-13") + "</button>" +
            '<button class="mini danger" data-ep="del" data-id="' + esc(p.id) + '" title="Delete profile" aria-label="Delete profile">' + icon("i-trash", "ic-13") + "</button>" +
          "</span></div>";
      }
      /* One segment per period, current one pressed. This replaces a checkbox
         reading "Check every 10 min", which could only be understood by
         reading the label and then looking at the box: the state and the
         period were in two places. Here the lit segment is the whole answer,
         and changing the period is one click rather than a setting hunt. */
      var segs = "";
      for (var si = 0; si < SYNC_STEPS.length; si++) {
        var v = SYNC_STEPS[si];
        segs += '<button class="seg-b" data-sync="' + v + '" aria-pressed="' +
          (v === SYNC_MIN ? "true" : "false") + '" title="' +
          (v === 0 ? "Never check on a timer" : "Check every " + v + " min") + '">' +
          (v === 0 ? "Off" : v + "m") + "</button>";
      }

      var busy = healthBusy();
      html += '<div class="tbl-bar">' +
          '<button class="btn sm sync" data-act="health"' + (busy ? " disabled" : "") +
            ' title="Time a round trip to every profile now">' +
            (busy ? spinner(13) : icon("i-refresh", "ic-13")) +
            "<span>" + (busy ? "Syncing…" : "Sync now") + "</span></button>" +
          '<div class="seg" role="group" aria-label="Auto-sync period">' +
            '<span class="seg-l">Auto</span>' + segs +
          "</div>" +
          '<span class="sp"></span>' +
          '<span class="muted tiny bar-note">Times the path to the gateway, not the model. ' +
            "No tokens are spent.</span>" +
        "</div>" +
        '<div class="tbl">' + rows + "</div>";
    }

    var a = active();
    if (a) {
      html += '<div class="grid-cards" style="margin-top:14px">';
      html += card("Request shape", kv([
        ["Base URL", a.baseUrl],
        ["Chat path", a.chatPath || "(loader default)"],
        ["Model", a.model],
        ["Timeout", a.timeoutMs + " ms"],
        ["Retries", String(a.retries)],
        ["Context window", a.capabilities ? String(a.capabilities.contextWindow) : "-"],
        ["Max output", a.capabilities ? String(a.capabilities.maxOutputTokens) : "-"]
      ]) + '<div style="margin-top:9px">' +
        optGroup("tokenCounting",
          [["heuristic", "heuristic"], ["api", "api"]],
          a.capabilities ? a.capabilities.tokenCounting : "heuristic", false) +
        '<div class="hint muted" style="font-size:11px;margin-top:5px">' + esc(PROFILE_TIP) + "</div></div>");

      html += card("Merged into every request",
        '<div class="kv"><span class="k">Headers</span><span class="v wrap">' +
        (mapEntries(a.headers).length ? esc(mapEntries(a.headers).join(", ")) : "-") + "</span>" +
        '<span class="k">Query</span><span class="v wrap">' +
        (mapEntries(a.query).length ? esc(mapEntries(a.query).join(", ")) : "-") + "</span>" +
        '<span class="k">Extra body</span><span class="v wrap">' +
        (mapEntries(a.extraBody).length ? esc(mapEntries(a.extraBody).join(", ")) : "-") + "</span></div>");
      html += "</div>";
    }

    html += '<div class="row-actions">' +
      '<span class="' + (errorCount() ? "err-line" : "empty") + '">' +
      (errorCount()
        ? errorCount() + " profile(s) failed to load - see Logs."
        : readyProfiles().length + " profile(s) loaded cleanly.") + "</span>" +
      '<span class="sp"></span>' +
      '<button class="btn" data-act="newEndpoint">New profile from template</button>' +
      (a ? '<button class="btn" data-ep="yaml" data-id="' + esc(a.id) + '">Open YAML</button>' : "") +
      "</div>";

    if (S.epForm) html += endpointForm();
    return html;
  }

  function endpointForm() {
    var f = S.epForm;
    var types = ["anthropic", "openai-compatible", "azure", "local", "custom"], opts = "";
    for (var i = 0; i < types.length; i++) {
      opts += '<option value="' + types[i] + '"' + (f.type === types[i] ? " selected" : "") + ">" + types[i] + "</option>";
    }
    var needsKey = f.type !== "local";
    return '<div class="form"><div class="t">' + (f.isNew ? "Add endpoint" : "Edit endpoint") + "</div>" +
      '<div class="fgrid">' +
        '<label for="fId">ID</label><input id="fId" value="' + esc(f.id) + '" placeholder="openrouter">' +
        '<label for="fName">Display Name</label><input id="fName" value="' + esc(f.name) + '" placeholder="OpenRouter">' +
        '<label for="fUrl">Base URL</label><input id="fUrl" value="' + esc(f.url) + '" placeholder="https://openrouter.ai/api/v1">' +
        '<label for="fType">Provider Type</label><select id="fType">' + opts + "</select>" +
        '<label for="fModel">Model</label><input id="fModel" value="' + esc(f.model || "") + '" placeholder="openrouter/free">' +
        (needsKey
          ? '<label for="fKey">API Key</label><input id="fKey" type="password" autocomplete="off" spellcheck="false" value="" placeholder="' +
            (f.hasStoredKey ? "stored - leave blank to keep" : "sk-…") + '">'
          : "") +
        '<label for="fPath">Route</label><input id="fPath" value="' + esc(f.chatPath || "") + '" placeholder="auto - derived from Base URL">' +
        '<label for="fTimeout">Timeout</label>' +
        '<div class="fsplit"><input id="fTimeout" type="number" min="1" max="600" step="1" value="' +
          esc(f.timeoutMs ? Math.round(f.timeoutMs / 1000) : "") + '" placeholder="30"><span class="unit">seconds</span></div>' +
        '<label for="fHttp2">HTTP/2</label>' +
        '<div class="fsplit"><input id="fHttp2" type="checkbox"' + (f.http2 ? " checked" : "") +
          '><span class="unit">last resort - slows streaming badly</span></div>' +
      "</div>" +
      (needsKey
        ? '<div class="hint2">Stored in VS Code SecretStorage. The YAML holds only a <code>${secret:…}</code> reference.</div>'
        : "") +
      epCheckPanel() +
      '<div class="row"><button class="btn" data-ep="cancel">Cancel</button>' +
      '<button class="btn wait" data-ep="check"' + (S.epCheck && S.epCheck.running ? " disabled" : "") + ">" +
      (S.epCheck && S.epCheck.running ? spinner(13) + "<span>Checking…</span>" : "<span>Check connection</span>") +
      "</button>" +
      '<button class="btn primary" data-ep="save">Save</button></div></div>';
  }

  /** Same ladder rows the Diagnostics section renders, scoped to the form. */
  function epCheckPanel() {
    var c = S.epCheck;
    if (!c) return "";
    var out = '<div class="ep-check">';
    if (c.done) {
      out += '<div class="ep-check-banner" data-ok="' + (c.ok ? "1" : "0") + '">' +
        esc(c.summary) + "</div>";
    }
    for (var i = 0; i < c.rungs.length; i++) out += rungRow(c.rungs[i]);
    if (c.running) out += rungRow({ name: "", status: "pending", detail: "Checking…", ms: 0 });
    return out + "</div>";
  }

  /** Snapshot the inputs before any re-render, so streaming rungs don't wipe them. */
  function readEpForm() {
    if (!S.epForm || !$("fId")) return S.epForm;
    var key = $("fKey") ? $("fKey").value : "";
    S.epForm.id = $("fId").value.trim();
    S.epForm.name = $("fName").value.trim();
    S.epForm.url = $("fUrl").value.trim();
    S.epForm.type = $("fType").value;
    S.epForm.model = $("fModel") ? $("fModel").value.trim() : "";
    S.epForm.chatPath = $("fPath") ? $("fPath").value.trim() : "";
    // Seconds in the field, milliseconds in the profile.
    var secs = $("fTimeout") ? parseFloat($("fTimeout").value) : NaN;
    S.epForm.timeoutMs = isFinite(secs) && secs > 0 ? Math.round(secs * 1000) : 0;
    S.epForm.http2 = $("fHttp2") ? $("fHttp2").checked : false;
    if (key) S.epForm.apiKey = key;
    return S.epForm;
  }

  function epPayload(f) {
    var out = {
      id: f.id, name: f.name, url: f.url, type: f.type,
      model: f.model || "", chatPath: f.chatPath || "",
      http2: !!f.http2, hasStoredKey: !!f.hasStoredKey
    };
    if (f.timeoutMs) out.timeoutMs = f.timeoutMs;
    if (f.apiKey) out.apiKey = f.apiKey;
    if (f.originalId) out.originalId = f.originalId;
    return out;
  }

  /* ── MCP servers ── */
  function secMcp() {
    var m = S.mcp || { servers: [], warnings: [] };
    var html = "<h3>MCP servers</h3>" +
      '<div class="explainer">Servers declared in <code>.agent/mcp.json</code>, in the same shape ' +
      'Claude Desktop and Claude Code use. Each is a child process this extension starts over stdio; ' +
      'its tools reach the model as <code>mcp__&lt;server&gt;__&lt;tool&gt;</code>. Tools are withheld ' +
      'in Plan mode, because MCP cannot declare a tool read-only.</div>';

    if (m.warnings && m.warnings.length) {
      html += '<div class="warn-line">' + esc(m.warnings.join(" ")) + "</div>";
    }

    if (!m.servers.length) {
      html += '<div class="empty">No servers configured.</div>' +
        '<div class="row-actions"><button class="btn" data-act="mcpReload">Reload config</button></div>';
      return html;
    }

    var rows = '<div class="tr head"><span></span><span>Server</span><span>Transport</span><span>Tools</span><span></span></div>';
    for (var i = 0; i < m.servers.length; i++) {
      var sv = m.servers[i];
      var ready = sv.state === "ready";
      // One status signal per row: the pill carries the reason, so there is no
      // separate dot to disagree with it.
      var pill = ready
        ? '<span class="pill ok">connected</span>'
        : sv.state === "starting"
          ? '<span class="pill">starting…</span>'
          : '<span class="pill err" title="' + esc(sv.error || "") + '">' + esc(sv.state) + "</span>";
      rows += '<div class="tr" data-status="' + (ready ? "ready" : "error") + '">' +
        "<span></span>" +
        '<span class="ell"><span class="id ell">' + esc(sv.name) + "</span>" +
        '<span class="url ell" title="' + esc(sv.command) + '">' +
          esc(sv.serverInfo ? sv.serverInfo.name + " " + sv.serverInfo.version : sv.command) +
        "</span></span>" +
        '<span class="mono" style="font-size:10.5px">stdio · ' + esc(sv.approval) + "</span>" +
        '<span class="mono">' + (ready ? sv.toolCount : "-") + "</span>" +
        '<span class="acts"><button class="mini" data-mcp="reconnect" data-name="' + esc(sv.name) +
          '" title="Reconnect">' + icon("i-refresh", "ic-13") + "</button></span>" +
        "</div>";
      if (!ready && sv.error) {
        rows += '<div class="tr"><span></span><span class="err-line" style="grid-column:2/6">' +
          esc(sv.error) + "</span></div>";
      }
      if (ready && sv.tools.length) {
        rows += '<div class="tr"><span></span><span style="grid-column:2/6"><span class="chips">' +
          sv.tools.map(function (t) { return '<span class="chip">' + esc(t) + "</span>"; }).join("") +
          "</span></span></div>";
      }
    }

    var total = 0, down = 0;
    for (var j = 0; j < m.servers.length; j++) {
      if (m.servers[j].state === "ready") total += m.servers[j].toolCount;
      else if (m.servers[j].state === "failed") down++;
    }
    html += '<div class="tbl">' + rows + "</div>" +
      '<div class="row-actions"><span class="empty">' + total + ' tool(s) exposed to the model' +
      (down ? " · " + down + " server(s) unavailable" : "") + "</span>" +
      '<span class="sp"></span>' +
      '<button class="btn" data-act="mcpReload">Reload config</button></div>';
    return html;
  }

  /* ── wire & transforms ── */
  function secWire() {
    var a = active();
    var caps = a && a.capabilities;
    var html = "<h3>Wire &amp; transforms</h3>" +
      '<div class="explainer">The wire format decides how messages are encoded on the way out and decoded on the way in. ' +
      "A transform module reshapes anything the two standard adapters cannot express.</div>";
    if (!a) return html + '<div class="empty">No active profile.</div>';

    html += '<div class="block"><h4>Wire format</h4>' +
      optGroup("wire", [
        ["openai", "openai-compatible"], ["anthropic", "anthropic"], ["raw", "raw + transform"]
      ], a.wire, false) +
      '<div class="hint muted" style="font-size:11px;margin-top:5px">' + esc(PROFILE_TIP) + "</div></div>";

    html += '<div class="block"><h4>System role handling</h4>' +
      optGroup("systemRole", [
        ["message", "message"], ["top-level", "top-level"], ["prepend-user", "prepend-to-user"]
      ], caps ? caps.systemRole : "message", false) +
      '<div class="hint muted" style="font-size:11px;margin-top:5px">' + esc(PROFILE_TIP) + "</div></div>";

    html += '<div class="block"><h4>Decoding</h4>' +
      toggle("sse", "Streaming SSE parsing", caps && caps.streaming ? "Enabled for this profile." : "Disabled for this profile.", Boolean(caps && caps.streaming), false, PROFILE_TIP) +
      toggle("crlf", "CRLF normalization", "Gateways vary on line endings.", true, false, ENGINE_TIP) +
      toggle("reassembly", "Split tool-call reassembly", "Arguments arriving across deltas are rejoined.", true, false, ENGINE_TIP) +
      toggle("toolBlocks", "Tool call content blocks", "", true, false, ENGINE_TIP) +
      toggle("vision", "Vision / image blocks", "", Boolean(caps && caps.vision), false, PROFILE_TIP) +
      toggle("parallelTools", "Parallel tool calls", "", Boolean(caps && caps.parallelToolCalls), false, PROFILE_TIP) +
      "</div>";

    html += '<div class="block"><h4>Transform module</h4>' +
      (a.transform
        ? '<div class="chips" style="margin-bottom:8px"><span class="chip">' + esc(a.transform) + "</span>" +
          '<span class="ok-mark">' + icon("i-check", "ic-11") + "sandboxed · no fs, no network</span></div>"
        : '<div class="empty" style="margin-bottom:8px">No transform module configured. ' +
          "Set <code>transform:</code> in the profile YAML - required when <code>wire: raw</code>.</div>") +
      '<div class="pre">' + esc(TRANSFORM_SAMPLE) + "</div>" +
      (a.transform
        ? '<div class="row-actions"><button class="btn sm" data-act="openTransform">Open module</button></div>'
        : "") +
      "</div>";
    return html;
  }

  /* ── auth & secrets ── */
  function secAuth() {
    var a = active();
    var html = "<h3>Auth &amp; secrets</h3>" +
      '<div class="explainer">Tokens are never written to profile YAML. Values interpolate from the environment, ' +
      "the VS Code secret store, or a file on disk at request time.</div>";
    if (!a) return html + '<div class="empty">No active profile.</div>';

    html += '<div class="block"><h4>Auth mode</h4>' +
      optGroup("authKind", [
        ["bearer", "Bearer"], ["header", "Custom header"], ["exchange", "OAuth2"], ["exec", "Credential helper"]
      ], a.authKind, false) +
      '<div class="hint muted" style="font-size:11px;margin-top:5px">' + esc(PROFILE_TIP) + "</div></div>";

    var cacheLabel = "not cached";
    if (a.authCache) {
      var mins = Math.max(0, Math.round((a.authCache.expiresAt - Date.now()) / 60000));
      cacheLabel = "expires in " + mins + "m";
    }
    html += '<div class="grid-cards">' +
      card("Credential", kv([
        ["Kind", a.authKind],
        ["Summary", a.authSummary, true],
        ["Cached token", cacheLabel]
      ]) + '<div class="ok-mark" style="margin-top:8px">' + icon("i-check", "ic-11") +
        "expiry-aware refresh on</div>") +
      card("Secret resolution",
        '<div class="tbl"><div class="tr2 head" style="font-size:10.5px;text-transform:uppercase;color:var(--vscode-descriptionForeground)">' +
        "<span>Reference</span><span>Source</span><span>Resolved from</span></div>" +
        secretRows(a) + "</div>") +
      "</div>";

    html += '<div class="row-actions">' +
      '<button class="btn" data-act="clearAuth">' + flash("clearAuth", "Auth cache cleared", "Clear auth cache") + "</button>" +
      "</div>";
    return html;
  }

  function secretRows(p) {
    var refs = [];
    var json = JSON.stringify(p);
    var re = /\$\{(env|secret|file):([^}]+)\}/g, m;
    while ((m = re.exec(json))) {
      refs.push([m[0], m[1], m[1] === "env" ? "process environment"
        : m[1] === "secret" ? "SecretStorage · kryptonite." + m[2] : m[2]]);
    }
    if (!refs.length) {
      return '<div class="tr2"><span class="empty">No interpolated references.</span><span></span><span></span></div>';
    }
    var html = "";
    for (var i = 0; i < refs.length; i++) {
      html += '<div class="tr2"><span class="v mono ell">' + esc(refs[i][0]) + "</span>" +
        '<span class="muted">' + esc(refs[i][1]) + "</span>" +
        '<span class="muted ell" title="' + esc(refs[i][2]) + '">' + esc(refs[i][2]) + "</span></div>";
    }
    return html;
  }

  /* ── TLS & mTLS ── */
  function secTls() {
    var a = active();
    var html = "<h3>TLS &amp; mTLS</h3>" +
      '<div class="explainer">Requests go out on an undici dispatcher rather than Node&rsquo;s global fetch, so custom CAs and ' +
      "client certificates apply inside the extension host - including through a CONNECT tunnel, where the TLS settings " +
      "must be applied to the tunnelled origin rather than the proxy hop.</div>";
    if (!a) return html + '<div class="empty">No active profile.</div>';

    var caRows = "";
    for (var i = 0; i < a.tls.ca.length; i++) {
      caRows += '<div class="ok-mark" style="margin-bottom:4px">' + icon("i-check", "ic-11") +
        esc(a.tls.ca[i]) + "</div>";
    }
    html += '<div class="grid-cards">' +
      card("CA bundles", (caRows || '<span class="empty">Node&rsquo;s bundled root store.</span>') +
        (a.tls.ca.length > 1
          ? '<div class="hint muted" style="font-size:11px;margin-top:5px">' + a.tls.ca.length + " bundles combined at request time.</div>"
          : "")) +
      card("Client certificate", a.tls.clientCert
        ? '<div class="chips" style="margin-bottom:8px"><span class="chip on">' +
          (/\.(pfx|p12)$/i.test(a.tls.clientCert) ? "PKCS#12" : "PEM") + "</span></div>" +
          kv([["Certificate", a.tls.clientCert], ["Key", "(see profile YAML)"]])
        : '<span class="empty">No client certificate configured.</span>') +
      "</div>";

    html += '<div class="block" style="margin-top:14px"><h4>Handshake</h4>' +
      optGroup("minVersion", [["TLSv1.2", "TLS 1.2"], ["TLSv1.3", "TLS 1.3"]], a.tls.minVersion || "", false) +
      '<div class="kv" style="margin-top:9px"><span class="k">SNI servername</span>' +
      '<span class="v">' + esc(a.tls.servername || "(hostname)") + "</span></div>" +
      toggle("combineCa", "Combine multiple CA bundles", "Custom roots are merged with the defaults.", true, false, ENGINE_TIP) +
      toggle("insecure", "Insecure skip verify",
        a.tls.insecure ? "Certificate verification is OFF for this profile." : "Certificate verification is on.",
        a.tls.insecure, false, PROFILE_TIP, a.tls.insecure) +
      "</div>";

    html += '<div class="block"><h4>Certificate chain</h4>' + certChain(a) + "</div>";
    return html;
  }

  function certChain(p) {
    var rung = rungByName("TLS handshake");
    var chain = null;
    if (rung && rung.status === "pass") {
      var m = rung.detail.match(/chain:\s*([^.]+)\./);
      if (m) chain = m[1].split("\u2190").map(function (s) { return s.trim(); });
    }
    if (!chain) {
      return '<div class="empty">No verified chain from the last trace. ' +
        (S.tlsError && S.tlsError.proxied
          ? "The failing certificate was presented inside the CONNECT tunnel."
          : "Run diagnostics to populate this.") + "</div>" +
        kv([["CA bundles", p.tls.ca.join(", ") || "(defaults)"],
            ["Client cert", p.tls.clientCert || "none"],
            ["Min version", p.tls.minVersion || "(default)"]]);
    }
    var expires = (rung.detail.match(/Leaf expires (.+)$/) || [])[1] || "-";
    var rows = '<div class="tr3 head" style="font-size:10.5px;text-transform:uppercase;color:var(--vscode-descriptionForeground)">' +
      "<span>#</span><span>Subject</span><span>Expiry</span></div>";
    for (var i = 0; i < chain.length; i++) {
      var isRoot = i === chain.length - 1;
      var expiry = i === 0 ? expires : isRoot ? "in trust store" : "-";
      var cls = S.tlsError && isRoot ? ' style="color:var(--vscode-editorError-foreground)"' : "";
      rows += '<div class="tr3"><span class="muted">' + (i + 1) + "</span>" +
        '<span class="ell" title="' + esc(chain[i]) + '">' + esc(chain[i]) + "</span>" +
        "<span" + cls + ">" + esc(S.tlsError && isRoot ? "not in trust store" : expiry) + "</span></div>";
    }
    return '<div class="tbl">' + rows + "</div>";
  }

  /* ── proxy & network ── */
  function secProxy() {
    var a = active();
    var html = "<h3>Proxy &amp; network</h3>" +
      '<div class="explainer">Behind a CONNECT tunnel the client certificate must be presented to the tunnelled origin, ' +
      "not to the proxy. That distinction is why mTLS-behind-proxy fails in most tooling.</div>";
    if (!a) return html + '<div class="empty">No active profile.</div>';

    html += '<div class="grid-cards">' +
      card("Configuration", kv([
        ["Proxy URL", a.proxy.url || "(from environment)"],
        ["No-proxy", a.proxy.noProxy.length ? a.proxy.noProxy.join(", ") : "-", true]
      ])) +
      card("Behaviour",
        toggle("envProxy", "Use proxy from environment", "HTTPS_PROXY / HTTP_PROXY are honoured.", a.proxy.fromEnv, false, PROFILE_TIP) +
        toggle("noProxyList", "Honour no-proxy list", a.proxy.noProxy.length ? a.proxy.noProxy.join(", ") : "No entries.", a.proxy.noProxy.length > 0, false, PROFILE_TIP) +
        toggle("tunnelMtls", "mTLS through CONNECT tunnel", "Client cert presented to the tunnelled origin.", true, false, ENGINE_TIP)) +
      "</div>";

    var tcp = rungByName("TCP");
    html += '<div class="block" style="margin-top:14px"><h4>Detected</h4>' +
      (tcp
        ? '<div class="ok-mark">' + icon("i-check", "ic-11") + esc(tcp.detail) + "</div>"
        : '<div class="empty">Run diagnostics to detect the live transport path.</div>') +
      "</div>";
    return html;
  }

  /* ── diagnostics ── */
  function secDiag() {
    var html = '<div style="display:flex;align-items:flex-start;gap:10px">' +
      '<div style="flex:1;min-width:0"><h3>Diagnostics</h3>' +
      '<div class="explainer">Each rung runs only if the one above it passed, so the first failure is always the real one.</div></div>' +
      '<button class="btn primary wait" data-act="trace"' + (S.tracing ? " disabled" : "") + ">" +
      (S.tracing ? spinner(13) + "<span>Running…</span>" : "<span>Re-run trace</span>") +
      "</button></div>";

    html += '<div class="card">';
    if (!S.rungs.length && !S.tracing) {
      html += '<div class="empty">No trace yet - run diagnostics to check the connection.</div>';
    } else {
      for (var i = 0; i < S.rungs.length; i++) html += rungRow(S.rungs[i]);
      if (S.tracing) html += rungRow({ name: "", status: "pending", detail: "Running…", ms: 0 });
    }
    html += "</div>";

    html += '<div class="grid-cards tight" style="margin-top:14px">' +
      probeCard("Non-streaming test", "Completion") +
      probeCard("Streaming test", "Streaming") +
      probeCard("Tool-calling probe", "Tool calling") +
      "</div>";

    if (S.tlsError) {
      html += '<div class="card" style="margin-top:14px;border-color:var(--vscode-editorError-foreground)">' +
        '<div class="t" style="color:var(--vscode-editorError-foreground)">' + icon("i-x", "ic-13") +
        " TLS failure at " + esc(S.tlsError.rung) + "</div>" +
        '<div class="err-line" style="margin-bottom:8px">' + esc(S.tlsError.message) + "</div>" +
        kv([["Endpoint", S.tlsError.endpoint],
            ["Cert subject", S.tlsError.proxied ? "unavailable (tunnelled)" : (S.tlsError.certSubject || "-")],
            ["Cert issuer", S.tlsError.proxied ? "unavailable (tunnelled)" : (S.tlsError.certIssuer || "-")],
            ["TLS version", S.tlsError.proxied ? "-" : (S.tlsError.tlsVersion || "-")]]) +
        '<div class="row-actions">' +
          '<button class="btn" data-act="copyFix">' + flash("copyFix", "Copied", "Copy fix key") + "</button>" +
          '<button class="btn" data-act="systemTrust">Use system trust store</button>' +
          '<button class="btn" data-act="browseCa">Upload CA bundle…</button>' +
        "</div></div>";
    }
    return html;
  }

  function probeCard(title, rungName) {
    var r = rungByName(rungName);
    var blocked = S.rungs.some(function (x) { return x.status === "fail"; }) &&
      (!r || r.status === "skipped" || r.status === "fail");
    var body;
    if (!S.rungs.length) body = '<span class="empty">Not run.</span>';
    else if (blocked) {
      var failing = S.rungs.filter(function (x) { return x.status === "fail"; })[0];
      body = '<span class="err-line">blocked - ' +
        esc(RUNG_LABELS[failing.name] || failing.name) + " failed</span>";
    } else if (r) {
      body = '<span class="' + (r.status === "warn" ? "warn-line" : "ok-mark") + '">' +
        (r.status === "warn" ? "" : icon("i-check", "ic-11")) + esc(r.detail) + "</span>";
    } else {
      body = '<span class="empty">Skipped.</span>';
    }
    return card(title, body);
  }

  /* ── agent & tools ── */
  function secAgent() {
    var ui = S.config.ui || {};
    var html = "<h3>Agent &amp; tools</h3>" +
      '<div class="explainer">The loop reads before it edits, drops the oldest turns when the window fills, and never ' +
      "separates a tool result from the call that produced it.</div>";

    html += '<div class="grid-cards">' +
      card("Limits", kv([
        ["Iteration cap", "25 steps"],
        ["Tool result limit", "60,000 characters to the model"],
        ["Context fitting", "oldest-first, call/result paired"]
      ])) +
      card("Approval mode",
        optGroup("approvalMode", [
          ["ask", "ask"], ["edits-auto", "edits-auto"], ["full-auto", "full-auto"]
        ], S.config.approvalMode, true) +
        '<div class="hint muted" style="font-size:11px;margin-top:6px">' +
        "ask: every side effect · edits-auto: file edits run, commands ask · full-auto: never ask</div>") +
      "</div>";

    html += '<div class="block" style="margin-top:14px"><h4>Behaviour</h4>' +
      toggle("dropOldest", "Drop oldest turns when full", "", true, false, ENGINE_TIP) +
      toggle("neverOrphan", "Never orphan a tool result", "A dropped call takes its result with it.", true, false, ENGINE_TIP) +
      toggle("droppedNotice", "Inject dropped-turns notice", "", true, false, ENGINE_TIP) +
      toggle("openTouched", "Open edited files in the editor", "Shows each file as the agent touches it.",
        ui.openTouched !== false, true) +
      "</div>";

    var rows = '<div class="tr3 head" style="grid-template-columns:minmax(0,1fr) minmax(0,1.4fr) minmax(0,1fr);font-size:10.5px;text-transform:uppercase;color:var(--vscode-descriptionForeground)">' +
      "<span>Tool</span><span>Arguments</span><span>Sandbox</span></div>";
    for (var i = 0; i < TOOLS.length; i++) {
      rows += '<div class="tr3" style="grid-template-columns:minmax(0,1fr) minmax(0,1.4fr) minmax(0,1fr)">' +
        '<span class="v mono ell">' + esc(TOOLS[i][0]) + "</span>" +
        '<span class="muted ell">' + esc(TOOLS[i][1]) + "</span>" +
        '<span class="muted ell">' + esc(TOOLS[i][2]) + "</span></div>";
    }
    html += '<div class="block"><h4>Tools</h4><div class="tbl">' + rows + "</div></div>";
    return html;
  }

  /* ── skills ── */
  function secSkills() {
    var enabled = S.skills.filter(function (s) { return s.enabled; });
    var html = "<h3>Skills</h3>" +
      '<div class="explainer">Folders with a <code>SKILL.md</code> and YAML frontmatter. Only the one-line index enters the ' +
      "system prompt - bodies load on demand, so forty skills cost the same as five until one is used.</div>";

    if (!S.skills.length) {
      html += '<div class="empty">No skills found in ' + esc(S.config.skillsDirectory || ".agent/skills") + "</div>";
    } else {
      var rows = "";
      for (var i = 0; i < S.skills.length; i++) {
        var s = S.skills[i];
        rows += '<div class="tr4">' +
          '<button class="skill-row" data-skill="' + esc(s.name) + '" role="checkbox" aria-checked="' +
          (s.enabled ? "true" : "false") + '">' +
          '<span class="switch" aria-hidden="true" aria-checked="' + (s.enabled ? "true" : "false") + '"></span>' +
          '<span class="ell" style="font-weight:600;font-size:12px">' + esc(s.name) + "</span></button>" +
          '<span class="muted" style="font-size:11px">' + esc(s.source) + "</span>" +
          '<span class="muted ell" title="' + esc(s.description) + '">' + esc(s.description) + "</span>" +
          '<span class="muted" style="font-size:11px">' + (s.files && s.files.length ? s.files.length + " files" : "-") + "</span>" +
          "</div>";
      }
      html += '<div class="tbl">' + rows + "</div>";
    }

    var preview = enabled.length
      ? "Skills available in this workspace. Each is a set of instructions you can read on demand.\n" +
        "When a task matches one, call read_skill with its name before starting work.\n" +
        enabled.map(function (s) { return "- " + s.name + ": " + s.description; }).join("\n")
      : "(no skills enabled - nothing is injected)";

    html += '<div class="block" style="margin-top:14px"><h4>Skill index preview</h4>' +
      '<div class="explainer">This exact text is what the model receives.</div>' +
      '<div class="pre">' + esc(preview) + "</div></div>";

    html += '<div class="row-actions">' +
      '<span class="empty">' + enabled.length + " enabled · ~" + enabled.length * 62 + " tokens · " +
      esc(S.config.skillsDirectory || ".agent/skills") + "</span>" +
      '<span class="sp"></span>' +
      '<button class="btn sm" data-act="reloadSkills">' + flash("reloadSkills", "Reloaded", "Reload") + "</button>" +
      '<button class="btn sm" data-act="openSkills">Open folder</button>' +
      "</div>";

    if (S.skillWarnings.length) {
      html += '<div class="warn-line">' + esc(S.skillWarnings.join(" ")) + "</div>";
    }
    return html;
  }

  /* ── checkpoints ── */
  function secCheckpoints() {
    var ui = S.config.ui || {};
    var html = "<h3>Checkpoints</h3>" +
      '<div class="explainer">A shadow git repository snapshots the workspace before every agent turn, using a separate ' +
      "GIT_DIR, so the real repository, index and reflog are never touched.</div>";

    html += '<div class="grid-cards">' +
      card("Shadow repository", kv([
        ["Location", "extension storage"],
        ["Ignore rules", "node_modules, dist, out, .venv"],
        ["Work tree", S.workspace.name || "(workspace root)"]
      ])) +
      card("Behaviour",
        toggle("snapshotTurn", "Snapshot before every turn", "When off, no snapshot and no diff cards that turn.", ui.snapshotTurn !== false, true) +
        toggle("previewDiff", "Preview diffstat before restore", "When off, restore happens without the modal.", ui.previewDiff !== false, true)) +
      "</div>";

    if (!S.checkpoints.length) {
      html += '<div class="empty" style="margin-top:14px">No checkpoints yet. One is taken before each agent turn.</div>';
      return html;
    }

    var rows = '<div class="tr4 head" style="font-size:10.5px;text-transform:uppercase;color:var(--vscode-descriptionForeground)">' +
      "<span>Label</span><span>When</span><span>Hash</span><span></span></div>";
    for (var i = 0; i < S.checkpoints.length; i++) {
      var c = S.checkpoints[i];
      rows += '<div class="tr4">' +
        '<span class="ell" title="' + esc(c.label) + '">' + esc(c.label) + "</span>" +
        '<span class="muted">' + esc(c.when) + "</span>" +
        '<span class="v mono ell">' + esc(c.hash.slice(0, 10)) + "</span>" +
        '<span style="text-align:right"><button class="btn sm" data-restore="' + esc(c.hash) + '">Restore</button></span>' +
        "</div>";
    }
    html += '<div class="tbl" style="margin-top:14px">' + rows + "</div>";
    return html;
  }

  /* ── logs & export ── */
  function secLogs() {
    var html = "<h3>Logs &amp; export</h3>" +
      '<div class="explainer">The last 200 lines from the KRYPTONITE output channel.</div>' +
      '<div class="watch-mark">' + icon("i-check", "ic-11") + "watcher active on .agent/</div>";

    if (!S.logs.length) {
      html += '<div class="empty">No log lines yet.</div>';
    } else {
      var lines = "";
      for (var i = S.logs.length - 1; i >= 0; i--) {
        var l = S.logs[i];
        lines += '<div class="logline" data-l="' + esc(l.level) + '">' +
          '<span class="t">' + esc(new Date(l.t).toLocaleTimeString()) + "</span>" +
          '<span class="l">' + esc(l.level) + "</span>" +
          '<span class="m">' + esc(l.msg) + "</span></div>";
      }
      html += '<div class="logview">' + lines + "</div>";
    }

    html += '<div class="grid-cards" style="margin-top:14px">' +
      card("Build", kv([
        ["Bundle", "esbuild single file"],
        ["Runtime deps", "undici, yaml (inlined)"],
        ["Packaging", ".vsix with zero network access"]
      ])) +
      card("Offline bundle",
        '<div class="explainer" style="margin:0 0 8px">Copies the configured profile and skills directories, plus a manifest, ' +
        "into <code>dist/kryptonite-offline-bundle/</code>.</div>" +
        '<button class="btn primary" data-act="export">' +
        flash("export", "Bundle written to dist/", "Export offline bundle") + "</button>") +
      "</div>";
    return html;
  }

  /* ─────────────────────────── wiring ─────────────────────────── */

  function wire() {
    $("ccReload").addEventListener("click", function () {
      post("reloadProfiles");
      setFlash("reloadProfiles");
    });

    $("strip").addEventListener("click", function (e) {
      var b = e.target.closest("[data-section]");
      if (!b) return;
      S.section = b.getAttribute("data-section");
      render();
      $("pane").scrollTop = 0;
    });

    $("pane").addEventListener("click", onPaneClick);
  }

  function onPaneClick(e) {
    var t;

    if ((t = e.target.closest("[data-toggle]"))) {
      var key = t.getAttribute("data-toggle");
      var next = t.getAttribute("aria-checked") !== "true";
      post("setConfig", { key: key, value: next });
      return;
    }

    if ((t = e.target.closest("[data-opt]"))) {
      post("setConfig", { key: t.getAttribute("data-opt"), value: t.getAttribute("data-value") });
      return;
    }

    if ((t = e.target.closest("[data-skill]"))) {
      var name = t.getAttribute("data-skill");
      for (var i = 0; i < S.skills.length; i++) {
        if (S.skills[i].name === name) {
          S.skills[i].enabled = !S.skills[i].enabled;
          post("toggleSkill", { name: name, enabled: S.skills[i].enabled });
        }
      }
      render();
      return;
    }

    if ((t = e.target.closest("[data-restore]"))) {
      post("restoreCheckpoint", { hash: t.getAttribute("data-restore") });
      return;
    }

    if ((t = e.target.closest("[data-mcp]"))) {
      if (t.getAttribute("data-mcp") === "reconnect") post("mcpReconnect", { name: t.getAttribute("data-name") });
      return;
    }

    if ((t = e.target.closest("[data-ep]"))) {
      onEndpointAction(t.getAttribute("data-ep"), t.getAttribute("data-id"));
      return;
    }

    if ((t = e.target.closest("[data-sync]"))) {
      SYNC_MIN = Number(t.getAttribute("data-sync")) || 0;
      armAutoSync();
      /* Picking a period is a statement that the numbers on screen are stale,
         so honour it now rather than at the end of the first interval. */
      if (SYNC_MIN > 0) post("healthCheck");
      render();
      return;
    }
    if ((t = e.target.closest("[data-act]"))) {
      onAction(t.getAttribute("data-act"));
      return;
    }
  }

  function onEndpointAction(action, id) {
    if (action === "yaml") { post("openYaml", { profile: id }); return; }
    if (action === "del") { post("deleteEndpoint", { id: id }); return; }
    if (action === "cancel") { S.epForm = null; S.epCheck = null; render(); return; }
    if (action === "check") {
      var draft = readEpForm();
      if (!draft) return;
      S.epCheck = { id: draft.id || "draft", running: true, done: false, ok: false, summary: "", rungs: [] };
      render();
      post("checkEndpoint", { endpoint: epPayload(draft) });
      return;
    }
    if (action === "save") {
      var form = epPayload(readEpForm());
      S.epForm = null;
      S.epCheck = null;
      render();
      if (form.id) post("saveEndpoint", { endpoint: form });
    }
  }

  function onAction(action) {
    switch (action) {
      case "newEndpoint": post("newEndpoint"); break;
      case "health": post("healthCheck"); break;
      case "mcpReload": post("mcpReload"); break;
      case "trace": S.tracing = true; S.rungs = []; render(); post("runTrace"); break;
      case "reloadSkills": post("reloadSkills"); setFlash("reloadSkills"); break;
      case "openSkills": post("openSkillsFolder"); break;
      case "export": post("exportBundle"); break;
      case "clearAuth": post("reloadProfiles"); setFlash("clearAuth"); break;
      case "systemTrust": post("useSystemTrust"); break;
      case "browseCa": post("browseCaBundle"); break;
      case "openTransform": {
        var a = active();
        if (a && a.transform) post("openFile", { path: a.transform });
        break;
      }
      case "copyFix":
        if (S.tlsError) {
          post("copyText", { text: '"' + S.tlsError.fixKey + '": "' + S.tlsError.fixValue + '"' });
          setFlash("copyFix");
        }
        break;
    }
  }

  /* ─────────────────────────── inbound ─────────────────────────── */

  window.addEventListener("message", function (event) {
    var m = event.data;
    if (!m || !m.type) return;

    switch (m.type) {
      case "stateSync": {
        var st = m.state;
        S.workspace = st.workspace;
        S.profiles = (st.profiles || []).map(function (p) {
          /* The host always sends the full shape, but a stale stateSync from an
             older extension version or a test harness might omit sub-objects.
             Filling defaults here keeps every renderer crash-free. */
          if (!p.tls) p.tls = {};
          if (!p.tls.ca) p.tls.ca = [];
          if (!p.proxy) p.proxy = {};
          if (!p.proxy.noProxy) p.proxy.noProxy = [];
          if (!p.auth) p.auth = { kind: "none" };
          return p;
        });
        S.skills = st.skills || [];
        S.skillWarnings = st.skillWarnings || [];
        S.mcp = st.mcp || { servers: [], warnings: [] };
        S.config = st.config;
        S.tlsError = st.tlsError;
        S.rungs = st.rungs || [];
        S.tracing = st.tracing;
        S.traceRun = S.rungs.length > 0;
        S.checkpoints = st.checkpoints || [];
        S.logs = st.logs || [];
        render();
        syncOnOpen();
        break;
      }

      case "mcpChanged":
        S.mcp = { servers: m.servers || [], warnings: m.warnings || [] };
        render();
        break;

      case "healthStarted":
        for (var hi = 0; hi < (m.ids || []).length; hi++) HEALTH_BUSY[m.ids[hi]] = true;
        render();
        /* The host bounds every probe at roughly 25s and always answers with a
           result, so this only fires if the extension host itself went away
           mid-sweep. Without it the Sync button would stay disabled and the
           spinners would turn forever, with no way back short of reopening. */
        clearTimeout(healthWatchdog);
        healthWatchdog = setTimeout(function () {
          if (!healthBusy()) return;
          for (var k in HEALTH_BUSY) HEALTH_BUSY[k] = false;
          render();
        }, 40000);
        break;

      case "healthResult":
        HEALTH_BUSY[m.id] = false;
        HEALTH[m.id] = { ok: m.ok, ms: m.ms, detail: m.detail || "" };
        render();
        break;

      case "profilesReloaded":
        S.profiles = (m.profiles || []).map(function (p) {
          if (!p.tls) p.tls = {};
          if (!p.tls.ca) p.tls.ca = [];
          if (!p.proxy) p.proxy = {};
          if (!p.proxy.noProxy) p.proxy.noProxy = [];
          if (!p.auth) p.auth = { kind: "none" };
          return p;
        });
        render();
        /* A workspace that opened with no profiles still deserves its first
           sweep the moment one appears. */
        syncOnOpen();
        break;

      case "skillsReloaded":
        S.skills = m.skills || [];
        S.skillWarnings = m.warnings || [];
        render();
        break;

      case "configChanged":
        S.config = m.config;
        render();
        break;

      case "traceStarted":
        S.tracing = true;
        S.rungs = [];
        render();
        break;

      case "traceUpdate":
        S.tracing = true;
        S.rungs = S.rungs.slice(0, m.index).concat([m.rung]);
        render();
        break;

      case "endpointCheckStarted":
        readEpForm();
        S.epCheck = { id: m.id, running: true, done: false, ok: false, summary: "", rungs: [] };
        render();
        break;

      case "endpointCheckRung":
        if (!S.epCheck) break;
        readEpForm();
        S.epCheck.rungs = S.epCheck.rungs.concat([m.rung]);
        render();
        break;

      case "endpointCheckDone":
        readEpForm();
        S.epCheck = {
          id: m.id, running: false, done: true,
          ok: !!m.ok, summary: m.summary || "", rungs: m.rungs || []
        };
        render();
        break;

      case "traceDone":
        S.tracing = false;
        S.traceRun = true;
        S.rungs = m.rungs || [];
        render();
        break;

      case "tlsError":
        S.tlsError = m.error;
        render();
        break;

      case "checkpointsListed":
        S.checkpoints = m.checkpoints || [];
        render();
        break;

      case "checkpointRestored":
        render();
        break;

      case "bundleExported":
        setFlash("export", 2000);
        break;

      case "logLine":
        S.logs.push(m.line);
        if (S.logs.length > 200) S.logs.shift();
        if (S.section === "logs") render();
        else renderStrip();
        break;

      case "navigate":
        S.section = m.section;
        render();
        $("pane").scrollTop = 0;
        break;

      case "caBundlePicked":
        post("saveCaBundle", { path: m.path });
        break;

      case "error":
        S.logs.push({ t: Date.now(), level: "error", msg: m.message });
        if (S.section === "logs") render();
        else renderStrip();
        break;

      default:
        /* Session-only traffic: streamDelta, toolStart/End, todos, plans,
           permissions, diffs, selection, sessions, context, status, phase. */
        break;
    }
  });

  /* ─────────────────────────── boot ─────────────────────────── */

  mount();
  wire();
  render();
  post("ready");
})();
} /* end _run */
