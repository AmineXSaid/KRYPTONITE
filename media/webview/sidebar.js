/* Genesis sidebar frontend. Plain DOM, zero dependencies.
 *
 * The store mirrors what the host sends; nothing here is authoritative. The
 * transcript is append-only - a full re-render on every stream delta would
 * discard scroll position and expanded tool cards - while the diagnostics
 * panes re-render wholesale because they are small and always coherent.
 *
 * crystal.js must have run first - see the same guard in controlCenter.js.
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
  /* S6 leaves stroke-linecap/linejoin at the SVG default - butt and mitre -
     which is right for the plain bars and circles most glyphs are made of. The
     glyphs below that carry a taper or a sharp corner (the pencil tip, the
     return arrow) need round, or the mitre grows a visible barb at 16px. */
  var S6R = S6 + ' stroke-linecap="round" stroke-linejoin="round"';
  var ICON_DEFS =
    /* Compose rather than a bare "+": a plus reads as generic "add" - add a
       file? a folder? - while a pencil on a page says start writing, which is
       what the button does and what every chat client uses for it. */
    '<symbol id="i-compose" viewBox="0 0 24 24">' +
      '<path d="M12.5 5H6.5A1.5 1.5 0 0 0 5 6.5v11A1.5 1.5 0 0 0 6.5 19h11a1.5 1.5 0 0 0 1.5-1.5v-6" ' + S6R + ' stroke-width="1.7"/>' +
      '<path d="M17 4.2a1.7 1.7 0 0 1 2.4 2.4l-6 6-2.9.5.5-2.9z" ' + S6R + ' stroke-width="1.7"/></symbol>' +
    /* Two glyphs, not one, because they say different things. A bare clock
       face means TIME - it is correct on the queue, where the subject really
       is waiting. It does not mean THE PAST: the counter-clockwise arrow
       wrapped round the dial is what carries "back", and is what VS Code's own
       `history` codicon uses, so it reads right to anyone living in the
       editor. Do not collapse these two into one symbol. */
    '<symbol id="i-clock" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" ' + S6 + ' stroke-width="1.6"/><path d="M12 8v4.4l3 1.7" ' + S6 + ' stroke-width="1.6"/></symbol>' +
    '<symbol id="i-history" viewBox="0 0 24 24">' +
      '<path d="M4.6 9.4A8 8 0 1 1 4 12.6" ' + S6R + ' stroke-width="1.6"/>' +
      '<path d="M4.2 4.8v4.8h4.8" ' + S6R + ' stroke-width="1.6"/>' +
      '<path d="M12 8.2v4.2l2.8 1.6" ' + S6R + ' stroke-width="1.6"/></symbol>' +
    /* Vertical, because the menu it opens drops downward from the panel's
       right edge and a kebab points the way the menu travels. */
    '<symbol id="i-kebab" viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.5" fill="currentColor"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/><circle cx="12" cy="19" r="1.5" fill="currentColor"/></symbol>' +
    '<symbol id="i-chev" viewBox="0 0 10 10"><path d="M2.5 0.5L7 5l-4.5 4.5" ' + S6 + ' stroke-width="1.4"/></symbol>' +
    '<symbol id="i-caret" viewBox="0 0 10 10"><path d="M1 3l4 4.5L9 3" ' + S6 + ' stroke-width="1.3"/></symbol>' +
    '<symbol id="i-file" viewBox="0 0 24 24"><path d="M6 3h7l5 5v13H6z" ' + S6 + ' stroke-width="1.5"/><path d="M13 3v5h5" ' + S6 + ' stroke-width="1.5"/></symbol>' +
    '<symbol id="i-term" viewBox="0 0 24 24"><rect x="3" y="4.5" width="18" height="15" rx="2" ' + S6 + ' stroke-width="1.5"/><path d="M7 10l3 2.5L7 15M12.5 15.5h4.5" ' + S6 + ' stroke-width="1.5"/></symbol>' +
    '<symbol id="i-search" viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5" ' + S6 + ' stroke-width="1.6"/><path d="M16 16l4.5 4.5" ' + S6 + ' stroke-width="1.6"/></symbol>' +
    '<symbol id="i-book" viewBox="0 0 24 24"><path d="M4 5.5c3-1.2 5.5-1.2 8 .5v13c-2.5-1.7-5-1.7-8-.5zM20 5.5c-3-1.2-5.5-1.2-8 .5v13c2.5-1.7 5-1.7 8-.5z" ' + S6 + ' stroke-width="1.5"/></symbol>' +
    '<symbol id="i-check" viewBox="0 0 24 24"><path d="M4.5 12.5l5 5 10-11" ' + S6 + ' stroke-width="2"/></symbol>' +
    // A skipped rung. Not a hyphen in text - the ladder's states are glyphs on
    // a rail now, and "nothing happened here" needs a shape of its own or it
    // falls back to being the absence of one, which is where pass and fail
    // started.
    '<symbol id="i-minus" viewBox="0 0 24 24"><path d="M6 12h12" ' + S6 + ' stroke-width="2"/></symbol>' +
    '<symbol id="i-x" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" ' + S6 + ' stroke-width="2"/></symbol>' +
    '<symbol id="i-warn" viewBox="0 0 24 24"><path d="M12 3l9.5 17H2.5z" ' + S6 + ' stroke-width="1.5"/><path d="M12 9.5v5M12 17v.5" ' + S6 + ' stroke-width="1.6"/></symbol>' +
    '<symbol id="i-info" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5" ' + S6 + ' stroke-width="1.5"/><path d="M12 11v5.5M12 7.5v.5" ' + S6 + ' stroke-width="1.7"/></symbol>' +
    '<symbol id="i-clip" viewBox="0 0 24 24"><path d="M17.5 10.5l-6.8 6.8a3 3 0 01-4.2-4.2l7.5-7.5a4.5 4.5 0 016.4 6.4l-7.5 7.5" ' + S6 + ' stroke-width="1.5"/></symbol>' +
    '<symbol id="i-up" viewBox="0 0 24 24"><path d="M12 19V5M6 11l6-6 6 6" ' + S6 + ' stroke-width="1.7"/></symbol>' +
    '<symbol id="i-stop" viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor"/></symbol>' +
    /* The three mode glyphs, lifted from the Genesis defs unchanged: an open
       palm for "stop and ask", angle brackets for "edits go through", a bolt
       for "decide for me". */
    '<symbol id="i-hand" viewBox="0 0 24 24"><path d="M9 11.4V5.6a1.4 1.4 0 0 1 2.8 0v5.8m0 0V4.7a1.4 1.4 0 0 1 2.8 0v6.7m0 0V6.6a1.4 1.4 0 0 1 2.8 0V13c0 4.4-2.3 7.6-6.1 7.6S6.2 17.4 6.2 13v-2.1a1.4 1.4 0 0 1 2.8 0v.5" ' + S6 + ' stroke-width="1.5"/></symbol>' +
    '<symbol id="i-code" viewBox="0 0 24 24"><path d="M9.5 7.5L5 12l4.5 4.5M14.5 7.5L19 12l-4.5 4.5" ' + S6 + ' stroke-width="1.7"/></symbol>' +
    '<symbol id="i-bolt" viewBox="0 0 24 24"><path d="M13.2 3L6 13.6h4.6L10.2 21 17.4 10.4h-4.6z" ' + S6 + ' stroke-width="1.5"/></symbol>' +
    '<symbol id="i-globe" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5" ' + S6 + ' stroke-width="1.5"/><path d="M3.5 12h17M12 3.5c-4.5 5-4.5 12 0 17 4.5-5 4.5-12 0-17z" ' + S6 + ' stroke-width="1.4"/></symbol>' +
    '<symbol id="i-monitor" viewBox="0 0 24 24"><rect x="3" y="4.5" width="18" height="12" rx="1.5" ' + S6 + ' stroke-width="1.5"/><path d="M9 20h6M12 16.5V20" ' + S6 + ' stroke-width="1.5"/></symbol>' +
    '<symbol id="i-pencil" viewBox="0 0 24 24"><path d="M16.5 3.8l3.7 3.7L8.4 19.3l-4.7.9.9-4.7z" ' + S6 + ' stroke-width="1.5"/></symbol>' +
    '<symbol id="i-trash" viewBox="0 0 24 24"><path d="M4 6.5h16M9.5 6.5V4h5v2.5M6.5 6.5l1 14h9l1-14" ' + S6 + ' stroke-width="1.5"/></symbol>' +
    '<symbol id="i-copy" viewBox="0 0 24 24"><rect x="8.5" y="8.5" width="12" height="12" rx="1.5" ' + S6 + ' stroke-width="1.5"/><path d="M15.5 8.5v-3a1.5 1.5 0 00-1.5-1.5H5a1.5 1.5 0 00-1.5 1.5v9A1.5 1.5 0 005 16h3" ' + S6 + ' stroke-width="1.5"/></symbol>' +
    /* Branch: two nodes on a trunk with a limb leaving it - the git-branch
       shape, which is what "branch this conversation" means here. */
    '<symbol id="i-branch" viewBox="0 0 24 24"><circle cx="7" cy="5.5" r="2.4" ' + S6 + ' stroke-width="1.6"/>' +
      '<circle cx="7" cy="18.5" r="2.4" ' + S6 + ' stroke-width="1.6"/>' +
      '<circle cx="17.5" cy="8.5" r="2.4" ' + S6 + ' stroke-width="1.6"/>' +
      '<path d="M7 8v8M17.5 11v1.2a4 4 0 01-4 4H9.4" ' + S6 + ' stroke-width="1.6"/></symbol>' +
    '<symbol id="i-refresh" viewBox="0 0 24 24"><path d="M20 12a8 8 0 11-2.4-5.7M20 3.5V9h-5.5" ' + S6 + ' stroke-width="1.6"/></symbol>' +
    '<symbol id="i-folder" viewBox="0 0 24 24"><path d="M3 6h6l2 3h10v10H3z" ' + S6 + ' stroke-width="1.5"/></symbol>' +
    /* Download: an arrow into a tray. Distinct from i-up, which is the send
       arrow and points the other way. */
    '<symbol id="i-download" viewBox="0 0 24 24"><path d="M12 4v10.5M7.5 10.5L12 15l4.5-4.5" ' + S6 + ' stroke-width="1.6"/>' +
      '<path d="M4.5 17.5V20h15v-2.5" ' + S6 + ' stroke-width="1.6"/></symbol>' +
    /* Agent: a facet, cut from the same geometry as the crystal - the mark
       for "a configured persona" rather than a person's silhouette, which
       would suggest a human on the other end. */
    '<symbol id="i-agent" viewBox="0 0 24 24"><path d="M12 3l7 4.5v9L12 21l-7-4.5v-9z" ' + S6 + ' stroke-width="1.5"/>' +
      '<path d="M12 3v18M5 7.5l14 9M19 7.5l-14 9" ' + S6 + ' stroke-width="1.1" opacity=".55"/></symbol>' +
    '<symbol id="i-diff" viewBox="0 0 24 24"><path d="M6 3.5v17M3 7h6M3 17h6" ' + S6 + ' stroke-width="1.6"/>' +
      '<path d="M15 3.5h6v6h-6zM15 14.5h6v6h-6z" ' + S6 + ' stroke-width="1.5"/></symbol>' +
    /* The approval control. A shield rather than a lock: a lock says "you
       cannot", and this says "something is standing between the agent and the
       workspace" - which is a guard, not a barrier. */
    // KEPT, and it is the one symbol nothing draws. renderPerm's comment records
    // why the shield left the mode button - it said nothing about which mode was
    // in force and read as a security badge - and the sheet's rows take their
    // glyphs from PERMS. It stays defined because the icon sheet is the panel's
    // vocabulary rather than a list of current call sites, and deleting it would
    // make the comment explaining its removal point at nothing.
    '<symbol id="i-shield" viewBox="0 0 24 24"><path d="M12 3l7.5 3v6c0 4.2-3 7.6-7.5 9-4.5-1.4-7.5-4.8-7.5-9V6z" ' +
      S6 + ' stroke-width="1.5" stroke-linejoin="round"/></symbol>' +
    /* The `@` that references a file, DRAWN rather than typed.
       It was the literal character in a button beside the paperclip, so two
       controls in the same group were a glyph from the UI font at 13px and an
       icon from this sheet at 13px - different weights, different optical
       sizes, different vertical centres. This is the same at-sign as a stroked
       path on the same 24px grid as its neighbour, so the pair reads as one
       set of controls. */
    '<symbol id="i-at" viewBox="0 0 24 24">' +
      '<circle cx="12" cy="12" r="3.6" ' + S6 + ' stroke-width="1.6"/>' +
      '<path d="M15.6 8.4v5a2.4 2.4 0 0 0 4.8 0V12a8.4 8.4 0 1 0-3.3 6.7" ' +
        S6 + ' stroke-width="1.6" stroke-linecap="round"/></symbol>';

  /* Ladder rung name -> the short label the design shows. */
  var RUNG_LABELS = {
    "Certificates and keys": "Config", "Profile": "Config", "DNS": "DNS", "TCP": "TCP",
    "TLS handshake": "TLS", "Authentication": "Auth", "Completion": "HTTP",
    "Streaming": "Stream", "Tool calling": "Tools", "Proxy tunnel": "Proxy"
  };

  /* GitHub-flavoured callout kinds -> the glyph each one wears. */
  var CALLOUT_ICON = {
    note: "i-info", tip: "i-info", important: "i-info",
    warning: "i-warn", caution: "i-warn"
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

  /* Waiting verbs.
   *
   * A tool call names its own work ("Editing watcher.ts") and that always wins
   * - these only cover the stretches where the model is thinking and there is
   * genuinely nothing to report. One is drawn per turn and held for its whole
   * length: rotating mid-turn reads as progress that is not happening, which is
   * worse than a flat label. Green-crystal flavour, kept short enough not to
   * push the elapsed counter off a 340px panel.
   */
  var IDLE_VERBS = [
    "Charging the crystal…", "Reticulating splines…", "Consulting the shard…",
    "Warming the reactor…", "Bending light…", "Thinking in emerald…",
    "Doing radiation maths…", "Aligning the lattice…", "Overloading politely…",
    "Chasing a hunch…", "Rummaging in the toolbox…", "Turning it over…",
    "Sharpening the answer…", "Weighing the options…", "Following the thread…"
  ];
  var PLAN_VERBS = [
    "Sketching…", "Imagining…", "Shaping the idea…", "Drawing on the napkin…",
    "Dreaming up options…", "Designing…", "Picturing it…", "Storyboarding…"
  ];
  var ASK_VERBS = [
    "Reading up…", "Checking the record…", "Looking it up…", "Following the trail…",
    "Cross-referencing…", "Scanning the shard…", "Getting the facts straight…", "Tracing it back…"
  ];
  function pickVerb(phase) {
    var pool = phase === "plan" ? PLAN_VERBS : phase === "ask" ? ASK_VERBS : IDLE_VERBS;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  /* Extension features, not skills. `/` lists the workspace's SKILL.md files
     first and these underneath - see slashItems(). `/skill:` is gone: every
     skill now has its own row, which is what it was a stand-in for. */
  /* The first four act on the editor rather than on the chat: they are the
     same features as the lightbulb and the CodeLens, reached from the
     keyboard, and they take their target from wherever the cursor is. They sit
     at the top because they are the ones with a reason to be typed mid
     sentence. */
  var CMDS = [
    ["/fix", "Fix the problems where the cursor is"],
    ["/doc", "Document the function where the cursor is"],
    ["/explain", "Explain the selection"],
    ["/tests", "Write tests for the selection"],
    ["/commit", "Write a commit message for the staged change"],
    ["/clear", "Clear conversation history"],
    ["/doctor", "Run TLS connection diagnostics"],
    ["/endpoints", "Manage endpoint profiles"],
    ["/model", "Select a model"],
    ["/review", "Review current changes"],
    ["/checkpoint", "Restore a previous checkpoint"],
    ["/export", "Export this conversation as JSON"],
    ["/agent", "Speak as one of this workspace's agents"],
    ["/skills", "Open the skills panel"],
    ["/help", "Show available commands"]
  ];

  /* Slash command to host command. A lookup rather than string interpolation
     on the host side: the webview should not be able to name an arbitrary
     command and have the extension run it. */
  var EDITOR_CMDS = {
    "/fix": "fix", "/doc": "doc", "/explain": "explain",
    "/tests": "tests", "/commit": "commit"
  };

  /* The three openers on the welcome screen.
   *
   * Each is an existing capability rather than a sample prompt: `run` is either
   * a slash command this panel already routes, or the literal text of one. They
   * point at what the user has open - this file, these changes, this selection -
   * so none of them can name code that does not exist here. */
  var STARTERS = [
    { icon: "i-file", text: "Explain the file I have open", run: "/explain" },
    { icon: "i-diff", text: "Review my uncommitted changes", run: "review" },
    { icon: "i-book", text: "Write tests for the selected function", run: "/tests" }
  ];

  var REVIEW_PROMPT =
    "Review the changes currently in the workspace. Read the modified files, " +
    "summarise what changed, and flag anything risky or inconsistent.";

  var EP_ICON = {
    anthropic: "i-kx", "openai-compatible": "i-globe", azure: "i-globe",
    local: "i-monitor", custom: "i-globe", raw: "i-globe", openai: "i-globe"
  };

  /* What kind of model an endpoint serves, as the picker and the form say it.
   *
   * The IDS are the contract with src/endpoints/llmKind.ts and must not drift -
   * test/llm-kind.cjs pins the two lists against each other. What lives here
   * and nowhere else is the PRESENTATION: the label, the one-line note, and the
   * hue. That split is deliberate; the host owns which kinds exist and what
   * capabilities each one implies, and the webview owns what they look like.
   *
   * The hues are the Genesis accent roles, one per kind, chosen so the badge
   * survives a glance down a list of eight endpoints:
   *   chat        neutral   - the baseline. A badge earns colour by being
   *                           unusual, and "an ordinary chat model" is not.
   *   reasoning   purple    - the "capability from outside" hue, same claim
   *                           the MCP chips make.
   *   multimodal  green     - it can do something the others cannot.
   *   coding      blue      - information / the working default for this tool.
   *   completion  orange    - attention: it cannot drive the agent loop.
   */
  var LLM_KINDS = [
    { id: "chat", label: "Chat", note: "General instruction-following turns", hue: "var(--kx-fg-3)" },
    { id: "reasoning", label: "Reasoning", note: "Thinks before answering; slower, stronger", hue: "var(--kx-agent)" },
    { id: "multimodal", label: "Multimodal", note: "Reads images as well as text", hue: "var(--kx-accent)" },
    { id: "coding", label: "Coding", note: "Tuned for code edits and repo work", hue: "var(--kx-ask)" },
    { id: "completion", label: "Completion", note: "Fill-in-the-middle; drives ghost text", hue: "var(--kx-active)" }
  ];

  /* Resolve a kind id to its descriptor.
   *
   * Falls back to chat rather than returning undefined: a profile written by
   * hand can carry a kind this build has never heard of, and a picker row that
   * throws is worse than one that under-claims. Kept self-contained and at this
   * level because test/mcp-render.cjs and friends lift whole functions out of
   * this file by brace matching. */
  function llmKind(id) {
    for (var i = 0; i < LLM_KINDS.length; i++) {
      if (LLM_KINDS[i].id === id) return LLM_KINDS[i];
    }
    return LLM_KINDS[0];
  }

  /* What choosing this kind will actually do to the generated profile.
   *
   * The field would be decorative if it only set a label, so it seeds the
   * capability block - and the form says so before the user commits, rather
   * than leaving them to diff the YAML afterwards. Mirrors capabilitiesFor()
   * in src/endpoints/llmKind.ts; test/llm-kind.cjs pins the pair. */
  /* How much context the endpoint behind a model has, as the mockup writes it:
     a short mono figure on the right of the row. Returns "" when the profile
     never declared one, so the slot collapses rather than printing a zero.

     Self-contained and at this level for the same brace-matching reason as
     llmKind above - test/mcp-render.cjs lifts whole functions out of this file. */
  function ctxLabel(endpointId) {
    var win = 0;
    for (var i = 0; i < S.profiles.length; i++) {
      if (S.profiles[i].id !== endpointId) continue;
      win = (S.profiles[i].capabilities && S.profiles[i].capabilities.contextWindow) || 0;
      break;
    }
    if (!win) return "";
    if (win >= 1000000) return (Math.round(win / 100000) / 10) + "M";
    if (win >= 1000) return Math.round(win / 1000) + "K";
    return String(win);
  }

  function kindImplies(id) {
    if (id === "multimodal") return "Turns vision on.";
    if (id === "reasoning") return "Raises the output budget to 8192 - thinking spends tokens before the answer does.";
    if (id === "completion") return "Turns tools OFF and fim on: a fill-in-the-middle model cannot drive the agent loop.";
    return "Uses the stock capability defaults.";
  }

  /* Chars of a tool result rendered before the Show-more expander.
   *
   * Was 100,000, which is not a limit - it is larger than almost every result,
   * so a 72,000-character skill body rendered in full and buried the
   * conversation under a wall of documentation. 3,000 shows enough to tell what
   * came back, and the expander is one click away. */
  var INLINE_LIMIT = 3000;
  var MODEL_TRUNCATION = 60000; /* what loop.ts hands the model */
  var MAX_DIFF_ROWS = 600;

  /* ───────────────────────────── store ───────────────────────────── */

  var S = {
    hydrated: false,
    workspace: { open: false, name: null },
    /** Messages waiting for the running turn to finish, newest last. */
    queue: [],
    running: false,
    phase: "act",
    endpoint: null,
    profiles: [],
    skills: [],
    skillWarnings: [],
    agents: [],
    agentWarnings: [],
    activeAgent: "",
    mcp: { servers: [], warnings: [] },
    config: { approvalMode: "ask", activeProfile: "", caBundlePath: "", ui: {} },
    tlsError: null,
    rungs: [],
    tracing: false,
    traceRun: false,
    todos: [],
    sessions: [],
    selection: null,
    /** Last editorContextChanged from the host; null until the first one. */
    editor: null,
    context: null,
    changes: [],
    models: [],
    /* local-only */
    changesOpen: false,
    agentOpen: false,
    tab: "session",
    /* The host's StatusDto. Held because renderFooter reads its `state` for the
       endpoint health dot - a 502 is a failing endpoint with no TLS error in
       sight, and the dot used to know only about TLS. */
    status: null,
    qp: null,
    qpIndex: 0,
    modelOpen: false,
    epForm: null,
    epCheck: null,
    caUpload: null,
    files: [],
    fileQuery: "",
    copied: false,
    reloaded: false,
    gerund: "Thinking…",
    idleVerb: null,
    elapsed: 0,
    timer: null,
    searchTimer: null,
    attachments: [],
    sessionId: null,
    title: ""
  };

  /* transcript element handles */
  var logEl, aiEl = null, streamEl = null, pendingTool = null, todoEl = null;
  /* The open tool strip consecutive calls are appended to, or null. */
  var toolGroup = null;

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
  /* Square by construction, so a call site passing one number cannot stretch
     it. `variant` picks the roundel's cut - "dim", "sm", "notch", or the full
     mark when omitted - and is passed straight through. */
  function crystal(h, cls, variant) { return window.__kxCrystal.svg(h, cls, variant); }
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

  /* ───────────────────────── markdown ─────────────────────────
   *
   * Enough CommonMark + GFM to render what a coding model actually emits:
   * fenced code with a language label, ATX headings, ordered and unordered
   * lists, pipe tables, blockquotes, thematic breaks, and inline code, bold,
   * italic, strikethrough and links.
   *
   * The previous renderer handled fences, bold and inline code only, so a
   * reply containing "### Rust", a "---" rule or a table came out as literal
   * punctuation - which is most replies.
   *
   * SECURITY: every branch escapes before it composes. `esc()` runs on raw
   * source text first and the markup is built from the escaped result, so a
   * model that emits `<img onerror=…>` cannot reach innerHTML as an element.
   * Nothing here ever interpolates unescaped model output.
   */

  function inline(src) {
    var codes = [];
    /* esc() has already turned every < into &lt;, so a bare "<C0>" cannot occur
       in the escaped text and is safe as a placeholder. Inline code is pulled
       out before emphasis runs so that `a_b_c` or `**` inside a span survives
       verbatim, then put back at the end. */
    var s = esc(src).replace(/`([^`]+)`/g, function (_m, code) {
      codes.push(code);
      return "<C" + (codes.length - 1) + ">";
    });

    /* Links: [text](url). Only http/https/mailto survive - a javascript: or
       data: href from model output collapses to its text. */
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (_m, text, href) {
      return /^(https?:|mailto:)/i.test(href)
        ? '<a href="' + href + '" title="' + href + '">' + text + "</a>"
        : text;
    });

    s = s
      .replace(/\*\*\*([^*]+)\*\*\*/g, "<strong><em>$1</em></strong>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>")
      .replace(/(^|[\s(])_([^_\n]+)_/g, "$1<em>$2</em>")
      .replace(/~~([^~]+)~~/g, "<del>$1</del>");

    return s.replace(/<C(\d+)>/g, function (_m, i) {
      return "<code>" + codes[Number(i)] + "</code>";
    });
  }

  function isTableRule(line) {
    return /^\s*\|?[\s:-]*-[\s:|-]*\|?\s*$/.test(line) && line.indexOf("-") !== -1;
  }
  function cells(line) {
    var t = line.trim().replace(/^\|/, "").replace(/\|$/, "");
    return t.split("|").map(function (c) { return c.trim(); });
  }

  /* ─────────────────────── syntax highlighting ─────────────────────── */

  /*
   * Four grammars, not forty.
   *
   * A transcript shows short excerpts, so what matters is that strings,
   * comments, numbers and keywords separate at a glance - not that every
   * dialect is modelled exactly. Languages are folded into the family whose
   * lexical shape they share, which is why Rust, C and TypeScript are one
   * entry: the things being coloured here are identical across them.
   *
   * Everything runs off one alternation per family, scanned left to right, so
   * a token can never be found inside a string or comment that already
   * claimed those characters. Text is escaped as each token is emitted rather
   * than up front, so the tokeniser never sees `&amp;` where a `&` was.
   */
  var KW_C = "auto|break|case|char|const|continue|default|do|double|else|enum|extern|float|for|goto|if|inline|int|long|register|restrict|return|short|signed|sizeof|static|struct|switch|typedef|union|unsigned|void|volatile|while|bool|true|false|NULL|nullptr|class|public|private|protected|virtual|override|template|typename|namespace|using|new|delete|this|try|catch|throw|fn|let|mut|impl|trait|pub|crate|mod|match|move|ref|where|async|await|dyn|unsafe|as|in|loop|Some|None|Ok|Err|self|Self|function|var|const|export|import|from|interface|type|extends|implements|readonly";
  var KW_PY = "and|as|assert|async|await|break|class|continue|def|del|elif|else|except|finally|for|from|global|if|import|in|is|lambda|nonlocal|not|or|pass|raise|return|try|while|with|yield|True|False|None|self|cls|match|case";

  /* PowerShell and SQL are written in mixed case by convention - `param` and
     `Param`, `select` and `SELECT` - and a rule cannot carry its own /i here
     because every rule is fused into one alternation that keeps only its own
     flags. Those two families get the flag applied to the whole alternation
     instead; see GRAMMAR_FLAGS. */
  var KW_PS =
    "param|function|filter|begin|process|end|dynamicparam|if|elseif|else|switch|" +
    "foreach|for|while|do|until|break|continue|return|throw|try|catch|finally|trap|" +
    "class|enum|using|namespace|in|exit|hidden|static|data|inlinescript|workflow|" +
    "parallel|sequence|configuration";
  var KW_SQL =
    "select|from|where|insert|into|values|update|set|delete|create|alter|drop|table|" +
    "view|index|join|inner|left|right|full|outer|cross|on|as|and|or|not|null|is|in|" +
    "between|like|order|by|group|having|limit|offset|union|all|distinct|case|when|" +
    "then|else|end|primary|foreign|key|references|default|unique|constraint|cascade|" +
    "begin|commit|rollback|transaction|with|exists|any|asc|desc|count|sum|avg|min|max";
  var KW_SH =
    "if|then|elif|else|fi|for|while|until|do|done|case|esac|in|function|return|local|" +
    "export|source|alias|shift|exit|break|continue|set|unset|readonly|declare|eval|" +
    "trap|echo|cd|test|printf|read|shopt";

  var KW_BAT =
    "set|setlocal|endlocal|echo|if|else|for|in|do|goto|call|exit|pause|shift|" +
    "cd|chdir|md|mkdir|rd|rmdir|del|erase|copy|xcopy|move|ren|rename|type|find|" +
    "findstr|start|title|color|cls|pushd|popd|not|exist|defined|errorlevel|equ|" +
    "neq|lss|leq|gtr|geq|on|off";

  /* Whole-alternation flags, per family. Batch and SQL are conventionally
     written in several cases, and PowerShell keywords genuinely are
     case-insensitive to the interpreter. */
  var GRAMMAR_FLAGS = { ps: "i", sql: "i", bat: "i" };

  var GRAMMAR = {
    c: [
      ["cm", /\/\*[\s\S]*?\*\/|\/\/[^\n]*/],
      ["st", /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`/],
      ["at", /#\s*\w+/],                                  // preprocessor
      ["nu", /\b0[xXbB][0-9a-fA-F_]+|\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?[a-zA-Z_]*/],
      ["kw", new RegExp("\\b(?:" + KW_C + ")\\b")],
      ["ty", /\b[A-Z]\w*/],                               // types are capitalised
      ["fn", /\b[A-Za-z_]\w*(?=\s*[(<])/],
      ["pu", /[{}()[\];,.<>+\-*/%=!&|^~?:@#]/],
    ],
    py: [
      ["cm", /#[^\n]*/],
      ["st", /"""[\s\S]*?"""|'''[\s\S]*?'''|[rbfu]*"(?:\\[\s\S]|[^"\\])*"|[rbfu]*'(?:\\[\s\S]|[^'\\])*'/],
      ["at", /@[\w.]+/],                                  // decorators
      ["nu", /\b0[xXbB][0-9a-fA-F_]+|\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?/],
      ["kw", new RegExp("\\b(?:" + KW_PY + ")\\b")],
      ["ty", /\b[A-Z]\w*/],
      ["fn", /\b[A-Za-z_]\w*(?=\s*\()/],
      ["pu", /[{}()[\];,.:=+\-*/%<>!&|^~]/],
    ],
    json: [
      ["cm", /\/\/[^\n]*/],                               // jsonc, and mcp.json uses it
      ["at", /"(?:\\[\s\S]|[^"\\])*"(?=\s*:)/],           // a key, not a value
      ["st", /"(?:\\[\s\S]|[^"\\])*"/],
      ["kw", /\b(?:true|false|null)\b/],
      ["nu", /-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/],
      ["pu", /[{}[\],:]/],
    ],
    xml: [
      ["cm", /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>/],
      ["ty", /<\/?[\w:.-]+|\/?>/],                        // the tag itself
      ["at", /[\w:.-]+(?=\s*=)/],
      ["st", /"(?:\\[\s\S]|[^"\\])*"|'(?:[^'])*'/],
      ["nu", /\b\d+(?:\.\d+)?\b/],
      ["pu", /[=&;]/],
    ],
    /* PowerShell. Here-strings come before ordinary quotes because @" … "@ can
       contain both kinds and would otherwise be shredded by the string rule.
       The backtick is PowerShell's escape character, not the backslash. */
    ps: [
      ["cm", /<#[\s\S]*?#>|#[^\n]*/],
      ["st", /@"[\s\S]*?"@|@'[\s\S]*?'@|"(?:`[\s\S]|[^"`])*"|'(?:''|[^'])*'/],
      ["ty", /\[[A-Za-z_][\w.]*(?:\[\])?\]/],             // [string], [int[]]
      ["va", /\$(?:\{[^}\n]*\}|[\w:]+)/],                 // $x, ${x}, $env:PATH
      ["at", /(?<=\s)--?[A-Za-z][\w-]*/],                 // -Recurse, --flag
      ["nu", /\b0x[0-9a-fA-F]+\b|\b\d+(?:\.\d+)?(?:[kmgt]b)?\b/],
      ["kw", new RegExp("\\b(?:" + KW_PS + ")\\b")],
      ["fn", /\b[A-Za-z]+-[A-Za-z]\w*/],                  // Verb-Noun cmdlets
      ["pu", /[{}()[\];,.|&<>+\-*/%=!@]/],
    ],
    /* POSIX shell. Was previously routed to the Python grammar, which shares
       the # comment but knows nothing about $expansion - the single most
       common thing in a shell script. */
    sh: [
      ["cm", /#[^\n]*/],
      ["st", /"(?:\\[\s\S]|[^"\\])*"|'[^']*'/],
      ["va", /\$(?:\{[^}\n]*\}|\(\(?|[\w]+|[@*#?$!0-9-])/],
      ["kw", new RegExp("\\b(?:" + KW_SH + ")\\b")],
      ["at", /(?<=\s)--?[A-Za-z][\w-]*/],
      ["nu", /\b\d+\b/],
      ["pu", /[{}()[\];|&<>=!`]/],
    ],
    /* Windows batch. It borrowed the PowerShell grammar, which shares almost
       nothing with it: REM is not a comment there, %VAR% is not a variable,
       and SET is not a keyword, so a .bat file came out nearly bare. */
    bat: [
      ["cm", /(?:^|\n)\s*(?:rem\b|::)[^\n]*/],
      ["st", /"[^"\n]*"/],
      ["va", /%[\w~$#*]+%?|![\w]+!|%%?[\w~]/],            // %PATH%, !delayed!, %%i
      ["ty", /(?:^|\n)\s*:[\w.-]+/],                      // a label
      ["at", /(?<=\s)\/[A-Za-z?][\w]*/],                  // /f /i switches
      ["kw", new RegExp("\\b(?:" + KW_BAT + ")\\b")],
      ["nu", /\b\d+\b/],
      ["pu", /[@()[\];,|&<>=+]/],
    ],
    yaml: [
      ["cm", /#[^\n]*/],
      ["st", /"(?:\\[\s\S]|[^"\\])*"|'(?:''|[^'])*'/],
      ["at", /[\w.\/-]+(?=\s*:(?:\s|$))/],                // a key
      ["kw", /\b(?:true|false|null|yes|no|on|off|True|False|None)\b/],
      ["nu", /\b\d+(?:\.\d+)?\b/],
      ["ty", /(?:[&*]|!!?)[\w:/.-]+/],                    // anchors, aliases, tags
      ["pu", /[:[\]{},>|]|(?:^|\n)\s*-(?=\s)/],
    ],
    ini: [
      ["cm", /[#;][^\n]*/],
      ["ty", /\[[^\]\n]*\]/],                             // [section]
      ["at", /[\w.-]+(?=\s*=)/],
      ["st", /"(?:\\[\s\S]|[^"\\])*"|'[^']*'/],
      ["kw", /\b(?:true|false)\b/],
      ["nu", /\b\d+(?:\.\d+)?\b/],
      ["pu", /[=,]/],
    ],
    sql: [
      ["cm", /--[^\n]*|\/\*[\s\S]*?\*\//],
      ["st", /'(?:''|[^'])*'/],
      ["at", /"(?:[^"])*"|`(?:[^`])*`|\[[^\]\n]*\]/],     // quoted identifiers
      ["kw", new RegExp("\\b(?:" + KW_SQL + ")\\b")],
      ["nu", /\b\d+(?:\.\d+)?\b/],
      ["fn", /\b[A-Za-z_]\w*(?=\s*\()/],
      ["pu", /[(),;.*=<>+\-/|]/],
    ],
    css: [
      ["cm", /\/\*[\s\S]*?\*\//],
      ["st", /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'/],
      ["at", /@[\w-]+|--[\w-]+/],                         // at-rules, custom props
      ["nu", /#[0-9a-fA-F]{3,8}\b|\b-?\d+(?:\.\d+)?(?:px|em|rem|ex|ch|vh|vw|vmin|vmax|%|s|ms|deg|turn|fr|pt)?\b/],
      ["fn", /[\w-]+(?=\s*\()/],
      ["ty", /[.#][A-Za-z_][\w-]*|::?[a-z-]+(?![\w(])/],  // selectors, pseudo
      ["kw", /[a-z-]+(?=\s*:)/],                          // property names
      ["pu", /[{}();,:>~+*]/],
    ],
    /* Diff is line-oriented, so each rule claims a whole line. `^` is written
       as (?:^|\n) because the fused alternation carries no /m flag. */
    diff: [
      ["cm", /(?:^|\n)@@[^\n]*/],
      ["kw", /(?:^|\n)(?:diff |index |--- |\+\+\+ )[^\n]*/],
      ["ad", /(?:^|\n)\+[^\n]*/],
      ["de", /(?:^|\n)-[^\n]*/],
    ],
  };

  /* Which family a fence label belongs to. Unknown labels render unhighlighted
     rather than guessing - a wrong grammar is more distracting than none. */
  var LANG_FAMILY = {
    // C-like: braces, // comments, capitalised types
    c: "c", h: "c", cpp: "c", "c++": "c", cc: "c", cxx: "c", hpp: "c", hxx: "c",
    cs: "c", csharp: "c", java: "c", rs: "c", rust: "c", go: "c", golang: "c",
    js: "c", jsx: "c", mjs: "c", cjs: "c", ts: "c", tsx: "c", mts: "c",
    javascript: "c", typescript: "c", node: "c", swift: "c", kt: "c", kotlin: "c",
    php: "c", scala: "c", groovy: "c", dart: "c", zig: "c", d: "c", v: "c",
    verilog: "c", sv: "c", systemverilog: "c", glsl: "c", hlsl: "c", wgsl: "c",
    proto: "c", protobuf: "c", thrift: "c", graphql: "c", gql: "c", solidity: "c",
    sol: "c", hcl: "c", terraform: "c", tf: "c", jsonnet: "c", pde: "c",
    objc: "c", "objective-c": "c", m: "c", mm: "c", awk: "c", pas: "c", pascal: "c",

    // Hash comments, indentation-led
    py: "py", python: "py", python3: "py", rb: "py", ruby: "py", pl: "py",
    perl: "py", r: "py", jl: "py", julia: "py", lua: "py", nim: "py", cr: "py",
    crystal: "py", ex: "py", exs: "py", elixir: "py", erl: "py", erlang: "py",
    coffee: "py", tcl: "py", cmake: "py", make: "py", makefile: "py", mk: "py",
    gradle: "py", nix: "py", elm: "py", hs: "py", haskell: "py", clj: "py",
    clojure: "py", vim: "py", vimscript: "py", asm: "py", s: "py", nasm: "py",
    gitignore: "py", editorconfig: "py", properties: "py", env: "py",
    dotenv: "py", dockerfile: "py", containerfile: "py", requirements: "py",

    // Shell: $expansion is the whole point, and the py grammar has none
    sh: "sh", bash: "sh", zsh: "sh", shell: "sh", ksh: "sh", fish: "sh",
    console: "sh", shellsession: "sh", terminal: "sh",

    // PowerShell: <# #> comments, $vars, -Parameters, Verb-Noun cmdlets
    ps: "ps", ps1: "ps", psm1: "ps", psd1: "ps", powershell: "ps", pwsh: "ps",
    posh: "ps",

    // Windows batch, which shares almost nothing with PowerShell
    bat: "bat", cmd: "bat", batch: "bat", dosbatch: "bat", btm: "bat",

    yml: "yaml", yaml: "yaml",
    toml: "ini", ini: "ini", conf: "ini", cfg: "ini", desktop: "ini",

    json: "json", jsonc: "json", json5: "json", geojson: "json",
    ipynb: "json", webmanifest: "json",

    xml: "xml", arxml: "xml", html: "xml", htm: "xml", xhtml: "xml", svg: "xml",
    xsd: "xml", xsl: "xml", xslt: "xml", plist: "xml", vue: "xml", svelte: "xml",
    jsp: "xml", aspx: "xml", ejs: "xml", handlebars: "xml", hbs: "xml",
    razor: "xml", wsdl: "xml", rss: "xml", atom: "xml", pom: "xml", csproj: "xml",
    axaml: "xml", xaml: "xml", ui: "xml", kml: "xml", gpx: "xml", odx: "xml",

    sql: "sql", mysql: "sql", pgsql: "sql", postgres: "sql", postgresql: "sql",
    sqlite: "sql", plsql: "sql", tsql: "sql", hive: "sql", ddl: "sql",

    css: "css", scss: "css", sass: "css", less: "css", styl: "css", stylus: "css",
    postcss: "css",

    diff: "diff", patch: "diff", udiff: "diff",
  };

  function highlight(code, lang) {
    // A label may arrive as "ps1", "PowerShell" or "generate.ps1"; take the
    // extension when it looks like a filename, since fences are often labelled
    // with the file they came from.
    var raw = String(lang || "").toLowerCase().trim();
    var fam = LANG_FAMILY[raw];
    if (!fam && raw.indexOf(".") !== -1) fam = LANG_FAMILY[raw.slice(raw.lastIndexOf(".") + 1)];
    var rules = GRAMMAR[fam];
    if (!rules) return esc(code);

    // One alternation, so the leftmost match always wins and a keyword can
    // never be found inside a string that started earlier.
    var src = rules.map(function (r) { return "(" + r[1].source + ")"; }).join("|");
    var re = new RegExp(src, "g" + (GRAMMAR_FLAGS[fam] || ""));
    var out = "";
    var last = 0;
    var m;
    while ((m = re.exec(code)) !== null) {
      // A zero-width match would spin forever; step over it.
      if (m[0] === "") { re.lastIndex++; continue; }
      if (m.index > last) out += esc(code.slice(last, m.index));
      var cls = "";
      for (var g = 1; g < m.length; g++) {
        if (m[g] !== undefined) { cls = rules[g - 1][0]; break; }
      }
      out += '<span class="tk-' + cls + '">' + esc(m[0]) + "</span>";
      last = m.index + m[0].length;
    }
    out += esc(code.slice(last));
    return out;
  }

  function md(t) {
    var out = "";
    var chunks = String(t).split("```");

    for (var c = 0; c < chunks.length; c++) {
      /* Odd chunks are fenced code. An unterminated fence - common mid-stream -
         still renders as code rather than dumping the source as prose. */
      if (c % 2) {
        var body = chunks[c];
        var nl = body.indexOf("\n");
        var lang = nl === -1 ? body.trim() : body.slice(0, nl).trim();
        var code = nl === -1 ? "" : body.slice(nl + 1);
        if (/[^\w.+#-]/.test(lang)) { code = body; lang = ""; }
        // Every fenced block gets a header, labelled or not, because the header
        // is what carries Copy - and code the model wrote is the single thing in
        // a transcript most likely to be wanted verbatim. Selecting it by hand
        // in a 340px panel is miserable.
        out += '<div class="cb">' +
          '<div class="cb-h"><span class="cb-l">' + esc(lang || "text") + "</span>" +
          '<span class="sp"></span>' +
          '<button class="cb-copy" data-cb-copy title="Copy code" aria-label="Copy code">' +
            icon("i-copy", "ic-11") + "</button></div>" +
          "<pre>" + highlight(code.replace(/\n$/, ""), lang) + "</pre></div>";
        continue;
      }

      var lines = chunks[c].split("\n");
      var i = 0;
      while (i < lines.length) {
        var line = lines[i];

        if (!line.trim()) { i++; continue; }

        /* Thematic break */
        if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out += '<hr class="md-hr">'; i++; continue; }

        /* ATX heading */
        var h = line.match(/^(#{1,6})\s+(.*)$/);
        if (h) {
          var lvl = Math.min(6, h[1].length);
          out += "<h" + lvl + ' class="md-h md-h' + lvl + '">' + inline(h[2].replace(/\s+#+\s*$/, "")) + "</h" + lvl + ">";
          i++; continue;
        }

        /* Pipe table: a header row followed by a delimiter row */
        if (line.indexOf("|") !== -1 && i + 1 < lines.length && isTableRule(lines[i + 1])) {
          var head = cells(line);
          i += 2;
          var rows = [];
          while (i < lines.length && lines[i].indexOf("|") !== -1 && lines[i].trim()) {
            rows.push(cells(lines[i])); i++;
          }
          var th = head.map(function (x) { return "<th>" + inline(x) + "</th>"; }).join("");
          var tb = rows.map(function (r) {
            var tds = "";
            for (var k = 0; k < head.length; k++) tds += "<td>" + inline(r[k] == null ? "" : r[k]) + "</td>";
            return "<tr>" + tds + "</tr>";
          }).join("");
          out += '<div class="md-tw"><table class="md-t"><thead><tr>' + th +
            "</tr></thead><tbody>" + tb + "</tbody></table></div>";
          continue;
        }

        /* Blockquote - and callouts, which are a quote whose first line is a
           `[!NOTE]`-style marker. Models reach for these whenever they want to
           flag a caveat, and as a plain quote the marker showed up as literal
           `[!WARNING]` text: the one shape whose whole purpose is to be seen at
           a glance was the one rendering as punctuation. */
        if (/^\s*>/.test(line)) {
          var q = [];
          while (i < lines.length && /^\s*>/.test(lines[i])) {
            q.push(lines[i].replace(/^\s*>\s?/, "")); i++;
          }
          var call = q[0] && q[0].match(/^\s*\[!(note|tip|important|warning|caution)\]\s*(.*)$/i);
          if (call) {
            var kind = call[1].toLowerCase();
            var rest = q.slice(1);
            if (call[2].trim()) rest.unshift(call[2]);
            out += '<div class="md-call" data-kind="' + kind + '">' +
              '<div class="md-call-h">' + icon(CALLOUT_ICON[kind], "ic-11") +
                "<span>" + kind + "</span></div>" +
              '<div class="md-call-b">' + inline(rest.join("\n")).replace(/\n/g, "<br>") + "</div></div>";
            continue;
          }
          out += '<blockquote class="md-q">' + inline(q.join("\n")).replace(/\n/g, "<br>") + "</blockquote>";
          continue;
        }

        /* Lists. Nesting is by leading whitespace, two levels deep - beyond
           that a sidebar has no horizontal room to show the difference. */
        var li = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
        if (li) {
          var ordered = /\d/.test(li[2]);
          var tag = ordered ? "ol" : "ul";
          // An ordered list that starts at 3 must show 3. A model numbering the
          // steps of a plan across paragraphs restarted at 1 in every fragment.
          var startAt = ordered ? parseInt(li[2], 10) : 1;
          var open = "<" + tag + ' class="md-l"' +
            (ordered && startAt > 1 ? ' start="' + startAt + '"' : "") + ">";
          out += open;
          var depth = 0;
          while (i < lines.length) {
            var m2 = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
            if (!m2) {
              /* A wrapped continuation line belongs to the open item. */
              if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && out.slice(-5) === "</li>") {
                out = out.slice(0, -5) + " " + inline(lines[i].trim()) + "</li>";
                i++; continue;
              }
              break;
            }
            var d = m2[1].length >= 2 ? 1 : 0;
            if (d > depth) { out += "<" + tag + ' class="md-l">'; depth = d; }
            else if (d < depth) { out += "</" + tag + ">"; depth = d; }
            // A checklist is not a bullet list. `- [x] ship it` was rendering as
            // a bullet with literal square brackets, which is the shape models
            // use for plans and progress - the exact case worth seeing at a
            // glance. Give it a box and drop the marker.
            var task = m2[3].match(/^\[([ xX])\]\s+(.*)$/);
            if (task) {
              var done = task[1] !== " ";
              out += '<li class="md-task"' + (done ? ' data-done="1"' : "") + ">" +
                '<span class="md-box">' + (done ? icon("i-check", "ic-9") : "") + "</span>" +
                "<span>" + inline(task[2]) + "</span></li>";
            } else {
              out += "<li>" + inline(m2[3]) + "</li>";
            }
            i++;
          }
          while (depth-- > 0) out += "</" + tag + ">";
          out += "</" + tag + ">";
          continue;
        }

        /* Paragraph: consume to the next blank line or block opener. */
        var para = [];
        while (i < lines.length && lines[i].trim() &&
               !/^(#{1,6}\s|\s*>|\s*([-*_])(\s*\2){2,}\s*$)/.test(lines[i]) &&
               !/^(\s*)([-*+]|\d+[.)])\s+/.test(lines[i])) {
          para.push(lines[i]); i++;
        }
        if (para.length) out += "<p>" + inline(para.join("\n")).replace(/\n/g, "<br>") + "</p>";
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

  /**
   * The argument on a tool row, with a path broken into its parts.
   *
   * A path is what the eye goes to on that row, and rendering it as one flat
   * mono string makes `src/agent/tools.ts` and `tools.ts` cost the same effort
   * to read. The directory recedes, the filename carries the weight, and the
   * extension is tinted - so a column of tool rows can be scanned by filename
   * without reading any of the prefixes.
   *
   * Only path-shaped arguments get this. A shell command or a search pattern is
   * not a path, and splitting one on "/" would invent structure that is not
   * there.
   */
  function argHtml(name, a) {
    var text = argOf(name, a);
    if (!text) return "";
    if (name === "run_command" || name === "search" || name === "read_skill" ||
        name === "update_todos") {
      return esc(text);
    }
    var norm = String(text).replace(/\\/g, "/");
    var cut = norm.lastIndexOf("/");
    var dir = cut === -1 ? "" : norm.slice(0, cut + 1);
    var base = cut === -1 ? norm : norm.slice(cut + 1);
    var dot = base.lastIndexOf(".");
    // A leading dot is the whole name (.gitignore), not an extension.
    var stem = dot > 0 ? base.slice(0, dot) : base;
    var ext = dot > 0 ? base.slice(dot) : "";
    return (
      (dir ? '<span class="p-dir">' + esc(dir) + "</span>" : "") +
      '<span class="p-name">' + esc(stem) + "</span>" +
      (ext ? '<span class="p-ext">' + esc(ext) + "</span>" : "")
    );
  }

  /**
   * Line delta for an edit, straight off the tool arguments.
   *
   * Deliberately a line count, not a real diff: the authoritative +/− lives on
   * the diff card that follows, and running a proper LCS on every tool row
   * would cost more than the glance it buys. Returns "" for tools that do not
   * change a file.
   */
  function lineCount(s) { return s ? String(s).split("\n").length : 0; }
  function diffStat(name, a) {
    if (!a || typeof a !== "object") return "";
    var add = 0, del = 0;
    if (name === "edit_file") {
      del = lineCount(a.old_text);
      add = lineCount(a.new_text);
    } else if (name === "write_file") {
      add = lineCount(a.content);
    } else {
      return "";
    }
    var out = "";
    if (add) out += '<span class="a">+' + add + "</span>";
    if (del) out += (out ? " " : "") + '<span class="d">−' + del + "</span>";
    return out;
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
          // Static, always. This is the product's one wordmark; the duplicate
          // that used to sit above it is VS Code's view header, blanked in
          // package.json rather than competing with this.
          '<span class="kx-wordmark">Genesis</span><span class="sp"></span>' +
          // Context usage belongs up here, not in the footer: it is status, not
          // a control, and moving it up shortens the composer.
          // The meter lives here now. It used to sit in a strip under the
          // composer next to the endpoint pill, which cost a row of vertical
          // space on every panel for two facts that are status rather than
          // controls - and vertical space in a 340px sidebar is the thing the
          // conversation is short of.
          '<button class="icon-btn" id="newBtn" title="New chat" aria-label="New chat">' + icon("i-compose") + '</button>' +
          '<button class="icon-btn" id="histBtn" title="History" aria-label="Chat history" aria-haspopup="menu" aria-expanded="false">' + icon("i-history") + '</button>' +
          '<button class="icon-btn" id="moreBtn" title="More" aria-label="More actions" aria-haspopup="menu" aria-expanded="false">' + icon("i-kebab") + '</button>' +
          '<div class="popover" id="historyPop" role="menu" hidden></div>' +
          '<div class="popover" id="morePop" role="menu" hidden>' +
            '<button class="pop-row" role="menuitem" data-more="control">' + crystal(15) + '<span class="t">Control Center</span></button>' +
            '<div class="pop-div"></div>' +
            '<button class="pop-row" role="menuitem" data-more="agents">' + icon("i-agent", "ic-13") +
              '<span class="t">Agents…</span></button>' +
            '<div class="pop-div"></div>' +
            '<button class="pop-row" role="menuitem" data-more="exportChat">' + icon("i-download", "ic-13") +
              '<span class="t">Export chat as JSON…</span></button>' +
            '<button class="pop-row" role="menuitem" data-more="exportAll">' + icon("i-download", "ic-13") +
              '<span class="t">Export all chats as JSON…</span></button>' +
            '<div class="pop-div"></div>' +
            '<button class="pop-row" role="menuitem" data-more="settings"><span class="t">Settings…</span></button>' +
            '<button class="pop-row" role="menuitem" data-more="docs"><span class="t">Documentation</span></button>' +
            // "Report Issue" landed on Logs & export, which is where the evidence
            // lives but says nothing about what to do with it. It goes to About
            // now, which names the author, states the version a report needs, and
            // has the tracker and the bundle a click away.
            '<button class="pop-row" role="menuitem" data-more="issue">' +
              '<span class="t">Author &amp; report an issue</span></button>' +
          '</div>' +
        '</header>' +
        // Each tab carries an explicit aria-label so the accessible name stays
        // the tab's name and nothing else. Three of the four append a count
        // badge, and without a label the name reads "Diagnostics2".
        //
        // It was also load-bearing for a decorative "· " that CSS ::before put
        // on every tab - generated content IS exposed in the accessibility
        // tree, so the name read "· Session". That treatment is gone; the
        // badge reason is the one that remains, and it is enough on its own.
        '<nav class="kx-tabs" role="tablist">' +
          '<button class="kx-tab" id="tabSession" role="tab" aria-selected="true" tabindex="0" aria-label="Session" aria-controls="viewSession">Session</button>' +
          // MCP earns a tab now that it is real. 1a had a "SOON" placeholder,
          // which the review deleted; 1b replaces it with the live surface.
          '<button class="kx-tab" id="tabMcp" role="tab" aria-selected="false" tabindex="-1" aria-label="MCP" aria-controls="viewMcp">MCP<span class="tab-count" id="mcpCount" hidden></span></button>' +
          // Agents sit after MCP because that is the order they are chosen in:
          // a server has to be configured before an agent can be scoped to it.
          // This was a collapsed section inside Diagnostics, which is where a
          // thing goes when it is being inspected rather than used - and an
          // agent is picked before a turn, not diagnosed after one.
          '<button class="kx-tab" id="tabAgents" role="tab" aria-selected="false" tabindex="-1" aria-label="Agents" aria-controls="viewAgents">Agents<span class="tab-count" id="agentCount" hidden></span></button>' +
          '<button class="kx-tab" id="tabDiag" role="tab" aria-selected="false" tabindex="-1" aria-label="Diagnostics" aria-controls="viewDiag">Diagnostics<span class="tab-count" id="tabCount" hidden></span></button>' +
        '</nav>' +
        '<div class="phase-banner" id="phaseBanner" data-phase="plan" hidden>' +
          '<span class="dot"></span><span class="lbl" id="phaseBannerLbl">Plan phase</span>' +
          '<span class="sub" id="phaseBannerSub">reads and plans · no edits applied</span>' +
        '</div>' +
        // Only drawn while an agent is actually selected. A permanent chip in
        // the composer toolbar would cost a row of chrome on every panel to
        // say "none" almost all of the time; this says nothing until there is
        // something to say, and then says the whole of it - who is answering
        // and what it can reach.
        '<div class="agent-bar" id="agentBar" hidden>' +
          '<span class="dot"></span>' +
          '<span class="nm" id="agentBarName"></span>' +
          '<span class="sub ell" id="agentBarScope"></span>' +
          '<button class="tb-btn" id="agentLeave" title="Stop using this agent" ' +
            'aria-label="Stop using this agent">' + icon("i-x", "ic-9") + '</button>' +
        '</div>' +
        '<section class="view" id="viewSession" role="tabpanel" aria-labelledby="tabSession">' +
          // The conversation's name. Placeholder until the model has been asked
          // for a real one, so the strip never appears and disappears.
          '<div class="convo-title" id="convoTitle" hidden></div>' +
          /* The pill is positioned against THIS, not against the view.
          
             It used to be an absolute child of `#viewSession` at `bottom: 8px`
             - and `#viewSession` holds the composer as well as the transcript,
             so "8px from the bottom" was 8px from the bottom of the COMPOSER.
             Measured at a 360px panel: the transcript ended at y=418 and the
             pill sat at 606-632, on top of a composer occupying 497-628,
             covering the ACT button. The comment on `.to-latest` claimed this
             wrapper's job was already being done by `#viewSession`; it was
             not, and nothing rendered the two together to notice.
          
             It cannot go inside `#log` either: that is the scroll container,
             and an absolutely positioned child of a scroller travels with the
             content instead of staying at its foot. */
          '<div class="log-wrap">' +
            '<div id="log"></div>' +
            /* Once you scroll up mid-stream, autoscroll stops following the
               answer - correctly, because fighting the user is worse. But
               nothing offered a way back: the reply kept growing below the fold
               with no signal it had, and the only route down was scrolling by
               hand. Shown only when it is true, so it costs no chrome the rest
               of the time. */
            '<button class="to-latest" id="toLatest" hidden>' +
              icon("i-caret", "ic-11") + "<span>Jump to latest</span></button>" +
          "</div>" +
          /* THE TRANSCRIPT IS NOT A LIVE REGION, AND USED TO BE ONE.
           *
           * `#log` carried aria-live="polite" - which sounds right and is the
           * opposite of it. The streamed answer rewrites its OWN innerHTML as
           * it grows (see typeStep), and a polite region re-announces changed
           * content, so a screen reader was handed the whole reply again from
           * the top on every repaint, for the length of the turn. Every tool
           * card, diff card and permission card is appended into the same
           * region, so those were read out too, in full, as they arrived.
           *
           * The fix is not to announce less carefully - it is to announce the
           * few things worth interrupting someone for, and nothing else. This
           * element is that: one short sentence at a time, off-screen, spoken
           * when a turn ends, when a permission is wanted, and when something
           * fails. The transcript stays navigable exactly as before; it just
           * stops shouting. */
          '<div id="announcer" class="vh" role="status" aria-live="polite" aria-atomic="true"></div>' +
          /* What this conversation has done to the workspace, live.
             It sits directly above the composer rather than in the transcript
             because it is state, not history: one row per file no matter how
             many times the file was written, updated in place while the turn
             runs. The transcript still carries the per-turn diff cards. */
          '<div class="chg" id="changeBar" data-open="0" hidden>' +
            '<div class="chg-bar">' +
              '<button class="chg-toggle" id="chgToggle" aria-expanded="false" aria-controls="chgList">' +
                icon("i-chev", "ic-9 chev") + icon("i-diff", "ic-13 chg-ic") +
                '<span class="t" id="chgCount"></span>' +
                '<span class="s" id="chgStat"></span>' +
              '</button>' +
              '<button class="chg-clear" id="chgClear" title="Clear the list - the files are not touched" ' +
                'aria-label="Clear the change list">' + icon("i-x", "ic-11") + '</button>' +
            '</div>' +
            '<div class="chg-list" id="chgList" hidden></div>' +
          '</div>' +
          // Waiting to be sent. State, not history - so it lives here with the
          // change list rather than as a sentence in the transcript that
          // scrolls away and goes stale.
          '<div class="queue" id="queue" hidden>' +
            '<div class="queue-top">' +
              icon("i-clock", "ic-11") +
              '<span class="t" id="queueCount"></span>' +
              '<span class="sp"></span>' +
              '<button class="queue-clear" id="queueClear" title="Cancel everything waiting" ' +
                'aria-label="Cancel everything waiting">' + icon("i-x", "ic-11") + '</button>' +
            '</div>' +
            '<div class="queue-list" id="queueList"></div>' +
          '</div>' +
          '<div class="composer-wrap">' +
            '<div class="qp" id="qp" role="listbox" hidden></div>' +
            // One line, above the input, rotating. It is where someone
            // finds out a feature exists at all: nothing else in the panel
            // advertises skills, phases or the browser, and a feature
            // nobody knows about may as well not ship.
            '<div class="tipbar" id="tipBar" hidden>' +
              '<span class="tip-k">Tip</span>' +
              '<span class="tip-t" id="tipText"></span>' +
              '<span class="sp"></span>' +
              '<button class="tip-x" id="tipNext" title="Another tip" aria-label="Another tip">' +
                icon("i-refresh", "ic-11") + '</button>' +
            '</div>' +
            '<div class="composer">' +
              '<div class="sel-pill" id="selPill" hidden>' + icon("i-file", "ic-13") +
                /* `ell` is not decoration here. Without it the span is a flex
                   item at its default `min-width: auto`, so a long path cannot
                   shrink: it pushed the row 153px past the composer, which
                   CLIPS - and the dismiss button went with it. A selection on
                   a deep path could not be cleared at any panel width, so it
                   rode along with every message sent. The sibling ed-pill
                   already carried this class; this one was missed. */
                '<span class="ell" id="selText"></span><span class="sp"></span>' +
                '<button class="tb-btn" id="selClear" title="Dismiss selection" aria-label="Dismiss selection" style="width:18px;height:18px">' + icon("i-x", "ic-9") + '</button>' +
              '</div>' +
              // The automatic one, above the attachments and visibly unlike
              // them: no dismiss button, because it is a readout of where the
              // cursor is and cannot be dismissed - only moved away from.
              '<div class="ed-pill" id="edPill" hidden>' + icon("i-file", "ic-11") +
                '<span class="nm ell" id="edName"></span>' +
                '<span class="prob" id="edProb" hidden></span>' +
              '</div>' +
              '<div class="att-strip" id="attachStrip" hidden></div>' +
              // The textarea keeps the caret, the selection, IME and undo; a
              // contenteditable would have to reimplement all four and get
              // them wrong. What it cannot do is colour its own text, so a
              // mirror sits behind it holding the same string with the tokens
              // marked, and the input above it is painted transparent.
              '<div class="draft-wrap">' +
                '<div class="draft-mirror" id="draftMirror" aria-hidden="true"></div>' +
                '<textarea id="draft" rows="1" aria-label="Message" placeholder="\u203A\u00A0Ask Genesis anything…\u00A0\u00A0(/skills\u00A0·\u00A0@files)"></textarea>' +
              '</div>' +
              '<div class="toolbar">' +
                // #4 - the control row carries controls only. The keycap that
                // used to sit here was chrome describing chrome; the shortcut
                // lives in the group's accessible name and the tooltip, where a
                // keyboard user finds it and everyone else is not taxed for it.
                // A radiogroup, not a group of plain buttons. `data-on` drove
                // the styling and nothing else, so a screen reader read three
                // equal buttons and never announced which phase was live -
                // the one thing the control exists to say. aria-checked is
                // kept in step by applyPhase.
                '<div class="seg" id="phaseSeg" role="radiogroup" title="Shift+Tab to cycle phase"' +
                  ' aria-label="Phase - press Shift+Tab to cycle">' +
                  '<button role="radio" aria-checked="false" data-phase="ask" data-on="0" ' +
                    'title="Ask - answers from what it reads. Makes no changes.">Ask</button>' +
                  '<button role="radio" aria-checked="false" data-phase="plan" data-on="0" ' +
                    'title="Plan - produces a plan. Makes no changes.">Plan</button>' +
                  '<button role="radio" aria-checked="true" data-phase="act" data-on="1" ' +
                    'title="Act - full tools, makes changes">Act</button>' +
                '</div>' +
                '<button id="modelBtn" aria-haspopup="listbox" aria-expanded="false">' +
                  // The endpoint's health, on the control that already names
                  // the endpoint's model. It was a pill of its own in the
                  // removed footer; as a dot here it costs no space at all and
                  // still turns red when the gateway is failing.
                  /* Named, because five pixels of hue is not a state.
                   * renderFooter keeps the label in step with data-err; the
                   * dot is the glance and the name is the answer for anyone
                   * the glance does not reach. */
                  '<span class="ep-dot" id="epDot" data-err="0" role="img" ' +
                    'aria-label="Endpoint healthy" title="Endpoint healthy"></span>' +
                  '<span class="nm ell" id="modelName">No model</span>' + icon("i-caret", "ic-9") +
                '</button>' +
                // Approval mode belongs here, beside the phase and the model.
                // Those three are the whole answer to "what will happen when I
                // press send": what it may do, which model does it, and
                // whether it will ask first. It used to sit under the box in a
                // footer, which is where things go to be ignored.
                '<button class="perm-btn" id="permBtn" aria-haspopup="menu" aria-expanded="false"' +
                  ' title="What the agent may do without asking">' +
                  icon("i-hand", "ic-15") + '<span class="nm" id="permName">Manual</span>' +
                '</button>' +
                '<span class="sp"></span>' +
                // Attach and send. THERE IS NO `@` BUTTON, on purpose.
                //
                // It typed a single character into the box, which is a thing
                // the keyboard already does and which the placeholder already
                // teaches - "( / skills · @ files )". As a sixth control in a
                // wrapping row it was the one that broke the line: the group
                // orphaned onto a second row and sat right-aligned with the
                // whole left half of the composer empty. The design's composer
                // has five controls and this is the one it does not have.
                //
                // The pair is still a GROUP rather than two siblings, so a
                // wrap at a narrow width moves them together instead of
                // leaving send on a row by itself.
                '<span class="tb-actions">' +
                  '<button class="tb-btn" id="clipBtn" title="Upload from your computer - or drop files on the box" aria-label="Upload files from your computer">' + icon("i-clip", "ic-13") + '</button>' +
                  '<button id="sendBtn" data-ready="0" data-mode="send" title="Send" aria-label="Send">' + icon("i-up", "ic-13") + '</button>' +
                '</span>' +
              '</div>' +
            '</div>' +
            // The mode picker is a sheet over the whole panel rather than a
            // menu hanging off its button. It is the control that decides what
            // the agent may do to the workspace without asking, and the design
            // treats it as a decision worth stopping for: the panel dims, the
            // sheet rises from the bottom edge, and each mode states what it
            // means in a sentence rather than a word.
            '<div class="perm-sheet" id="permPop" hidden>' +
              '<div class="perm-card" role="dialog" aria-modal="true" aria-label="Select mode">' +
                '<div class="perm-grip"><span></span></div>' +
                '<div class="perm-head">' +
                  '<button class="perm-x" data-perm-close="1" aria-label="Close">' + icon("i-x", "ic-13") + '</button>' +
                  '<div class="t">Select mode</div>' +
                  '<div class="s">Choose what the agent may do without asking</div>' +
                '</div>' +
                '<div class="perm-list" id="permList" role="radiogroup" aria-label="Mode"></div>' +
              '</div>' +
            '</div>' +
          '</div>' +
        '</section>' +
        '<section class="view" id="viewMcp" role="tabpanel" aria-labelledby="tabMcp" hidden>' +
          '<div class="mcp-wrap" id="mcpBody"></div>' +
        '</section>' +
        '<section class="view" id="viewAgents" role="tabpanel" aria-labelledby="tabAgents" hidden>' +
          '<div class="ag-wrap">' +
            // The header carries the count and the one action that is always
            // available. The list below owns everything that depends on having
            // agents at all, including what to say when there are none.
            '<div class="ag-top">' +
              '<span class="lbl">Agents</span>' +
              '<span class="badge" id="agBadge">-</span>' +
              '<span class="sp"></span>' +
              '<button class="btn sm" data-ag="new">New agent</button>' +
            '</div>' +
            '<div class="ag-body" id="agBody"></div>' +
          '</div>' +
        '</section>' +
        /* The transcript's context menu.
         *
         * Outside the header on purpose: the document-level closer exempts
         * `.kx-header` so a click inside the history popover does not shut it,
         * and this menu wants the opposite - a click on one of its rows should
         * run the action and then close it. Position is fixed and set at open
         * time, so where it sits in the tree costs nothing. */
        '<div class="ctx-menu" id="msgMenu" role="menu" hidden></div>' +
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
      '<span class="badge" id="' + badgeId + '">-</span></button>' +
      '<div class="sec-body" id="' + bodyId + '"' + (open ? "" : " hidden") + '></div></div>';
  }

  /* ──────────────────── what survives the webview being rebuilt ────────────
   *
   * NOT the hide/show case. `retainContextWhenHidden: true` is set where the
   * view is registered (src/extension.ts), so collapsing the container or
   * switching to Explorer keeps this whole DOM alive, draft and all. That flag
   * is deliberate and stays.
   *
   * What it does not survive is the webview being REBUILT: a window reload, an
   * extension host restart, a reinstall, "Developer: Reload Webviews". Then the
   * script runs again from scratch. The transcript comes back, because it
   * re-hydrates from the host's replay buffer - but S is a fresh object, so the
   * tab you were on, the sections you had opened and the message you were half
   * way through typing were gone, with the draft the one that actually costs
   * something.
   *
   * `setState` is the mechanism VS Code provides for exactly that, it survives
   * the rebuild, and the API was already acquired and never called. Nothing
   * here is authoritative: a stale value is a worse guess than a fresh one,
   * never a wrong fact.
   */
  function saveUiState() {
    if (!api.setState) return;
    var draft = $("draft");
    var open = [];
    var secs = document.querySelectorAll(".sec[data-open='1']");
    for (var i = 0; i < secs.length; i++) open.push(secs[i].id);
    try {
      api.setState({ tab: S.tab, draft: draft ? draft.value : "", sections: open });
    } catch (e) { /* a webview with no state store is not a failure */ }
  }

  function restoreUiState() {
    var st = null;
    try { st = api.getState && api.getState(); } catch (e) { st = null; }
    if (!st) return;
    if (st.draft) {
      var draft = $("draft");
      // syncComposer is what sizes the box and repaints the mirror, so the
      // restored draft is a full draft rather than a string in a one-row field.
      if (draft && !draft.value) { draft.value = st.draft; syncComposer(); }
    }
    for (var i = 0; st.sections && i < st.sections.length; i++) {
      if ($(st.sections[i])) openSection(st.sections[i]);
    }
    // Last, because setTab renders the tab it lands on and saves again.
    if (st.tab) setTab(st.tab);
  }

  /* ─────────────────────────── popovers ─────────────────────────── */

  function closePops() {
    $("historyPop").hidden = true;
    $("morePop").hidden = true;
    // The message menu closes with the rest. Two menus open at once is the bug
    // a second closer would have introduced.
    if ($("msgMenu")) $("msgMenu").hidden = true;
    $("histBtn").setAttribute("aria-expanded", "false");
    $("moreBtn").setAttribute("aria-expanded", "false");
  }

  /* ───────────────────── the message context menu ─────────────────────
   *
   * The transcript was the one surface here with no per-message actions at all.
   * `turn-foot` is per TURN, sits at the end of it, and its Copy only ever took
   * the assistant's answer - so there was no way to copy a question, and no way
   * to reach an earlier turn's answer except by selecting it by hand in a 340px
   * column.
   *
   * RIGHT-CLICK COSTS SOMETHING, AND COPY IS THE PRICE. A webview's right-click
   * shows VS Code's own menu, which is where Copy lives; opening ours means
   * preventDefault(), which takes that away. So Copy is a row here - not scope
   * creep, but restoring the one capability the trigger removes. For the same
   * reason a fenced code block is left alone entirely: it has its own copy
   * button two pixels away, and selecting half a snippet is worth more there
   * than any message-level action.
   *
   * `role` is which messages a row belongs on. Edit and Resend are meaningless
   * on an answer - there is nothing to re-ask - so an answer offers the two
   * that mean something and no more.
   */
  var MSG_ACTIONS = [
    ["edit",   "user", "i-compose", "Edit"],
    ["resend", "user", "i-up",      "Resend"],
    ["attach", "both", "i-clip",    "Attach to composer"],
    ["copy",   "both", "i-copy",    "Copy"]
  ];

  /** The string a message was built from, never the string its DOM holds. */
  function msgText(el) {
    if (el && typeof el._raw === "string") return el._raw;
    // A message from a build before `_raw` existed on this side. Better than
    // nothing, and wrong only about the newlines between multimodal blocks.
    var t = el && el.querySelector(".u-text");
    return (t || el || {}).textContent || "";
  }

  /** Where this message sits in the conversation, for naming an attachment. */
  function msgIndex(el) {
    var all = logEl.querySelectorAll(".msg-user, .msg-ai");
    for (var i = 0; i < all.length; i++) if (all[i] === el) return i + 1;
    return all.length + 1;
  }

  function openMsgMenu(el, x, y) {
    // One closer owns every menu; opening this one shuts whatever else is up.
    closePops();
    var menu = $("msgMenu");
    if (!menu) return;
    var isUser = el.classList.contains("msg-user");
    var drafting = ($("draft").value || "").trim().length > 0;
    var html = "";
    for (var i = 0; i < MSG_ACTIONS.length; i++) {
      var a = MSG_ACTIONS[i];
      if (a[1] === "user" && !isUser) continue;
      /* REPLACING A HALF-WRITTEN DRAFT IS DESTROYING WORK, so the row says so
         before the click rather than after it. Same rule the mode sheet and the
         delete confirmations follow: the cost goes on the control. */
      var label = a[0] === "edit" && drafting ? "Replace draft and edit" : a[3];
      html += '<button class="pop-row" role="menuitem" data-mm="' + a[0] + '">' +
        icon(a[2], "ic-13") + '<span class="t">' + esc(label) + "</span></button>";
    }
    menu.innerHTML = html;
    menu._target = el;
    // Where the transcript stood when this menu was anchored. The scroll
    // closer measures against it rather than trusting the event itself.
    menu._scrollAt = logEl.scrollTop;
    menu.hidden = false;

    /* Clamped to the panel, which at its narrowest is about 200px - narrower
       than the menu itself is wide. Measured after unhiding, because a hidden
       element has no size to measure. */
    var w = menu.offsetWidth;
    var h = menu.offsetHeight;
    var maxX = window.innerWidth;
    var maxY = window.innerHeight;
    var left = x + w > maxX ? Math.max(0, maxX - w - 4) : x;
    var top = y + h > maxY ? Math.max(0, maxY - h - 4) : y;
    menu.style.left = left + "px";
    menu.style.top = top + "px";
  }

  function onMsgAction(action, el) {
    var text = msgText(el);
    if (action === "copy") { post("copyText", { text: text }); return; }
    if (action === "resend") { sendText(text); return; }
    if (action === "edit") {
      var draft = $("draft");
      draft.value = text;
      syncComposer();
      draft.focus();
      // The caret at the END, because this is a message to amend rather than
      // one to retype from the top.
      if (draft.setSelectionRange) draft.setSelectionRange(text.length, text.length);
      return;
    }
    if (action === "attach") {
      var isUser = el.classList.contains("msg-user");
      var name = (isUser ? "question-" : "answer-") + msgIndex(el) + ".md";
      if (addAttachment(textAttachment(name, text))) {
        renderAttachments();
        syncComposer();
      }
    }
  }

  /* Each row is one stored conversation. The message count and the active dot
     are there so it is obvious that a session holds a transcript rather than a
     single message - the old list showed only a title and a timestamp, which
     read identically whether a session had one message or forty. */
/**
   * The mark a conversation wears while it is working.
   *
   * Inline rather than a `<use>` of the icon sheet, because the parts have to
   * be animated independently and CSS selectors do not reach inside a use's
   * shadow tree. It appears a handful of times at most.
   *
   * Built from the roundel's own vocabulary - a track, an arc travelling it,
   * a core - so that a conversation working in the background wears a smaller
   * version of the same mark the streaming indicator wears for the one on
   * screen. A dot with a box-shadow said the same thing and said it in a
   * language nothing else in the panel speaks.
   */
  function liveMark() {
    return '<svg class="g-live" viewBox="0 0 24 24" width="14" height="14" ' +
      'role="img" aria-label="Working">' +
      '<circle class="g-live-halo" cx="12" cy="12" r="9.4"/>' +
      '<circle class="g-live-track" cx="12" cy="12" r="8.6"/>' +
      '<circle class="g-live-arc" cx="12" cy="12" r="8.6"/>' +
      '<circle class="g-live-core" cx="12" cy="12" r="3"/>' +
      "</svg>";
  }

  function renderHistory() {
    var html = "";
    for (var i = 0; i < S.sessions.length; i++) {
      var s = S.sessions[i];
      var on = s.active ? "1" : "0";
      // A conversation you are not looking at can still be working: start a
      // turn, switch, and the one you left keeps going with nothing on screen
      // saying so. This list is the only place the other conversations appear,
      // so it is the only place that can say it.
      var run = s.running ? "1" : "0";
      var n = s.count === 1 ? "1 message" : (s.count || 0) + " messages";
      html += '<div class="hist-row" data-on="' + on + '" data-run="' + run + '">' +
        '<button class="pop-row" role="menuitem" data-session="' + esc(s.id) + '"' +
          (s.running ? ' title="Working…"' : "") + '>' +
          (s.running ? liveMark() : '<span class="hist-dot"></span>') +
          '<span class="ell"><span class="t ell">' + esc(s.title) + '</span>' +
          '<span class="m">' + esc(s.when) + ' · ' + n + '</span></span>' +
        '</button>' +
        // Stop, for a conversation that is working but is not the one on
        // screen. The composer's Stop deliberately reaches only the visible
        // turn, which left a backgrounded turn - one blocked on an approval
        // nobody saw asked, or inside a long command - with no control
        // anywhere that could reach it. This list is where those conversations
        // are, so this is where the control belongs.
        (s.running
          ? '<button class="hist-stop" data-stop="' + esc(s.id) + '" title="Stop this turn" ' +
              'aria-label="Stop the turn running in ' + esc(s.title) + '">' +
              icon("i-stop", "ic-13") + "</button>"
          : "") +
        '<button class="hist-del" data-del="' + esc(s.id) + '" title="Delete session" ' +
          'aria-label="Delete session">' + icon("i-trash", "ic-13") + '</button>' +
        '</div>';
    }
    $("historyPop").innerHTML = html ||
      '<div class="pop-row"><span class="m">No previous sessions</span></div>';
  }

  /* ─────────────────────────── tabs ─────────────────────────── */

  /* Three tabs now, so the two-way boolean became a table. */
  var TABS = [
    ["session", "tabSession", "viewSession"],
    ["mcp", "tabMcp", "viewMcp"],
    ["agents", "tabAgents", "viewAgents"],
    ["diagnostics", "tabDiag", "viewDiag"]
  ];

  function setTab(tab, focus) {
    S.tab = tab;
    for (var i = 0; i < TABS.length; i++) {
      var on = TABS[i][0] === tab;
      var btn = $(TABS[i][1]);
      btn.setAttribute("aria-selected", on ? "true" : "false");
      /* ONE TAB STOP, NOT FOUR.
       *
       * role="tablist" was declared and the keyboard contract that comes with
       * it was not implemented: all four tabs were plain buttons, so crossing
       * the strip cost four presses of Tab and the arrow keys a screen reader
       * had just promised did nothing at all. A roving tabindex plus the
       * handler in wire() is the whole of that pattern. */
      btn.setAttribute("tabindex", on ? "0" : "-1");
      if (on && focus) btn.focus();
      $(TABS[i][2]).hidden = !on;
    }
    if (tab === "mcp") renderMcp();
    if (tab === "agents") renderAgents();
    // The panel remembers which room you were in - see saveUiState.
    saveUiState();
  }

  /**
   * Arrow keys across the tab strip, per the WAI-ARIA tabs pattern.
   *
   * Wrapping rather than stopping at the ends, because four tabs in a 340px
   * strip is a ring, not a list - and Home/End are there for anyone who wants
   * the ends specifically.
   */
  function onTabKey(e) {
    var i = -1;
    for (var k = 0; k < TABS.length; k++) if (TABS[k][0] === S.tab) i = k;
    if (i === -1) return;
    var to = null;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") to = (i + 1) % TABS.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") to = (i - 1 + TABS.length) % TABS.length;
    else if (e.key === "Home") to = 0;
    else if (e.key === "End") to = TABS.length - 1;
    if (to === null) return;
    e.preventDefault();
    setTab(TABS[to][0], true);
  }

  /**
   * The name a tab answers to, count included.
   *
   * The badge is a child of the tab and the tab carries an aria-label, which
   * OVERRIDES its content - so the count was in the accessible tree for
   * exactly as long as it took someone to add the label that stopped
   * "Diagnostics2" being read. That fixed the stutter by deleting the
   * information. The count belongs in the name; it just has to be a sentence
   * rather than a digit glued to a word.
   */
  function setTabCount(tabId, badgeId, plain, n, what) {
    var el = $(badgeId);
    var tab = $(tabId);
    if (!el || !tab) return;
    el.textContent = n ? String(n) : "";
    el.hidden = !n;
    var said = n === 1 ? what.replace(/s$/, "") : what;
    el.title = n ? n + " " + said : "";
    tab.setAttribute("aria-label", n ? plain + ", " + n + " " + said : plain);
  }

  function openSection(secId) {
    var sec = $(secId);
    sec.setAttribute("data-open", "1");
    sec.querySelector(".sec-head").setAttribute("aria-expanded", "true");
    sec.querySelector(".sec-body").hidden = false;
  }

  /* ─────────────────────────── phase ─────────────────────────── */

  // Order Shift+Tab cycles in: read, then design, then build. Ask and Plan
  // both show the banner below; Act does not, because nothing is withheld
  // in Act and there is nothing to disclose.
  var PHASE_CYCLE = ["ask", "plan", "act"];
  var PHASE_INFO = {
    ask: { lbl: "Ask phase", sub: "reads and answers · no edits, no plan" },
    plan: { lbl: "Plan phase", sub: "reads and plans · no edits applied" }
  };

  function applyPhase(phase, silent) {
    // Normalised once, at the only door into phase state. Every caller is a
    // different kind of untrusted: a restored session's persisted value, a
    // `phaseChanged` from the host, a data attribute off a clicked element.
    // An unrecognised value used to reach S.phase and leave the control with
    // no segment lit and no banner - a UI in a state the user cannot name or
    // get out of except by clicking. It falls back to act because that is the
    // host's own default (`AppState.phase`), and the host is what actually
    // gates the tools. Landing on ask would be the flattering choice and the
    // wrong one: the panel would show a read-only badge over a session the
    // host would still happily run a write in.
    if (PHASE_CYCLE.indexOf(phase) === -1) phase = "act";
    S.phase = phase;
    var segs = $("phaseSeg").querySelectorAll("[data-phase]");
    for (var i = 0; i < segs.length; i++) {
      var on = segs[i].getAttribute("data-phase") === phase;
      segs[i].setAttribute("data-on", on ? "1" : "0");
      segs[i].setAttribute("aria-checked", on ? "true" : "false");
    }
    /* One banner, two read-only phases. Both make the same promise - nothing in
       the workspace changes - and saying it twice in two colours would be two
       ways to read one fact.

       This was written TWICE, from two `var banner` declarations in the same
       function: once off PHASE_INFO and once off a pair of inline literals
       saying the same thing. Two copies of one string is how they stop being
       one string, so PHASE_INFO is the only one left. Ask's line carries a
       promise Plan's does not - no plan either - which is the whole difference
       between the two, and it lives in that table. */
    var info = PHASE_INFO[phase];
    var banner = $("phaseBanner");
    banner.hidden = !info;
    if (info) {
      banner.setAttribute("data-phase", phase);
      $("phaseBannerLbl").textContent = info.lbl;
      $("phaseBannerSub").textContent = info.sub;
    }
    syncComposer();
    if (!silent) post("setPhase", { phase: phase });
  }

  /**
   * Repaint the layer behind the input so the draft is coloured as it is typed.
   *
   * Three things are marked, and only three, because every extra colour here
   * competes with the message being written: the skill a leading slash names,
   * the files an @ mention attaches, and inline code. All three are things the
   * panel will *act* on, so seeing them recognised is feedback rather than
   * decoration - a mistyped skill name simply stays uncoloured.
   *
   * The trailing newline matters: a textarea ending in one renders an extra
   * blank line that the mirror would not, and the two would disagree about
   * their height by exactly one line.
   */
  function renderDraftMirror() {
    var mirror = $("draftMirror");
    if (!mirror) return;
    var draft = $("draft");
    var raw = draft.value;

    var html = esc(raw)
      // A skill only counts at the very start, which is where the picker
      // accepts one; "see /usr/bin" further along is a path, not a command.
      .replace(/^(\/[a-z0-9][\w-]*)/i, '<span class="tk-skill">$1</span>')
      // @path, stopping at whitespace. The trailing slash of a folder is kept.
      .replace(/(^|\s)(@[\w./\\-]+)/g, '$1<span class="tk-file">$2</span>')
      // Inline code, non-greedy and never across a line break.
      .replace(/`([^`\n]+)`/g, '<span class="tk-code">`$1`</span>');

    mirror.innerHTML = html + (raw.slice(-1) === "\n" ? "<br>" : "");
    mirror.scrollTop = draft.scrollTop;
  }

  /* ───────────────────────── tips ───────────────────────── */

  /**
   * What this panel can do that is not visible from looking at it.
   *
   * Every line names a real feature and says how to reach it. A tip that
   * cannot be acted on immediately is an advertisement, and an advertisement
   * inside a tool someone is trying to work in is noise.
   */
  var TIPS = [
    "Type <b>/</b> to run a skill - the index costs nothing until one is used.",
    "<b>Shift+Tab</b> cycles Ask, Plan and Act. Ask reads and answers; it cannot edit.",
    "<b>@</b> attaches a file by name, or a folder if you end it with a slash.",
    "Paste an image straight into the box - it reaches the model when the endpoint has vision.",
    "Ask the model to open a browser: it can click, read the console, and see the page.",
    "Put standing rules in <b>.agent/instructions.md</b> and they join every prompt.",
    "<b>Esc</b> stops a running turn, and the conversation stays resumable.",
    "Every turn is snapshotted - <b>Restore checkpoint</b> undoes a whole turn, not one file.",
    // The command list was documented in exactly one place - /help - reachable
    // only by already knowing to type it.
    "Type <b>/help</b> for every slash command, and every skill this workspace has.",
    "The <b>Diagnostics</b> tab walks eight rungs and stops at the first real failure.",
    "Drop a <b>SKILL.md</b> into .agent/skills and it appears under / straight away."
  ];

  /* How long one tip holds the strip.
     30 seconds, so a panel open for a couple of minutes shows several rather
     than one - the strip is only worth its row if it actually turns over.
     A line that changes under the eye is still worse than a line nobody
     reads, which is what `watchTips` handles: the clock stops while the
     pointer is on the strip or the keyboard is in it. */
  var TIP_PERIOD_MS = 30 * 1000;

  /* Derived from the clock rather than stored, so it advances on its own and
     two panels open side by side agree. `tipNudge` is the manual button's
     offset on top of it. */
  function tipIndex() {
    return (Math.floor(Date.now() / TIP_PERIOD_MS) + (S.tipNudge || 0)) % TIPS.length;
  }

  function renderTip(advance) {
    var bar = $("tipBar");
    if (!bar) return;
    if (advance) S.tipNudge = (S.tipNudge || 0) + 1;
    var i = tipIndex();
    // innerHTML is safe here and only here: TIPS is a constant in this file
    // and never carries anything a model or a page produced.
    $("tipText").innerHTML = TIPS[i];
    S.tipShown = i;
    bar.hidden = false;
  }

  /* The strip has to change while the panel simply sits there, so the period
     is watched rather than waited for: comparing the clock bucket survives the
     machine sleeping, which a plain 30-second timer would not - it would come
     back owing a hundred missed ticks and burn through the whole list.

     HELD WHILE IT IS BEING READ. A line that rotates every 30 seconds will
     eventually change mid-sentence under someone's eye, which is the one way
     this strip can be actively annoying rather than merely ignorable. Hover or
     focus freezes it, and because the index is derived from the clock rather
     than incremented, letting go does not replay the tips that were skipped -
     it jumps to whichever one is current. */
  function watchTips() {
    var bar = $("tipBar");
    if (bar) {
      bar.addEventListener("mouseenter", function () { S.tipHold = true; });
      bar.addEventListener("mouseleave", function () { S.tipHold = false; });
      bar.addEventListener("focusin", function () { S.tipHold = true; });
      bar.addEventListener("focusout", function () { S.tipHold = false; });
    }
    setInterval(function () {
      if (S.tipHold) return;
      if (tipIndex() !== S.tipShown) renderTip(false);
    }, 2 * 1000);
  }

  /* ───────────────────────── permissions ───────────────────────── */

  /* The three modes, in the order they surrender control. Each line says what
     happens rather than naming the setting: "edits-auto" is a value in a JSON
     file, "file edits run, commands ask" is a decision someone can make. */
  /* Mode, the full name for the menu, what it actually does, and the short
     name for the button. The button sits in the composer's control row beside
     the phase and the model, where there is room for a word rather than a
     sentence - and where all three together answer "what happens when I press
     send". The sentence still appears in the menu, which is where someone is
     deciding rather than glancing. */
  var PERMS = [
    // id, sheet title, sentence, the one word the composer button shows,
    // glyph, hue.
    //
    // These are the Genesis mode rows with `plan` dropped. Plan is a PHASE,
    // not a permission - it already exists as the middle segment of the
    // ASK/PLAN/ACT control two inches to the left, and offering it in both
    // places would put the same setting behind two controls that disagree.
    // What is left maps one-to-one onto the three approval modes the host has
    // always had.
    // The short label for `ask` is "Manual", NOT "Ask".
    //
    // It was "Ask", which put the word ASK on two different controls a
    // centimetre apart in the same row: the left one is the PHASE (what tools
    // the model may reach for) and the right one was the APPROVAL MODE (whether
    // it stops before a side effect). They are unrelated settings, and reading
    // "ASK PLAN ACT ... ASK" the pair looks like one broken segmented control
    // with a stray fourth option. The design's own name for this mode is
    // Manual, which is both unambiguous and what the sheet already called it.
    ["ask", "Manual", "Always ask before making changes", "Manual", "i-hand", "var(--kx-fg)"],
    ["edits-auto", "Accept edits", "File edits run automatically. Shell commands still ask.", "Edits", "i-code", "var(--kx-agent)"],
    /* "The agent handles permission decisions itself" was the mechanism, and the
       other two rows here name a consequence: "Always ask before making
       changes", "File edits run automatically. Shell commands still ask." The
       vaguest wording was on the only mode that gives everything away - and
       package.json and the Control Center both said the honest thing ("never
       ask") while the control people actually use did not. */
    ["full-auto", "Auto", "Never asks. Runs shell commands and writes files without stopping.",
      "Auto", "i-bolt", "var(--kx-error)"]
  ];

  function permLabel(mode, short) {
    for (var i = 0; i < PERMS.length; i++) {
      if (PERMS[i][0] === mode) return short ? PERMS[i][3] : PERMS[i][1];
    }
    return short ? "Ask" : "Ask each time";
  }

  function permDetail(mode) {
    for (var i = 0; i < PERMS.length; i++) if (PERMS[i][0] === mode) return PERMS[i][2];
    return PERMS[0][2];
  }

  /** The glyph for a mode. Same table the sheet reads, so the two agree. */
  function permIcon(mode) {
    for (var i = 0; i < PERMS.length; i++) if (PERMS[i][0] === mode) return PERMS[i][4];
    return PERMS[0][4];
  }

  function renderPerm() {
    var mode = (S.config && S.config.approvalMode) || "ask";
    var nm = $("permName");
    if (nm) nm.textContent = permLabel(mode, true);
    var btn = $("permBtn");
    if (btn) {
      btn.setAttribute("data-mode", mode);
      // Below 340px the label is hidden and the glyph is the whole control, so
      // the accessible name cannot come from the text any more.
      btn.setAttribute("aria-label", "Mode: " + permLabel(mode));
      // The full sentence, for the control that now shows one word.
      btn.title = permLabel(mode) + " - " + permDetail(mode);
      // THE MODE'S OWN GLYPH, not a fixed shield.
      //
      // The button drew `i-shield` whatever the mode was, while the sheet it
      // opens drew a different glyph per mode - a raised hand, angle brackets,
      // a bolt. So the one icon on screen the whole time said nothing about
      // which mode was in force, and disagreed with the sheet the moment it
      // opened. A shield also appears nowhere else in this panel, so it read as
      // a security badge rather than as a control.
      //
      // Reading PERMS means the button cannot drift from the sheet: there is
      // one table, and both render from it.
      var ic = btn.querySelector("svg");
      if (ic) ic.outerHTML = icon(permIcon(mode), "ic-15");
    }
    var pop = $("permPop");
    if (!pop || pop.hidden) return;
    var list = $("permList");
    if (!list) return;
    var html = "";
    for (var i = 0; i < PERMS.length; i++) {
      var on = PERMS[i][0] === mode;
      // `--i` is the row's position, which is what the stagger in sidebar.css
      // multiplies its delay by. Without it every row transitions on the same
      // frame and the list arrives pre-formed.
      html += '<button class="perm-row" style="--i:' + i + '" role="radio" aria-checked="' + (on ? "true" : "false") +
        '" data-on="' + (on ? "1" : "0") + '" data-perm="' + esc(PERMS[i][0]) + '">' +
        '<span class="ic" style="color:' + PERMS[i][5] + '">' + icon(PERMS[i][4], "ic-18") + "</span>" +
        '<span class="col"><span class="t">' + esc(PERMS[i][1]) + "</span>" +
        '<span class="m">' + esc(PERMS[i][2]) + "</span></span>" +
        '<span class="ring"><span class="dot"></span></span></button>';
    }
    list.innerHTML = html;
  }

  /* The exit timer, held so a fast close-then-open cannot leave the sheet
     hidden after it has already been asked to reopen. */
  var permExit = null;
  /* Where focus was when the sheet opened, so closing can put it back. */
  var permReturn = null;
  /* The document-level key handler while the sheet is open, held so it can be
     taken off again. See `permKeydown`. */
  var permKeys = null;

  /**
   * Everything inside the card that a Tab can reach, in order.
   *
   * `getClientRects()` rather than `offsetParent`: the sheet is
   * `position: fixed`, which makes `offsetParent` answer about the wrong
   * element, while a zero-length rect list is a reliable "not rendered".
   */
  function permFocusable() {
    var card = $("permPop") && $("permPop").querySelector(".perm-card");
    if (!card) return [];
    var all = card.querySelectorAll("button, [href], input, select, textarea, [tabindex]");
    return [].slice.call(all).filter(function (el) {
      return !el.disabled && el.tabIndex !== -1 && el.getClientRects().length > 0;
    });
  }

  /**
   * Make the sheet behave like the modal it says it is.
   *
   * It renders as `role="dialog" aria-modal="true"`, which promises that the
   * rest of the panel is unreachable while it is up. It was not: measured, 8
   * of 12 Tab presses left the sheet, and the FIRST TWO landed on attach and
   * send behind the scrim - where Enter posted the message. The scrim stops a
   * mouse and stopped nothing else, so a keyboard user sent a message they
   * never wrote, from behind a dialog Escape would not close either.
   *
   * On `document`, not on the sheet: once focus has escaped to `#sendBtn` a
   * listener on the sheet never sees the keystroke, which is the whole failure.
   * In the CAPTURE phase, and stopping what it handles, so Escape closes the
   * sheet rather than also reaching the composer's own Escape - which
   * interrupts the running turn.
   */
  function permKeydown(e) {
    var pop = $("permPop");
    if (!pop || pop.hidden) return;

    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      togglePerm(false);
      return;
    }
    if (e.key !== "Tab") return;

    var f = permFocusable();
    if (!f.length) return;
    var first = f[0];
    var last = f[f.length - 1];
    var here = f.indexOf(document.activeElement);

    // Already outside - pull it back rather than let Tab walk further away.
    if (here === -1) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
      return;
    }
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  /**
   * Open or close the mode sheet, with the transition sidebar.css describes.
   *
   * `display: none` cannot be transitioned, so `hidden` and the animation are
   * two different things sequenced here:
   *
   *   opening   drop `hidden`, then set `data-open` on the NEXT frame. Both in
   *             one frame and the browser has no start value to animate from,
   *             so the sheet would appear fully open - which is the bug this
   *             was written to fix.
   *   closing   drop `data-open` and let it play, then put `hidden` back when
   *             it has finished. Set immediately and the element vanishes
   *             mid-flight.
   *
   * The exit is timed rather than driven by `transitionend`, because that
   * event does not fire if the sheet is hidden by something else first - a
   * reload, a tab switch - and the sheet would then stay in the tree,
   * invisible and still focusable.
   */
  function togglePerm(open) {
    var pop = $("permPop");
    if (!pop) return;
    var want = open === undefined ? pop.hidden : open;

    if (permExit) { clearTimeout(permExit); permExit = null; }

    if (want) {
      // Read before the sheet takes focus, so close has somewhere to put it.
      permReturn = document.activeElement;
      pop.inert = false;
      pop.hidden = false;
      renderPerm();
      // AFTER renderPerm, which rebuilds the rows through innerHTML - anything
      // queried before this line is detached from the document.
      //
      // Landing on the mode in force rather than on the close button: it tells
      // a keyboard user what is currently set, which is the question the sheet
      // is open to answer.
      var land = pop.querySelector('.perm-row[data-on="1"]') || pop.querySelector("[data-perm-close]");
      if (land && land.focus) land.focus();
      if (!permKeys) {
        permKeys = permKeydown;
        document.addEventListener("keydown", permKeys, true);
      }
      // Two frames, not one: the first commits the un-hidden layout, the
      // second is where the transition has a value to start from.
      requestAnimationFrame(function () {
        requestAnimationFrame(function () { pop.setAttribute("data-open", "1"); });
      });
    } else {
      if (permKeys) {
        document.removeEventListener("keydown", permKeys, true);
        permKeys = null;
      }
      pop.removeAttribute("data-open");
      // Whether the sheet still holds focus has to be asked BEFORE `inert`,
      // which blurs whatever is inside it.
      var held = pop.contains(document.activeElement);
      // Out of the tab order the instant it starts leaving. The card stays
      // `hidden = false` and focusable for the whole 380ms exit below, and
      // `inert` covers that window without depending on `transitionend` -
      // which the note above explains does not reliably fire.
      pop.inert = true;
      // Only when the sheet had it. This runs on every document click, and a
      // click elsewhere has already put focus where the user wanted it.
      if (held && permReturn && permReturn.focus) permReturn.focus();
      permReturn = null;
      // Card 340ms plus the backdrop's 200ms, with a little slack.
      permExit = setTimeout(function () {
        pop.hidden = true;
        permExit = null;
      }, 380);
      renderPerm();
    }
    $("permBtn").setAttribute("aria-expanded", want ? "true" : "false");
  }


  /* ─────────────────────── transcript primitives ─────────────────────── */

  /**
   * Say one thing, once, to whoever is listening rather than looking.
   *
   * Replaces the aria-live that used to sit on the whole transcript. The
   * region is emptied first: assigning the same string twice is a no-op to a
   * screen reader, and two consecutive turns both ending "Finished" would
   * announce only the first.
   */
  var lastSaid = "";
  function announce(text) {
    var say = $("announcer");
    if (!say) return;
    /* A region that has not CHANGED is not announced, and two turns in a row
       both ending "Finished." are two events with one string. The usual fix is
       to empty the region and refill it a frame later; a trailing space does
       the same job synchronously, is not spoken, and cannot be lost to a
       teardown between the two halves. It alternates, so any run of repeats
       keeps changing. */
    if (text === lastSaid) text += " ";
    lastSaid = text;
    say.textContent = text;
  }

  function atBottom() {
    return logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 40;
  }
  function scroll() { logEl.scrollTop = logEl.scrollHeight; }

  /**
   * Show the way back down, but only while there is a down to go to.
   *
   * Called from the same places that decide whether to autoscroll, so the
   * button and the anchoring can never disagree about where the log is.
   */
  function syncToLatest() {
    var btn = $("toLatest");
    if (!btn) return;
    btn.hidden = atBottom();
  }
  function add(el) {
    // Anything appended after a streaming answer must not appear before the
    // last unpainted deltas of it. Flushing here covers every insertion point -
    // tool cards, errors, diffs, permissions - without each having to remember.
    // Safe during aiEl's own creation: aiEl is still null at that moment.
    flushAi();
    var stick = atBottom();
    var welcome = logEl.querySelector(".welcome");
    if (welcome) welcome.remove();
    logEl.appendChild(el);
    if (stick) scroll();
    syncToLatest();
    return el;
  }
  function clearTranscript() {
    /* Dropped, not sealed: the element is about to be removed from the DOM
       with the rest of the transcript, and holding the reference would have
       the next turn append its reasoning into a detached node - text written
       to a box nobody can see. */
    thinkEl = null;
    if (aiFrame) { cancelAnimationFrame(aiFrame); aiFrame = 0; }
    logEl.innerHTML = "";
    aiEl = null; streamEl = null; pendingTool = null; todoEl = null; toolGroup = null;
  }

  /**
   * The welcome screen.
   *
   * `arriving` is back, and it is load-bearing again.
   *
   * It was removed when the mark became a plain infinite rotation, because
   * with nothing to trigger there was no first arrival to distinguish. The
   * mark now ARRIVES - three fast turns decelerating into the steady one - and
   * that brings the original problem back with it: this function is called on
   * a data refresh as well as on a real arrival, and a session list landing
   * under the panel would otherwise throw the logo across the screen while the
   * user is reading. Two of the four call sites are refreshes; they pass
   * false, and the default is the arrival, because that is what a call with no
   * opinion means.
   *
   * The flag decides one class. See `.welcome .crystal.spin-in`.
   */
  function renderWelcome(arriving) {
    var spin = arriving !== false ? " spin-in" : "";
    clearTranscript();
    if (!S.workspace.open) {
      /* A BUTTON, not only a sentence. This screen said the right thing and
         offered no way to act on it, while the endpoint screen below it -
         the second-most-likely first-run state - has offered two buttons all
         along. Someone reading "open a folder" with nothing to press goes to
         the menu bar if they know VS Code and to Settings if they do not. */
      logEl.appendChild(div("welcome",
        crystal(46, "crystal" + spin) +
        "<h2>Open a folder to use Genesis</h2>" +
        "<p>Genesis reads endpoint profiles and skills from the folder you have open, and edits files inside it. It has nowhere to read from and nothing to edit until there is one.</p>" +
        '<div class="chips">' +
          '<button class="btn primary" data-act="openFolder">Open folder…</button>' +
        '</div>'));
      return;
    }
    if (!hasEndpoint()) {
      logEl.appendChild(div("welcome",
        crystal(46, "crystal" + spin) +
        "<h2>No endpoint configured</h2>" +
        "<p>Genesis works against endpoint profiles defined in .agent/endpoints/. Create one to get started.</p>" +
        '<div class="chips">' +
          '<button class="btn primary" data-act="newEndpoint">Create endpoint profile</button>' +
          '<button class="btn" data-act="ccEndpoints">Open Control Center</button>' +
        '</div>'));
      return;
    }
    /* The three chips here used to be invented examples - "Add retry logic to
       fetch_json()", a function nobody in this workspace has. They read as
       features of a demo rather than of the tool, and pressing one typed a
       sentence about somebody else's code.

       What is actually useful on a blank screen is the work already in
       progress, so the chips are the most recent conversations. On a genuinely
       first run there are none, and then the welcome says so and offers
       nothing - an empty row of buttons is worse than no row. */
    var recent = [];
    for (var ri = 0; ri < S.sessions.length && recent.length < 3; ri++) {
      var sess = S.sessions[ri];
      // Skip the conversation being written into - it is the empty screen the
      // user is looking at, and offering to resume it goes nowhere. Skip the
      // untouched ones too: an "Untitled" with no messages is not a thread
      // anyone remembers starting.
      if (sess.active || !sess.count || /^Untitled( \d+)?$/.test(sess.title || "")) continue;
      recent.push(sess);
    }

    // The wordmark, not a sentence. "How can I help?" is what every assistant
    // says; the mark says which one this is, and it is the one place Michroma
    // appears outside the header.
    /* ONE MARK, AND IT TURNS ONCE.
     *
     * It was briefly a pair that blinked. The roundel is a ring around a core,
     * so two of them read as eyes - and as eyes they were ugly. The mark is a
     * BEZEL: four notches on a ring, which is a thing that turns. So it turns,
     * once, a beat after the panel arrives, and then it is a logo again. */
    var body = crystal(34, "crystal" + spin) +
      '<div class="w-mark">Genesis</div>' +
      '<p>' + (recent.length
        ? "Pick up where you left off, or start something new."
        /* This used to say "never write a file until you accept it", which is
           the first sentence a new user reads and is not what happens: a write
           lands on disk as soon as the approval card is answered, and the diff
           card afterwards is a review with an undo behind it. In edits-auto or
           full-auto, and after one "Always allow", there is no card at all.
           The honest version is still the reassuring one - nothing happens
           unasked, and every change is reviewable and revertible. */
        : "I read your workspace and ask before I change anything. Every edit " +
          "arrives as a diff you can review and undo. Ask anything about this " +
          "repository.") + "</p>";

    // Openers. These were removed once for being invented examples about a
    // function nobody in the workspace has - and that objection was right about
    // the old ones and does not apply to these. Every one is a real command
    // this extension already has, aimed at what the user has open right now:
    // no invented identifiers, nothing that can refer to somebody else's code.
    body += '<div class="w-label">Try</div><div class="w-list">';
    for (var si = 0; si < STARTERS.length; si++) {
      body += '<button class="w-row" data-starter="' + esc(STARTERS[si].run) + '">' +
        icon(STARTERS[si].icon, "ic-11") +
        '<span class="t">' + esc(STARTERS[si].text) + "</span>" +
        icon("i-chev", "ic-9") + "</button>";
    }
    body += "</div>";

    if (recent.length) {
      body += '<div class="w-sec">' +
        '<div class="w-label row">Recent<span class="sp"></span>' +
          '<button class="w-all" data-act="history">All</button></div>' +
        '<div class="w-list">';
      for (var rj = 0; rj < recent.length; rj++) {
        var r = recent[rj];
        // The design's row is title + relative time. The message count it drops
        // is still worth having - a thread of one reads the same as a thread of
        // forty from its title alone - so it moves into the title attribute
        // rather than off the screen.
        var n = r.count === 1 ? "1 message" : r.count + " messages";
        // The row is a button, so the delete control cannot be inside it - a
        // button inside a button is invalid and browsers resolve it by
        // dropping the inner one. The pair is wrapped instead, exactly as the
        // history popover does it.
        body += '<span class="w-item" data-run="' + (r.running ? "1" : "0") + '">' +
          '<button class="w-row" data-session="' + esc(r.id) + '"' +
          ' title="' + esc(r.title + " - " + n + ", " + r.when +
            (r.running ? " - working now" : "")) + '">' +
          // The mockup's rule is `dot: c.live ? oxide : slate`, and the live
          // case DOES arise, though not the way it was read here before: the
          // loop above skips
          // `sess.active`, so the conversation ON SCREEN is never in this
          // list - but one you started a turn in and then switched away from
          // is, and it is still working. Slate otherwise. It was a flat GREEN
          // before, which spent the panel's success colour to say "this is a
          // row".
          (r.running ? liveMark() : '<span class="w-dot"></span>') +
          '<span class="t ell">' + esc(r.title) + "</span>" +
          '<span class="w-ago">' + esc(r.when) + "</span></button>" +
          '<button class="w-del" data-del="' + esc(r.id) + '" title="Delete this conversation" ' +
            'aria-label="Delete ' + esc(r.title) + '">' + icon("i-trash", "ic-13") + "</button>" +
          "</span>";
      }
      body += "</div></div>";
    }
    logEl.appendChild(div("welcome", body));
  }

  /* The rail is a ::before on .msg-user, so everything else has to sit in a
     .u-body wrapper or it becomes a second flex child beside the rail. */
  /**
   * One chip per attached file, rendered inside the user's turn.
   *
   * Before this the composer pills cleared on send and the transcript showed
   * only the text, which is indistinguishable from the file being dropped -
   * exactly what it looked like back when it actually was. The turn now carries
   * its own evidence.
   */
  function attChips(files) {
    if (!files || !files.length) return "";
    var out = '<span class="u-att">';
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      var kb = f.size
        ? " · " + (f.size < 1024 ? f.size + " B" : (f.size / 1024).toFixed(0) + " KB")
        : "";
      out += '<span class="u-att-chip">' + icon("i-file", "ic-11") +
        "<span>" + esc(f.name) + '</span><span class="sz">' + esc(kb) + "</span></span>";
    }
    return out + "</span>";
  }

  /* Long questions collapse.
   *
   * A pasted stack trace, a spec, a three-screen brief - all of it is the
   * user's own words and none of it can be summarised away, but at full height
   * one turn pushes the answer it is asking about off the panel entirely, and
   * scrolling back past it is the price of every later glance at the
   * conversation. Past either threshold the turn renders clamped with its own
   * expander. The text is never altered; only how much of it is on screen at
   * once, and the toggle restores it in place.
   *
   * Two thresholds because either one alone is wrong: 40 short lines is a wall
   * of text well under the character count, and one 900-character paragraph
   * wraps to a wall of text on a single line. */
  var USER_CLAMP_CHARS = 420;
  var USER_CLAMP_LINES = 7;

  function isLongUser(text) {
    return text.length > USER_CLAMP_CHARS || lineCount(text) > USER_CLAMP_LINES;
  }

  /**
   * Build one user turn, clamping it when it is long enough to bury the reply.
   *
   * `html` is the already-escaped body; `plain` is the same content as text,
   * which is what the length test and the button's label are measured against.
   */
  function userTurn(html, plain, att) {
    var msg = div("msg-user");
    /* The text this turn was BUILT from, kept on the element.
     *
     * `.msg-ai` has carried `_raw` since streaming existed; this side threw
     * `plain` away and nothing could get it back. Scraping the DOM is not the
     * same string: a multimodal question joins its text blocks with newlines
     * and drops its images, so textContent runs the blocks together and loses
     * the breaks. Everything the context menu does - copy, resend, attach -
     * wants the string the model was actually sent. */
    msg._raw = plain;
    var body = div("u-body");
    var text = div("u-text", html);
    body.appendChild(text);

    if (isLongUser(plain)) {
      msg.setAttribute("data-clamped", "1");
      var n = lineCount(plain);
      var more = document.createElement("button");
      more.className = "u-more";
      more.type = "button";
      more.setAttribute("aria-expanded", "false");
      var label = n > USER_CLAMP_LINES
        ? "Show all " + n + " lines"
        : "Show all " + fmtK(plain.length) + " characters";
      more.innerHTML = icon("i-caret", "ic-9 u-caret") + "<span>" + label + "</span>";
      more.addEventListener("click", function () {
        var open = msg.getAttribute("data-clamped") !== "1";
        msg.setAttribute("data-clamped", open ? "1" : "0");
        more.setAttribute("aria-expanded", open ? "false" : "true");
        more.querySelector("span").textContent = open ? label : "Show less";
        // Re-collapsing from the bottom of a long turn would otherwise leave
        // the viewport parked in whitespace below the message. Guarded because
        // the jsdom harness has no scrollIntoView, and a throw here would take
        // the toggle down with it.
        if (open && msg.scrollIntoView) msg.scrollIntoView({ block: "nearest" });
      });
      body.appendChild(more);
    }

    if (att) {
      var wrap = document.createElement("div");
      wrap.innerHTML = att;
      while (wrap.firstChild) body.appendChild(wrap.firstChild);
    }
    msg.appendChild(body);
    add(msg);
  }

  function addUser(content, files) {
    closeToolGroup();
    var att = attChips(files);
    if (typeof content === "string") {
      userTurn(esc(content), content, att);
      return;
    }
    if (!Array.isArray(content)) {
      userTurn(esc(String(content)), String(content), att);
      return;
    }
    var html = "", plain = "";
    for (var i = 0; i < content.length; i++) {
      var b = content[i];
      if (b.type === "image") {
        html += '<img class="msg-img" src="data:' + esc(b.mediaType) + ';base64,' + b.data + '" alt="attached image">';
      } else if (b.type === "text") {
        html += "<span>" + esc(b.text) + "</span>";
        plain += (plain ? "\n" : "") + b.text;
      }
    }
    userTurn(html, plain, att);
  }

  /* THE THROTTLE THIS COMMENT DESCRIBED DID NOT EXIST.
   *
   * It said the paint was coalesced at 50ms - "twenty repaints a second, which
   * reads as continuous" - and `aiPaint` was declared, cleared in two places
   * and never once assigned a timer. What actually ran was `typeStep` below,
   * on requestAnimationFrame, re-parsing the WHOLE message and replacing the
   * whole subtree up to sixty times a second. Faster than the thing the
   * comment was defending against, not slower.
   *
   * The measurements it quotes are still right about md(): 0.72ms for a 4KB
   * reply, 4.1ms at 41KB, and a token-paced arrival at that size spends about
   * 1.6 seconds parsing across the turn before any DOM work at all.
   *
   * But the cost a user actually NOTICES is not the parse. Replacing innerHTML
   * destroys the child nodes any selection is anchored in, so text could not be
   * selected out of a reply while it was still arriving - the selection was
   * wiped on every frame.
   *
   * `paintFrom` below is the fix, and it is not a throttle: the tail of a
   * streaming reply is almost always plain prose, so while that holds only the
   * last text node is updated and the parsed prefix is left alone. A full
   * re-parse happens when the tail stops being plain - a fence opens, a table
   * row lands, a heading appears - which is a handful of times per reply
   * instead of a thousand. Selection inside everything above the tail survives.
   *
   * `aiPaint` is gone rather than wired up: it named a mechanism that never
   * ran, and reinstating it would be reintroducing 50ms latency to solve a
   * problem the incremental path does not have. */

  /*
   * Typing is paced from a buffer, not from arrival.
   *
   * How a reply arrives is the gateway's choice, not a property of the model:
   * some stream a token per frame, others hand back the whole answer in one
   * SSE frame. Painting on arrival meant the second kind landed as a single
   * block of text with no typing at all. `_raw` is everything received,
   * `_shown` is how much has been revealed, and a frame loop closes the gap.
   *
   * The rate is proportional to the backlog, so a big burst catches up in a
   * few frames instead of crawling, while a genuine token stream still reveals
   * smoothly. `_done` marks the end of the turn: once set, the last frame
   * reveals whatever is left so nothing is ever stranded unpainted.
   */
  var aiFrame = 0;
  var TYPE_MIN = 2;      // chars per frame at the tail, so short replies still type
  var TYPE_DIVISOR = 9;  // larger backlog reveals proportionally faster

  /**
   * Everything after the last blank line, which is the part still being written.
   *
   * A markdown block cannot start in the middle of a paragraph, so the text
   * after the final blank line is the only region a new character can change
   * the STRUCTURE of. Everything before it is settled and does not need
   * re-parsing.
   */
  function tailStart(text) {
    var i = text.lastIndexOf("\n\n");
    return i === -1 ? 0 : i + 2;
  }

  /**
   * Is the growing tail still plain prose?
   *
   * If it is, appending to it can be a text-node write. If it is not - a fence
   * is open, a list or table or heading is being built, a link or code span is
   * half typed - the block's rendering depends on characters that have not
   * arrived, and only a re-parse is right.
   *
   * Deliberately conservative: every uncertain case answers "no" and falls back
   * to the correct-but-costly path. The optimisation is worth having only
   * because ordinary prose is the common case, not because it is clever.
   */
  function tailIsPlain(text, from) {
    // An odd number of fences anywhere means one is open right now.
    var fences = text.split("```").length - 1;
    if (fences % 2) return false;
    var tail = text.slice(from);
    return !/[`*_~\[\]<>|#>-]/.test(tail) && tail.indexOf("\n") === -1;
  }

  /**
   * Reveal up to `next`, re-parsing as little as possible.
   *
   * Returns nothing; the shared caller owns the scroll decision.
   */
  function paintFrom(next) {
    var full = aiEl._raw || "";
    var text = full.slice(0, next);
    var from = tailStart(text);
    var tailNode = aiEl._tail;

    if (tailNode && aiEl._tailFrom === from && tailIsPlain(text, from) &&
        tailNode.parentNode) {
      // The cheap path, and the one that matters: nothing above the tail is
      // touched, so a selection anywhere in the finished part survives.
      tailNode.nodeValue = text.slice(from);
      aiEl._shown = next;
      return;
    }

    aiEl.innerHTML = md(text);
    aiEl._shown = next;
    aiEl._tail = null;
    aiEl._tailFrom = from;
    // Arm the cheap path for the next frame, but only when the tail really did
    // render as one plain text node - which is what makes writing into it safe.
    if (tailIsPlain(text, from) && from < text.length) {
      var last = aiEl.lastChild;
      while (last && last.lastChild) last = last.lastChild;
      if (last && last.nodeType === 3 && last.nodeValue === text.slice(from)) {
        aiEl._tail = last;
      }
    }
  }

  function paintAi() {
    if (!aiEl) return;
    var full = aiEl._raw || "";
    var shown = aiEl._shown || 0;
    if (shown === full.length) return;
    // Measured before the content grows, not after. A coalesced paint adds a
    // screenful at once, so checking afterwards always reads as "the user has
    // scrolled up" and autoscroll silently stops following the answer.
    var stick = atBottom();
    paintFrom(full.length);
    if (stick) scroll();
    syncToLatest();
  }

  function typeStep() {
    aiFrame = 0;
    if (!aiEl) return;
    var full = aiEl._raw || "";
    var shown = aiEl._shown || 0;
    if (shown >= full.length) return;

    var backlog = full.length - shown;
    var step = aiEl._done ? backlog : Math.max(TYPE_MIN, Math.ceil(backlog / TYPE_DIVISOR));
    var next = Math.min(full.length, shown + step);

    var stick = atBottom();
    paintFrom(next);
    if (stick) scroll();
    syncToLatest();

    if (next < full.length) aiFrame = requestAnimationFrame(typeStep);
  }

  /** Reveal everything immediately. Used at turn end and before reordering. */
  function flushAi() {
    if (aiFrame) { cancelAnimationFrame(aiFrame); aiFrame = 0; }
    if (!aiEl) return;
    aiEl._done = true;
    paintAi();
  }

  /**
   * Paint a finished assistant message in one go.
   *
   * Replay is not streaming: the text already exists, so there is nothing to
   * pace. Routing it through the typewriter would be wrong twice over - it
   * would animate history on every hydrate, and because the caller drops
   * `aiEl` immediately afterwards the paced frame would find nothing to paint
   * and the message would stay permanently blank.
   */
  function addAiStatic(text) {
    closeToolGroup();
    var el = add(div("msg-ai", ""));
    el._raw = text;
    el._shown = text.length;
    el._done = true;
    el._tail = null;
    el.innerHTML = md(text);
    return el;
  }

  function appendAi(text) {
    if (!aiEl) {
      /* The answer has started, so the working is finished. Sealing HERE
         rather than only at turn end matters for the common shape: a model
         thinks, answers, thinks again, answers again. Left open, the second
         run of reasoning would append into the first box - above the first
         answer - and the transcript would claim the model thought it all
         before saying anything. */
      sealThinking();
      // Prose after a run of tools ends the strip - the model has stopped
      // working and started explaining.
      closeToolGroup();
      aiEl = add(div("msg-ai", ""));
      aiEl._raw = "";
      aiEl._shown = 0;
      aiEl._done = false;
      // The text node the cheap paint path writes into, and the offset it
      // starts at. Null until a paint arms it; see paintFrom.
      aiEl._tail = null;
      aiEl._tailFrom = -1;
    }
    aiEl._raw += text;
    // `add()` flushes mid-stream to keep insertion order, which marks the
    // element done. New text means the turn is still going, so resume pacing.
    aiEl._done = false;
    if (!aiFrame) aiFrame = requestAnimationFrame(typeStep);
  }

  /**
   * Everything streamed so far was the model thinking. Take it off screen.
   *
   * The bubble is removed rather than emptied. An empty bubble is a visible
   * rectangle that then has to be filled again, and the whole point is that
   * the user should never have seen the working in the first place - the
   * closest we can get to that, once it has been sent, is for it to leave
   * without a trace and the answer to arrive in a fresh one.
   */
  function resetAi() {
    sealThinking();
    if (!aiEl) return;
    if (aiFrame) { cancelAnimationFrame(aiFrame); aiFrame = null; }
    if (aiEl.parentNode) aiEl.parentNode.removeChild(aiEl);
    aiEl = null;
  }

  /* ───────────────────────── tool cards ───────────────────────── */

  /**
   * Consecutive tool calls share one strip.
   *
   * `toolGroup` stays open until prose, a user turn or the end of the run
   * closes it, so a run of Read/Grep/Edit collapses into a single "3 steps"
   * object with the total elapsed time rather than three stacked cards.
   */
  function openToolGroup() {
    if (toolGroup) return toolGroup;
    var g = div("tool-group");
    g.setAttribute("data-open", "1");
    g.setAttribute("data-running", "1");
    g.setAttribute("data-error", "0");
    g.innerHTML =
      '<button class="tool-group-head">' + icon("i-chev", "ic-9 chev") +
        '<span class="dot"></span><span class="n">1 step</span>' +
        '<span class="ms"></span></button>' +
      '<div class="tool-group-body"></div>';
    g._count = 0;
    g._t0 = Date.now();
    g.querySelector(".tool-group-head").addEventListener("click", function () {
      g.setAttribute("data-open", g.getAttribute("data-open") === "1" ? "0" : "1");
    });
    toolGroup = g;
    add(g);
    return g;
  }

  /**
   * The model's working, collapsed.
   *
   * This used to arrive as ordinary reply text, so a turn that called three
   * tools put three essays into the transcript ahead of a two-line answer -
   * and, because prose closes a tool group, split one run of three calls into
   * three separate strips each reading "1 step".
   *
   * Closed by default. Reasoning is worth having when a model does something
   * surprising and worth nothing the rest of the time, which is exactly the
   * shape of a disclosure.
   */
  /* The live box, or null between turns. `addThinking` grows this rather than
     making a new one per chunk; `sealThinking` closes it. */
  var thinkEl = null;

  function thinkWords(t) {
    var w = t.trim() ? t.trim().split(/\s+/).length : 0;
    return w + " word" + (w === 1 ? "" : "s");
  }

  /**
   * Close the live thinking box: collapse it and give it its final count.
   *
   * Called when the answer starts and again at turn end, so a turn that never
   * produced visible text still seals. Idempotent.
   */
  function sealThinking() {
    if (!thinkEl) return;
    var box = thinkEl;
    thinkEl = null;
    box.setAttribute("data-open", "0");
    box.setAttribute("data-live", "0");
    box.querySelector(".think-head .n").textContent =
      "Thought for " + thinkWords(box._raw || "");
  }

  function addThinking(text) {
    var t = String(text == null ? "" : text);
    if (!t.trim() && !thinkEl) return;

    /* ONE BOX PER RUN OF THINKING, OPEN WHILE IT IS BEING WRITTEN.
    
       This used to build a fresh `.think` element on every reasoning event.
       A model that streams its working in chunks - which is what a reasoning
       model does - therefore produced one collapsed strip PER CHUNK, each
       labelled "Thought for 4 words" as though it were a finished thought.
       Measured against the shipped panel with five chunks: five boxes, and
       `visibleChars: 0` at every step, because every one of them was closed.
    
       So while the model was thinking the user watched a stack of identical
       grey strips accumulate, saw none of the reasoning, and then got the
       whole answer at once. The panel had the text the entire time and was
       hiding it behind five doors.
    
       Now: the box is created once, opens itself, and grows. The disclosure
       still exists - it seals shut the moment the answer starts, which is
       when the working stops being the interesting thing on screen - but
       while the model IS thinking, its thinking is what you see. */
    if (!thinkEl) {
      // Captured before `aiEl` is dropped, because the insert below needs the
      // answer element that is already on screen, and the next line is what
      // forgets it.
      var prior = aiEl && aiEl.parentNode === logEl ? aiEl : null;
      // Not through `aiEl`: this is not the answer, and appending it there
      // would put it back in the same paragraph flow it just came out of.
      aiEl = null;

      var box = div("think");
      // Open, and marked live so the stylesheet can show it is still being
      // written rather than presenting it as a finished disclosure.
      box.setAttribute("data-open", "1");
      box.setAttribute("data-live", "1");
      box._raw = "";
      box.innerHTML =
        '<button class="think-head">' + icon("i-chev", "ic-9 chev") +
          '<span class="n">Thinking\u2026</span></button>' +
        '<div class="think-body"></div>';
      box.querySelector(".think-head").addEventListener("click", function () {
        box.setAttribute("data-open", box.getAttribute("data-open") === "1" ? "0" : "1");
      });

      // ABOVE the answer, never below it.
      //
      // Appending put the working after the prose it produced, because that is
      // the order the events arrive in: several providers flush a reasoning
      // summary only once the visible answer has started, so the transcript
      // read "here is the answer... and here is the thinking that led to it",
      // which is backwards and makes the disclosure look like an afterthought
      // rather than a preamble.
      if (prior) {
        flushAi();
        var stick = atBottom();
        logEl.insertBefore(box, prior);
        if (stick) scroll();
        syncToLatest();
      } else {
        add(box);
      }
      thinkEl = box;
    }

    thinkEl._raw += t;
    /* textContent, not innerHTML: this is the model's raw working, it arrives
       mid-token, and half a fence or a stray `<` must not become markup. It is
       also the cheap paint - one text node replaced, no parse - which matters
       because this runs on every chunk of a stream. */
    var body = thinkEl.querySelector(".think-body");
    var stick = atBottom();
    body.textContent = thinkEl._raw;
    /* The box is capped at 168px, so past that the newest thinking is below
       its own fold. Follow it: the point of showing the working live is the
       part being written, and a live region that stops at the first screenful
       is back to showing nothing. No CSS does this - see the note in
       sidebar.css - so it is set here, after the text lands. */
    body.scrollTop = body.scrollHeight;
    if (stick) scroll();
    syncToLatest();
  }

  /** Freeze the group's counters. Safe to call when no group is open. */
  function closeToolGroup() {
    if (!toolGroup) return;
    toolGroup.setAttribute("data-running", "0");
    toolGroup = null;
  }

  function stampGroup(g) {
    g.querySelector(".n").textContent = g._count + (g._count === 1 ? " step" : " steps");
    var s = (Date.now() - g._t0) / 1000;
    g.querySelector(".ms").textContent = s < 10 ? s.toFixed(1) + "s" : Math.round(s) + "s";
  }

  /** One collapsed tool row. Shared by the live path and session restore, so a
   *  reloaded transcript is indistinguishable from the one that just ran. */
  function toolCard(name, args) {
    var el = div("tool");
    el.setAttribute("data-open", "0");
    el.innerHTML =
      /* The status rail. A column of dots down the left of the transcript is
         readable at a glance in a way a trailing check is not: the eye tracks
         one x-position instead of a ragged right edge set by each row's own
         argument length. Colour is the whole signal - grey running, turquoise
         done, burgundy failed - so it stays legible at 5px. */
      '<button class="tool-head"><span class="tool-dot"></span>' + icon("i-chev", "ic-9 chev") +
        icon(TOOL_ICON[name] || "i-file", "ic-14 tool-icon") +
        '<span class="tool-verb">' + esc(TOOL_VERB[name] || name) + "</span>" +
        // argHtml escapes every part as it builds them.
        '<span class="tool-arg ell">' + argHtml(name, args) + "</span>" +
        '<span class="sp"></span><span class="tool-stat"></span>' +
        /* Running is the state this card spends most of its life in, and it
           was the one state with no mark at all: the slot sat empty until a
           check or a cross replaced it. On a slow read that is indistinguish-
           able from a card that has stalled. toolEnd overwrites this. */
        '<span class="tool-meta">' + spinner(12) + "</span></button>" +
      '<div class="tool-body" hidden></div>';
    el.querySelector(".tool-head").addEventListener("click", function () {
      var open = el.getAttribute("data-open") === "1";
      el.setAttribute("data-open", open ? "0" : "1");
      el.querySelector(".tool-body").hidden = open;
    });
    var stat = diffStat(name, args);
    if (stat) el.querySelector(".tool-stat").innerHTML = stat;
    return el;
  }

  function toolStart(name, args) {
    aiEl = null;
    var g = openToolGroup();
    var el = toolCard(name, args);
    g.querySelector(".tool-group-body").appendChild(el);
    g._count++;
    stampGroup(g);
    pendingTool = el;
    S.gerund = gerundFor(name, args);
    tickGerund();
    if (atBottom()) scroll();
    return el;
  }

  /**
   * "Editing src/watcher.ts" beats "Thinking…".
   *
   * The aura carries the energy; the label should carry information. The
   * argument is trimmed to its basename because a deep path pushes the elapsed
   * counter off the end of a 340px panel.
   */
  function gerundFor(name, args) {
    var base = GERUND[name] || "Thinking…";
    var a = argOf(name, args);
    if (!a) return base;
    var short = String(a).split(/[\\/]/).pop();
    if (short.length > 28) short = short.slice(0, 27) + "…";
    return base.replace(/…$/, "") + " " + short;
  }

  function toolEnd(name, args, result, isError) {
    var el = pendingTool;
    pendingTool = null;
    if (!el) el = toolStart(name, args);
    el.setAttribute("data-error", isError ? "1" : "0");
    // Drives the rail dot. Separate from data-error so "finished cleanly" has
    // its own colour rather than being the absence of a failure.
    el.setAttribute("data-done", isError ? "0" : "1");
    el.querySelector(".tool-meta").innerHTML = isError
      ? '<span class="tool-fail">' + icon("i-x", "ic-13") + "</span>"
      : '<span class="tool-ok">' + icon("i-check", "ic-13") + "</span>";
    if (toolGroup) {
      if (isError) toolGroup.setAttribute("data-error", "1");
      stampGroup(toolGroup);
    }

    var body = el.querySelector(".tool-body");
    body.innerHTML = "";
    var text = result == null ? "" : String(result);
    // A write reports itself as "Wrote 30 lines to x.md", which the card header
    // already says. Expanding it to read the same sentence twice is the whole
    // payload of the card. The arguments hold what was actually written, and
    // they are already here, so show that instead - it costs the model nothing
    // because none of this is sent back to it.
    var preview = !isError && argPreview(name, args);
    if (name === "run_command" && args && args.command) {
      // A command is the one tool whose input is worth as much as its output:
      // the header truncates it to fit a 340px row, so the full line lives
      // here. Shown even on failure, where "what was actually run" is the
      // first thing anyone checks.
      var cmd = div("term-block cmd-in");
      cmd.textContent = String(args.command);
      body.appendChild(ioRow("IN", cmd));
      if (text) body.appendChild(ioRow("OUT", resultBlock(text, name, args)));
    } else if (preview) body.appendChild(preview);
    else if (text) body.appendChild(resultBlock(text, name, args));
    if (text.length > MODEL_TRUNCATION) {
      body.appendChild(div("trunc-note",
        icon("i-warn", "ic-11") + "<span>Output truncated to 60,000 characters for the model</span>"));
    }
    // A card about a file should be able to reach it. The header cannot carry
    // the link - it is itself the button that expands the card, and a control
    // inside a control is neither valid nor operable by keyboard - so the way
    // to the file lives in the body it opens.
    var fileAction = openFileRow(name, args, isError);
    if (fileAction) body.appendChild(fileAction);
    if (isError) {
      el.setAttribute("data-open", "1");
      body.hidden = false;
    }
    // Back to the turn's own verb, not a fresh one - the work has not changed.
    S.gerund = S.idleVerb || "Thinking…";
    tickGerund();
  }

  /** Tools whose argument names a file the user may want in an editor. */
  var FILE_TOOLS = { read_file: 1, write_file: 1, edit_file: 1 };

  /**
   * The "Open in editor" row at the foot of a file tool's card.
   *
   * Returns null for anything that is not about one file, and for a failed
   * call - a write that was declined or a read that missed leaves nothing
   * worth opening, and offering it would suggest otherwise.
   */
  function openFileRow(name, args, isError) {
    if (isError || !FILE_TOOLS[name]) return null;
    var p = args && typeof args === "object" ? args.path : null;
    if (!p || typeof p !== "string") return null;
    var row = div("tool-actions");
    var btn = document.createElement("button");
    btn.className = "btn sm";
    btn.type = "button";
    btn.innerHTML = icon("i-file", "ic-11") + "<span>Open in editor</span>";
    btn.setAttribute("data-open-file", p);
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      post("openFile", { path: p });
    });
    row.appendChild(btn);
    return row;
  }

  /**
   * Large results are assigned as a single textContent write. Splitting them
   * per line would build tens of thousands of nodes and lock the webview.
   */
  /**
   * One labelled row of an IO card: a small uppercase gutter tag and a body.
   *
   * The tag is what makes a command card self-describing. Without it the
   * command and its output are two mono blocks of the same weight, and which
   * one was typed has to be inferred from position - fine on the row you just
   * watched run, guesswork three screens up in restored scrollback.
   */
  function ioRow(label, node) {
    var row = div("io-row");
    row.appendChild(div("io-tag", esc(label)));
    var body = div("io-body");
    body.appendChild(node);
    row.appendChild(body);
    return row;
  }

  /** Tools whose result IS file content, and so should be coloured as code. */
  var CODE_TOOLS = { read_file: 1, write_file: 1, edit_file: 1 };

  /**
   * The language for a tool result, taken from the path it was called with.
   *
   * Returns "" when there is no path, no extension, or no grammar for it -
   * `highlight()` falls back to plain escaped text on an empty hint, so an
   * unknown extension costs nothing and looks exactly as it did before.
   */
  function langForCall(name, args) {
    if (!CODE_TOOLS[name]) return "";
    var p = args && typeof args === "object" ? args.path : null;
    if (!p || typeof p !== "string") return "";
    var dot = p.lastIndexOf(".");
    var slash = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
    // A dotfile with no extension - .gitignore, Dockerfile - is named by its
    // basename in LANG_FAMILY, so fall back to that.
    var hint = dot > slash + 1 ? p.slice(dot + 1) : p.slice(slash + 1);
    return LANG_FAMILY[String(hint).toLowerCase()] ? hint : "";
  }

  function resultBlock(text, name, args) {
    var wrap = document.createElement("div");
    // Shell output wraps and reads as a console; file contents stay a snippet.
    var pre = div(name === "run_command" ? "term-block" : "code-block");

    // File contents get the same colours a fenced block gets.
    //
    // This was `textContent` for every tool, so a card showing 200 lines of
    // Python or JSON was one flat grey wall - the only place in the panel
    // where code is shown without being coloured, and the place it matters
    // most, because reading the file IS the card's whole content.
    //
    // `highlight()` escapes everything it does not tokenise and everything it
    // does, so its output is safe as innerHTML. When it has no grammar it
    // returns plain escaped text, which is exactly the old behaviour.
    var lang = langForCall(name, args);
    var paint = function (s) {
      if (lang) pre.innerHTML = highlight(s, lang);
      else pre.textContent = s;
    };

    if (text.length > INLINE_LIMIT) {
      paint(text.slice(0, INLINE_LIMIT));
      wrap.appendChild(pre);
      var more = document.createElement("button");
      more.className = "show-more";
      more.textContent = "Show more (" + fmtK(text.length) + " characters)";
      more.addEventListener("click", function () {
        paint(text);
        more.remove();
      });
      wrap.appendChild(more);
    } else {
      paint(text);
      wrap.appendChild(pre);
    }
    return wrap;
  }

  /**
   * What a tool card should show when opened, built from the call's arguments.
   *
   * The result string is written for the model, not for a reader: "Wrote 30
   * lines to x.md" repeats the header verbatim. The arguments carry the thing
   * that actually happened, and rendering them costs no tokens because the
   * transcript sent to the model is unaffected.
   *
   * Returns null for tools whose result really is the interesting part - a
   * command's output, a file's contents, a search's hits.
   */
  function argPreview(name, args) {
    if (!args || typeof args !== "object") return null;

    if (name === "write_file" && typeof args.content === "string") {
      var wrap = document.createElement("div");
      var pre = div("code-block");
      var body = args.content;
      var cut = body.length > INLINE_LIMIT;
      pre.innerHTML = highlight(cut ? body.slice(0, INLINE_LIMIT) : body, String(args.path || ""));
      wrap.appendChild(pre);
      if (cut) {
        var more = document.createElement("button");
        more.className = "show-more";
        more.textContent = "Show all (" + fmtK(body.length) + " characters)";
        more.addEventListener("click", function () {
          pre.innerHTML = highlight(body, String(args.path || ""));
          more.remove();
        });
        wrap.appendChild(more);
      }
      return wrap;
    }

    if (name === "edit_file" && typeof args.old_text === "string" && typeof args.new_text === "string") {
      // The same word-level treatment the diff cards use, so an edit reads the
      // same way wherever it appears.
      var oldLines = args.old_text.split("\n");
      var newLines = args.new_text.split("\n");
      var rows = [];
      for (var i = 0; i < oldLines.length; i++) rows.push({ kind: "del", text: oldLines[i] });
      for (var j = 0; j < newLines.length; j++) rows.push({ kind: "add", text: newLines[j] });
      pairWords(rows);
      var html = "";
      for (var k = 0; k < rows.length; k++) {
        var r = rows[k];
        html += '<div class="dl ' + r.kind + (r.html ? " mod" : "") + '">' +
          '<span class="sg">' + (r.kind === "add" ? "+" : "−") + "</span>" +
          '<span class="c">' + (r.html || esc(r.text)) + "</span></div>";
      }
      return div("edit-preview", html);
    }

    return null;
  }

  /* ───────────────────── word-level diff ─────────────────────
   *
   * A line background says "this line changed". On a line where one identifier
   * was renamed, that paints the other ninety characters as though they had
   * changed too, and the reader has to find the difference by eye. GitLab's
   * answer is a second, stronger tint on just the words that differ, and it is
   * the thing that makes a dense diff readable at a glance.
   *
   * Tokens are words, whitespace runs and single punctuation characters, so a
   * rename lights up the identifier rather than the whole expression.
   */
  function wordsOf(s) {
    return String(s).match(/[A-Za-z0-9_$]+|\s+|[^\sA-Za-z0-9_$]/g) || [];
  }

  /**
   * Longest common subsequence over token arrays, returning the pair of
   * "changed" flags.
   *
   * Bounded deliberately: the table is O(n·m), and two 4,000-character lines
   * would build sixteen million cells inside a render. Past the cap both lines
   * are reported as wholly changed, which is what the line background already
   * said - the loss is refinement, not correctness.
   */
  function wordDiff(a, b) {
    var A = wordsOf(a), B = wordsOf(b);
    if (A.length * B.length > 40000) return null;

    var n = A.length, m = B.length;
    var dp = new Uint16Array((n + 1) * (m + 1));
    for (var i = n - 1; i >= 0; i--) {
      for (var j = m - 1; j >= 0; j--) {
        dp[i * (m + 1) + j] = A[i] === B[j]
          ? dp[(i + 1) * (m + 1) + j + 1] + 1
          : Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + j + 1]);
      }
    }
    var aFlags = new Array(n).fill(true), bFlags = new Array(m).fill(true);
    var x = 0, y = 0, same = 0;
    while (x < n && y < m) {
      if (A[x] === B[y]) {
        aFlags[x] = false; bFlags[y] = false;
        if (A[x].trim()) same += A[x].length;
        x++; y++;
      } else if (dp[(x + 1) * (m + 1) + y] >= dp[x * (m + 1) + y + 1]) x++;
      else y++;
    }
    // Two lines that share almost nothing are a replacement, not an edit.
    // Highlighting scattered fragments of them is noise, so fall back to the
    // plain line background.
    var longest = Math.max(a.length, b.length);
    if (longest && same / longest < 0.25) return null;
    return { a: aFlags, b: bFlags, A: A, B: B };
  }

  /** Render one side of a word diff, tinting only the tokens that differ. */
  function markWords(tokens, flags) {
    var out = "", run = "", runOn = false;
    for (var i = 0; i < tokens.length; i++) {
      var on = flags[i];
      if (on !== runOn && run) {
        out += runOn ? '<span class="w">' + esc(run) + "</span>" : esc(run);
        run = "";
      }
      runOn = on;
      run += tokens[i];
    }
    if (run) out += runOn ? '<span class="w">' + esc(run) + "</span>" : esc(run);
    return out;
  }

  /**
   * Attach word-level markup to a parsed patch, in place.
   *
   * Only a run of removals immediately followed by the same number of additions
   * is treated as a modification. Anything else is a genuine insertion or
   * deletion, where there is no counterpart to compare against.
   */
  function pairWords(rows) {
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].kind !== "del") continue;
      var d = i;
      while (d < rows.length && rows[d].kind === "del") d++;
      var a = d;
      while (a < rows.length && rows[a].kind === "add") a++;
      var dels = d - i, adds = a - d;
      if (dels && dels === adds) {
        for (var k = 0; k < dels; k++) {
          var del = rows[i + k], add = rows[d + k];
          var w = wordDiff(del.text, add.text);
          if (!w) continue;
          del.html = markWords(w.A, w.a);
          add.html = markWords(w.B, w.b);
        }
      }
      i = a - 1;
    }
    return rows;
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

  /**
   * A patch as diff rows.
   *
   * Lifted out of addDiff so the APPROVAL card can use it too. Before this the
   * panel had one diff renderer and used it only after the write had happened,
   * while the card that asks permission for the write showed a plain string.
   */
  function diffRows(patch) {
    var rows = pairWords(parsePatch(patch)), body = "";
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r.kind === "hunk") {
        body += '<div class="dl hunk"><span class="g"></span><span class="g"></span>' +
          '<span class="sg"></span><span class="c">' + esc(r.text) + "</span></div>";
        continue;
      }
      var sign = r.kind === "add" ? "+" : r.kind === "del" ? "\u2212" : "";
      body += '<div class="dl ' + r.kind + (r.html ? " mod" : "") + '">' +
        '<span class="g">' + (r.oldNo == null ? "" : r.oldNo) + "</span>" +
        '<span class="g">' + (r.newNo == null ? "" : r.newNo) + "</span>" +
        '<span class="sg">' + sign + "</span>" +
        // r.html is built by markWords, which escapes every token as it goes.
        '<span class="c">' + (r.html || esc(r.text)) + "</span></div>";
    }
    return body;
  }

  function addDiff(m) {
    aiEl = null;
    closeToolGroup();
    var body = diffRows(m.patch);

    var card = div("diff-card",
      '<div class="diff-head">' + icon("i-file", "ic-13") +
        '<span class="f ell">' + esc(m.file) + "</span>" +
        '<span class="s"><span class="add-n">+' + m.added + '</span> ' +
        '<span class="del-n">\u2212' + m.removed + "</span></span></div>" +
      '<div class="diff-body">' + body + "</div>" +
      (m.truncated ? '<div class="trunc-note" style="padding:0 9px 6px">' + icon("i-warn", "ic-11") +
        "<span>Patch truncated at 30,000 characters</span></div>" : "") +
      /* The mark, then straight to the decision.
      
         This carried "Genesis: 3 additions, 1 deletions" as well, which is the
         same count the card's HEADER states as `+3 -1` two rows above. That
         sentence measured 228px in a 390px footer, so the row needed 487px and
         wrapped: Accept ended up alone on one line with Reject and Diff view
         underneath it. Three controls of one decision, split across two rows,
         with the primary one separated from its alternatives.
      
         The counts were the redundant part, so the counts went. */
      '<div class="diff-foot">' + crystal(16) +
        '<span class="sp"></span>' +
        '<button class="btn sm go" data-diff="accept">Accept</button>' +
        '<button class="btn sm" data-diff="reject">Reject</button>' +
        '<button class="btn sm" data-diff="view">Diff view</button></div>');

    card.dataset.turn = m.turnId;
    card.dataset.file = m.file;
    card.addEventListener("click", function (e) {
      var b = e.target.closest("[data-diff]");
      if (!b) return;
      var action = b.getAttribute("data-diff");
      /* "Diff view" used to post `openFile`, which opens the plain file with
         nothing highlighted - the one thing a control called "Diff view" must
         not do. The host has the pre-turn blob in the shadow repo and now
         serves it to `vscode.diff`. */
      if (action === "view") { post("openDiff", { turnId: m.turnId, file: m.file }); return; }
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

  /* ───────────────────────── agents ───────────────────────── */

  /**
   * One line saying what an agent can reach.
   *
   * Written from the DTO rather than from prose in the file, so it cannot
   * disagree with what the host will actually enforce - the failure mode of a
   * hand-written summary is that it stays true for one release.
   */
  function agentScope(a) {
    if (!a) return "";
    var parts = [];
    parts.push(a.tools && a.tools.length ? a.tools.length + " built-in tools" : "all built-in tools");
    if (a.allMcp) parts.push("all MCP servers");
    else if (a.mcp && a.mcp.length) {
      parts.push("MCP: " + a.mcp.map(function (m) {
        // Three states. A count is "these tools"; a bare name is "all of them";
        // "(none)" is an include list written and left empty, which withholds
        // every tool on the server. Reading include.length alone drew that last
        // case as unrestricted, which is the label agreeing with a bug rather
        // than with the user's file.
        if (!m.includeActive) return m.server;
        return m.include && m.include.length
          ? m.server + " (" + m.include.length + ")"
          : m.server + " (none)";
      }).join(", "));
    } else parts.push("no MCP");
    if (a.skills && a.skills.length) parts.push(a.skills.length + " skills");
    if (a.model) parts.push(a.model);
    if (a.memory) parts.push("memory");
    return parts.join(" · ");
  }

  function activeAgentDto() {
    for (var i = 0; i < S.agents.length; i++) {
      if (S.agents[i].name === S.activeAgent) return S.agents[i];
    }
    return null;
  }

  function renderAgentBar() {
    var bar = $("agentBar");
    var a = activeAgentDto();
    if (!a) { bar.hidden = true; return; }
    bar.hidden = false;
    $("agentBarName").textContent = a.name;
    $("agentBarScope").textContent = agentScope(a);
    $("agentBarScope").title = a.description || agentScope(a);
  }

  /** The Agents section in the Diagnostics tab. */
  function renderAgents() {
    var body = $("agBody");
    var badge = $("agBadge");
    if (!body) return;
    badge.textContent = S.agents.length ? String(S.agents.length) : "-";
    badge.className = S.agentWarnings.length ? "badge alert" : "badge";

    var html = "";
    if (!S.agents.length) {
      html +=
        '<div class="ag-empty">' +
        "<p>An agent is a persona plus a list of what it may reach: which built-in tools, " +
        "which MCP servers and which of their tools, which skills, and a memory file it " +
        "keeps for itself. They live in <code>.agent/agents/</code>, one Markdown file each.</p>" +
        '<button class="btn primary sm" data-ag="new">Create an agent</button></div>';
    } else {
      html += '<div class="ag-rows">';
      for (var i = 0; i < S.agents.length; i++) {
        var a = S.agents[i];
        html += '<div class="ag-row" data-on="' + (a.active ? "1" : "0") + '">' +
          '<div class="ag-head">' + icon("i-agent", "ic-13") +
            '<span class="n ell">' + esc(a.name) + "</span>" +
            (a.active ? '<span class="ag-live">active</span>' : "") +
            '<span class="sp"></span>' +
            '<button class="btn sm" data-ag="use" data-name="' + esc(a.name) + '">' +
              (a.active ? "Leave" : "Use") + "</button>" +
            '<button class="btn sm" data-ag="open" data-name="' + esc(a.name) + '">Open</button>' +
          "</div>" +
          (a.description ? '<div class="ag-desc">' + esc(a.description) + "</div>" : "") +
          '<div class="ag-scope">' + esc(agentScope(a)) + "</div>" +
          '<div class="ag-file">' + esc(a.file) + "</div>" +
          "</div>";
      }
      html += "</div>";
      // The footer states which agent is in force, and nothing else.
      //
      // It used to end in a second "New agent" button, identical in label and
      // behaviour to the one in the sticky header a few hundred pixels above.
      // Two identical primary actions on one screen is not two chances to find
      // it - it is a moment spent working out whether they differ. The header's
      // copy stays, because it is the one that is always on screen.
      html += '<div class="sk-foot"><span>' +
        (S.activeAgent ? esc(S.activeAgent) + " is active" : "No agent - the default assistant") +
        "</span></div>";
    }
    if (S.agentWarnings.length) {
      html += '<div class="warn-line">' + esc(S.agentWarnings.join(" ")) + "</div>";
    }
    body.innerHTML = html;
    renderAgentCount();
  }

  /**
   * The number on the Agents tab.
   *
   * Warnings, not agents. A count of how many agents exist is not news - it is
   * on the tab's own page - whereas a file that failed to parse is something
   * the user has to be told about while looking somewhere else. Same rule the
   * MCP and Diagnostics tabs follow.
   */
  function renderAgentCount() {
    setTabCount("tabAgents", "agentCount", "Agents", S.agentWarnings.length,
      "agent files could not be read");
  }

  function onAgentClick(e) {
    var b = e.target.closest("[data-ag]");
    if (!b) return;
    var a = b.getAttribute("data-ag");
    if (a === "new") { post("newAgent"); return; }
    var name = b.getAttribute("data-name");
    if (a === "open") { post("openAgent", { name: name }); return; }
    if (a === "use") {
      // The button on the active row says Leave, so it has to send "" rather
      // than the name it is sitting on.
      post("setAgent", { name: name === S.activeAgent ? "" : name });
    }
  }

  /* ───────────────────── changed files ───────────────────── */

  /**
   * The live change list above the composer.
   *
   * `hot` is the path of the file that was just written, if any. It is the one
   * piece of state the DOM cannot re-derive: the list is rebuilt wholesale on
   * every event, so the flash has to be re-applied to the row it belongs to
   * rather than surviving in it. Rebuilding is affordable because the list is
   * one row per file, not one per write.
   */
  /**
   * The messages waiting for the running turn to finish.
   *
   * Every row carries the two things that were missing: what it actually says,
   * and a way out of it. "Send now" steers it into the turn already running;
   * the cross drops it. Both were previously impossible - a queued message was
   * announced once and then unreachable until it sent itself.
   */
  /**
   * The composer's hint, as ONE unbreakable run.
   *
   * A textarea placeholder wraps at any space, so at a narrow dock width the
   * old literal broke inside the bracket and left ")" alone on the second line.
   * The spaces INSIDE the hint are non-breaking, so the only place it can wrap
   * is the gap before it - the hint moves to the next line whole, or not at all.
   *
   * Four placeholders used to carry their own copy of this string, and one of
   * them had already drifted out of step with the palette. One definition now.
   */
  var COMPOSER_HINT = "\u00A0\u00A0(/skills\u00A0·\u00A0@files)";
  /* The terminal treatment's prompt marker. It lives on the placeholder
     rather than in the markup because the textarea auto-grows and a floating
     element beside it would have to track that; the trade is that it goes
     away once you type, which a real shell prompt would not do. */
  var CARET = "\u203A\u00A0";

  function renderQueue() {
    var wrap = $("queue");
    if (!wrap) return;
    var items = S.queue || [];
    wrap.hidden = items.length === 0;
    if (!items.length) { $("queueList").innerHTML = ""; return; }
    $("queueCount").textContent = items.length === 1
      ? "1 message waiting"
      : items.length + " messages waiting";
    var html = "";
    for (var i = 0; i < items.length; i++) {
      var q = items[i];
      html += '<div class="queue-row" data-id="' + esc(q.id) + '">' +
        '<span class="pos">' + (i + 1) + "</span>" +
        '<span class="qt ell" title="' + esc(q.text) + '">' + esc(q.text) + "</span>" +
        attChips(q.files) +
        '<button class="queue-now" data-q="now" title="Send now - the model reads it before its next step" ' +
          'aria-label="Send now">' + icon("i-up", "ic-11") + "</button>" +
        '<button class="queue-x" data-q="drop" title="Cancel this message" ' +
          'aria-label="Cancel this message">' + icon("i-x", "ic-11") + "</button>" +
      "</div>";
    }
    $("queueList").innerHTML = html;
  }

  function renderChanges(hot) {
    var bar = $("changeBar");
    var files = S.changes || [];
    if (!files.length) {
      bar.hidden = true;
      $("chgList").innerHTML = "";
      return;
    }

    var add = 0, del = 0, est = false;
    for (var i = 0; i < files.length; i++) {
      add += files[i].added || 0;
      del += files[i].removed || 0;
      if (!files[i].exact) est = true;
    }
    bar.hidden = false;
    $("chgCount").textContent =
      files.length + (files.length === 1 ? " file changed" : " files changed");
    /* A tilde while the counts are the writing tool's own estimate, dropped
       once git has confirmed them at the end of the turn. Silently showing an
       approximation as though it were exact is the thing worth avoiding. */
    $("chgStat").innerHTML =
      '<span class="add-n">' + (est ? "~" : "") + "+" + add + "</span> " +
      '<span class="del-n">\u2212' + del + "</span>";

    var html = "";
    for (var j = 0; j < files.length; j++) {
      var f = files[j];
      var norm = String(f.path).replace(/\\/g, "/");
      var cut = norm.lastIndexOf("/");
      var dir = cut === -1 ? "" : norm.slice(0, cut + 1);
      var base = cut === -1 ? norm : norm.slice(cut + 1);
      html += '<button class="chg-row' + (f.path === hot ? " hot" : "") + '" data-chg="' + esc(f.path) + '" ' +
        'title="' + esc(norm) + ' - click to open">' +
        '<span class="chg-kind" data-kind="' + esc(f.change) + '">' +
          (f.change === "created" ? "A" : "M") + "</span>" +
        '<span class="chg-path ell">' +
          (dir ? '<span class="p-dir">' + esc(dir) + "</span>" : "") +
          '<span class="p-name">' + esc(base) + "</span></span>" +
        '<span class="sp"></span>' +
        '<span class="s">' +
          (f.added ? '<span class="add-n">+' + f.added + "</span> " : "") +
          (f.removed ? '<span class="del-n">\u2212' + f.removed + "</span>" : "") +
        "</span></button>";
    }
    $("chgList").innerHTML = html;
  }

  /** Fold one live write into the list without waiting for a full refresh. */
  function applyTouch(file) {
    if (!file || !file.path) return;
    var files = (S.changes || []).filter(function (f) { return f.path !== file.path; });
    files.unshift(file);
    files.sort(function (a, b) { return (b.at || 0) - (a.at || 0); });
    S.changes = files;
    renderChanges(file.path);
  }

  function setChangesOpen(open) {
    S.changesOpen = open;
    $("changeBar").setAttribute("data-open", open ? "1" : "0");
    $("chgToggle").setAttribute("aria-expanded", open ? "true" : "false");
    $("chgList").hidden = !open;
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
    closeToolGroup();
    todoEl = add(div("card", html));
  }

  function addPermission(m) {
    aiEl = null;
    closeToolGroup();
    // The one interruption that is genuinely an interruption: the turn has
    // stopped and is waiting on an answer nobody has been told is wanted.
    announce("Permission required: " + m.summary);
    /* WHAT "ALWAYS" MEANS, ON THE BUTTON THAT MEANS IT.
     *
     * The label was "Always allow" for both kinds of request, and the two are
     * not the same grant at all. For an edit it sets a flag for this session.
     * For a command it appends the command's FIRST TOKEN to a workspace-level
     * list that survives restarts - so "always allow" on `git status`
     * permanently authorises `git push --force`, and the only place that was
     * ever said was the card's replacement text, after the click.
     *
     * The scope goes on the control. `git` rather than `git status`, because
     * the token is what is actually being granted and printing the full command
     * would promise a precision the grant does not have. */
    var isCmd = String(m.summary || "").indexOf("Run:") === 0;
    var token = isCmd
      ? String(m.summary).replace(/^Run:\s*/, "").trim().split(/\s+/)[0]
      : "";
    var always = isCmd
      ? "Always allow " + esc(token)
      : "Always allow edits";
    /* Built raw and escaped ONCE, at the point of use. Escaping the token and
       then dropping the result into a double-quoted attribute alongside a
       literal quote character closed the attribute early and swallowed the rest
       of the sentence - the tooltip read "Every command starting with " and
       stopped. Typographic quotes would have hidden that rather than fixed it. */
    var alwaysTitle = isCmd
      ? 'Every command starting with "' + token + '" runs without asking, in this ' +
        "workspace, until you revoke it in the Control Center."
      : "Every file edit runs without asking for the rest of this conversation.";
    var el = add(div("perm",
      '<div class="perm-t">' + icon("i-warn", "ic-14") + "Permission required</div>" +
      '<div class="perm-b">Genesis wants to:</div>' +
      '<div class="perm-cmd">' + esc(m.summary) + "</div>" +
      /* THE CHANGE, AS A DIFF, AT THE MOMENT OF THE DECISION.
       *
       * This was `esc(m.detail)` in a monospace block: no gutter, no line
       * numbers, no add/del wash - and for an overwrite it was a truncated
       * prefix of the NEW content with not one line of the old. So the default
       * mode asked people to authorise an edit from a blob, while diffRows()
       * eighty lines up rendered exactly this, properly, three seconds later
       * on the diff card. Same information, same treatment, both moments.
       *
       * `detail` remains the fallback: a shell command and a fetch have a
       * payload worth reading and no patch to make of it. */
      (m.patch
        ? '<div class="perm-diff diff-body">' + diffRows(m.patch) + "</div>"
        : m.detail ? '<div class="perm-cmd" style="margin-top:6px">' + esc(String(m.detail).slice(0, 4000)) + "</div>" : "") +
      '<div class="perm-actions">' +
        '<button class="btn go" data-perm="allow">Allow once</button>' +
        '<button class="btn" data-perm="always" title="' + esc(alwaysTitle) + '">' + always + "</button>" +
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
        ? '<span style="color:var(--kx-error);display:flex">' + icon("i-x", "ic-13") + "</span>"
        : '<span style="color:var(--kx-accent);display:flex">' + icon("i-check", "ic-13") + "</span>") +
        "<span>" + esc(label) + "</span>";
      return;
    }
  }

  function addPlan(m) {
    aiEl = null;
    closeToolGroup();
    var steps = "";
    for (var i = 0; i < m.steps.length; i++) {
      steps += '<li><span class="n">' + (i + 1) + '</span><span>' + esc(m.steps[i]) + "</span></li>";
    }
    var el = add(div("plan-card",
      '<div class="plan-h"><span class="dot"></span><span class="t">Proposed plan</span>' +
      '<span class="m">' + esc(m.meta) + "</span></div>" +
      '<ul class="plan-steps">' + steps + "</ul>" +
      '<div class="plan-foot">' +
        '<button class="btn go" data-plan="run">Approve &amp; run</button>' +
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

  /**
   * The Overload aura: spinning radiation rays, three frame-swapped ki bands,
   * a shockwave ring and three rising embers, all behind a crystal that never
   * moves. Every layer is a bare span positioned by CSS - the markup carries
   * no geometry so the whole composition can be retuned in sidebar.css alone.
   */
  function auraMarkup() {
    // Two stacked marks, not eight layers.
    //
    // What was here was the Kryptonite "ki aura": a conic ray sweep, three
    // green spike bands on offset clocks, a shockwave and three embers, all
    // behind the mark. Against the Genesis roundel it read as the OLD LOGO
    // still burning behind the new one, which is exactly what it was - the
    // green is #0B5B3F / #17A874, nowhere in this palette.
    //
    // Genesis says the mark moves one way: the dim bezel holds still and a
    // single oxide notch sweeps it. One element, one rotation, no colour that
    // is not already the brand's.
    return '<span class="rad">' +
      crystal(20, "rad-plate", "dim") +
      crystal(20, "rad-notch", "notch") +
      "</span>";
  }

  function startStream() {
    if (!streamEl) {
      // Three parts, as the design draws it: the mark, a column holding the
      // verb over a mono sub-line, and the elapsed figure hard right.
      //
      // It was mark + verb + "(esc to interrupt · 4s)" on one line, which put
      // the shortcut, the clock and the verb in one run of text at one size -
      // so the only part that changes as the turn goes on, the seconds, was
      // the least findable thing in it. Splitting them lets the verb shimmer
      // on its own, keeps the shortcut quiet where it belongs, and gives the
      // figure a fixed right edge to count in.
      streamEl = add(div("stream",
        auraMarkup() +
        '<span class="s-col"><span class="g"></span>' +
          '<span class="s-sub"><span class="s-esc">esc</span> to interrupt</span></span>' +
        '<span class="m tnum"></span>'));
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
    // Just the figure. The shortcut it used to share a line with is static and
    // now lives in the sub-line, so this element only ever holds the one thing
    // that moves.
    streamEl.querySelector(".m").textContent = S.elapsed + "s";
  }
  function endStream() {
    flushAi();
    /* A turn can end with the working still open - the model spent the whole
       turn reasoning and produced no visible text, or it was interrupted. The
       box must not be left saying "Thinking…" over a model that has stopped. */
    sealThinking();
    if (S.timer) { clearInterval(S.timer); S.timer = null; }
    if (streamEl) { streamEl.remove(); streamEl = null; }
    S.gerund = "Thinking…";
    S.idleVerb = null;
  }

  /**
   * Close the turn: freeze the tool strip, then add the hover actions and a
   * divider so the transcript has a pulse instead of running together.
   *
   * The footer is only added when the turn actually produced something -
   * an interrupt before the first token should not leave a stray rule behind.
   */
  /** Stop every spinning retry button. Called when a turn actually starts. */
  function clearRetrySpinners() {
    var busy = logEl.querySelectorAll('.turn-foot [data-busy]');
    for (var i = 0; i < busy.length; i++) {
      busy[i].removeAttribute("data-busy");
      busy[i].removeAttribute("aria-busy");
      busy[i].title = "Retry";
    }
  }

  function endTurn() {
    closeToolGroup();
    // Retry spins for as long as the turn it started, which is the honest
    // reading: it is still retrying. Any of them may be spinning - the
    // transcript can hold many footers - so all of them stop.
    clearRetrySpinners();
    var last = logEl.lastElementChild;
    if (!last || last.classList.contains("turn-div") || last.classList.contains("welcome")) return;

    var secs = S.elapsed;
    var used = S.context ? S.context.used : 0;
    // Icons, not words. Three labels under every turn read as a toolbar the eye
    // has to parse each time; the glyphs are recognisable and let the row shrink
    // to something that sits under the answer rather than competing with it.
    // Each keeps its name for the tooltip and for a screen reader.
    var foot = div("turn-foot",
      '<button data-turn="copy" title="Copy answer" aria-label="Copy answer">' + icon("i-copy", "ic-13") + "</button>" +
      '<button data-turn="retry" title="Retry" aria-label="Retry">' + icon("i-refresh", "ic-13") + "</button>" +
      '<button data-turn="branch" title="Branch into a new chat" aria-label="Branch into a new chat">' +
        icon("i-branch", "ic-13") + "</button>" +
      '<span class="cost">' + secs + "s" + (used ? " · " + fmtK(used) : "") + "</span>");
    var text = aiEl && aiEl._raw ? aiEl._raw : "";
    foot.addEventListener("click", function (e) {
      var b = e.target.closest("[data-turn]");
      if (!b) return;
      var a = b.getAttribute("data-turn");
      if (a === "copy") {
        post("copyText", { text: text });
        // An icon gives no feedback on its own, so confirm the copy happened.
        var prev = b.innerHTML;
        b.innerHTML = icon("i-check", "ic-13");
        b.setAttribute("data-done", "1");
        setTimeout(function () { b.innerHTML = prev; b.removeAttribute("data-done"); }, 1200);
      } else if (a === "retry") {
        /* Retry acknowledges the CLICK, not the answer.
         *
         * Reported as "clicking redo takes time to do effect". It does: the
         * host has to start a turn, and on a cold endpoint the first token is
         * seconds away. Nothing was wrong with the request - what was wrong is
         * that the button looked identical before and after it, so the only
         * available reading was that the click had missed. Copy already had
         * this and retry did not.
         *
         * The spin starts on the frame of the click and stops when the turn it
         * asked for actually appears, so the row is telling the truth about
         * how long the wait is rather than flashing and lying. A second click
         * while it spins is ignored: it would send the same sentence twice. */
        if (b.hasAttribute("data-busy")) return;
        b.setAttribute("data-busy", "1");
        b.setAttribute("aria-busy", "true");
        b.title = "Retrying…";
        /* Through sendText, not straight to post().
         *
         * This is the larger half of the same complaint. A raw post skipped
         * every bit of turn setup the composer does: no user bubble, no
         * streaming aura, no running flag. Nothing appeared until the host's
         * first delta came back, so a retry on a slow endpoint was several
         * seconds of a transcript that had not changed. sendText draws the
         * turn immediately when the panel is idle and hands the message to the
         * queue when it is not - which is also the only correct behaviour when
         * a turn is already running, and the raw post got that wrong too. */
        sendText("Retry that last step.");
        // The new turn lands at the bottom; a retry pressed from further up
        // the transcript would otherwise put the answer somewhere unseen.
        scroll();
      } else if (a === "branch") post("newChat");
    });
    add(foot);
    add(div("turn-div"));
  }

  /* ───────────────────────── composer ───────────────────────── */

  function syncComposer() {
    var draft = $("draft");
    // The mirror is a second copy of the draft, painted under the transparent
    // textarea to colour skills and @paths. Clearing `draft.value` on send
    // left the mirror holding the old text, so what was just sent stayed on
    // screen underneath the placeholder. Every path that changes the draft
    // ends here, so this is the one place that cannot be forgotten.
    renderDraftMirror();
    var blocked = !S.workspace.open || !hasEndpoint();
    draft.disabled = blocked;
    // The aura reads this. Kept as an attribute rather than a class so the
    // CSS can say what it means - a composer that is streaming - instead of
    // naming a state twice in two vocabularies.
    var composer = draft.closest(".composer");
    if (composer) composer.setAttribute("data-streaming", S.running ? "1" : "0");
    // syncComposer runs on every render and overwrites the placeholder set at
    // mount, so this is the string that actually shows. It said "/ commands"
    // after `/` was changed to list skills - the mount was updated and this was
    // not, which is why the panel disagreed with the palette.
    // While a turn runs, the composer says what will happen to what you type,
    // because what happens is not what happens the rest of the time: it joins
    // the queue above rather than starting a turn. Naming the phase here would
    // be describing a mode that is not in force yet.
    // Every branch carries the prompt caret, including the blocked one. Putting
    // it on only some of them made the marker blink in and out as the phase
    // changed, which reads as a rendering bug rather than a prompt.
    /* TWO DIFFERENT BLOCKERS, TWO DIFFERENT SENTENCES.
     *
     * `blocked` is `!workspace.open || !hasEndpoint()`, and both branches used
     * to print "Configure an endpoint first…" - which names the fix for the
     * second one. Someone who installs this and clicks the icon on VS Code's
     * welcome screen, with no folder open, is told to go and configure an
     * endpoint. There is nothing to configure: profiles are read from .agent/
     * in the folder you have open, and there is no folder. Nothing on screen
     * said the word "folder", so the next stop was Settings, and the next stop
     * after that was uninstalling it. It is the most likely thing in this
     * panel to happen to a new user, because it happens before they have done
     * anything at all. */
    draft.placeholder = CARET + (!S.workspace.open
      ? "Open a folder to start…"
      : blocked
      ? "Add an endpoint to start…"
      : S.running
      ? "Queue another message…" + COMPOSER_HINT
      : S.phase === "plan"
        ? "Describe what to plan…" + COMPOSER_HINT
        : S.phase === "ask"
          ? "Ask Genesis anything…" + COMPOSER_HINT
          : "Tell Genesis what to do…" + COMPOSER_HINT);

    var send = $("sendBtn");
    var typing = draft.value.trim() || (S.attachments && S.attachments.length);
    if (S.running && !typing) {
      send.setAttribute("data-mode", "stop");
      send.setAttribute("data-ready", "0");
      send.title = "Interrupt";
      send.setAttribute("aria-label", "Interrupt");
      send.innerHTML = icon("i-stop", "ic-13");
      send.disabled = false;
    } else if (S.running) {
      // Typing during a run means the user wants to say something, not to
      // stop the model. The button says so, and names which mode is armed so
      // the outcome is not a surprise.
      var steering = S.config && S.config.ui && S.config.ui.inputWhileRunning === "steer";
      send.setAttribute("data-mode", "send");
      send.setAttribute("data-ready", "1");
      send.title = steering ? "Send now - the model reads it before its next step" : "Queue for when this turn finishes";
      send.setAttribute("aria-label", send.title);
      send.innerHTML = icon("i-up", "ic-13");
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
    // Attach follows the composer. With no workspace and no endpoint there is
    // nothing to attach a file TO, and a file picker that opens onto a turn
    // that cannot be sent is a dead end. This line used to sit on the `@`
    // button, which is gone; without it the paperclip stayed live on a
    // composer that was otherwise entirely disabled.
    $("clipBtn").disabled = blocked;
    $("modelBtn").disabled = !hasEndpoint();

    /* Reset to auto so scrollHeight reflects the real content height, not a
       previous clamp. Then set overflow: the scrollbar must only appear once the
       content exceeds max-height - showing it on an empty textarea was the bug. */
    draft.style.height = "auto";
    var natural = draft.scrollHeight;
    draft.style.height = Math.min(natural, 120) + "px";
    draft.style.overflow = natural > 120 ? "auto" : "hidden";
  }

  function detectQuickPick() {
    if (S.modelOpen) return;
    var v = $("draft").value;
    var wasFile = !!(S.qp && S.qp.kind === "file");
    if (/^\/[^\s]*$/.test(v)) {
      S.qp = { kind: "cmd", q: v.slice(1) };
    } else {
      // Everything up to whitespace, not `[\w./-]`.
      //
      // The old class was A-Za-z0-9_ plus dot, slash and dash, which quietly
      // excluded every path with a space, a `+`, a `#`, brackets, or any
      // non-ASCII character in it - a repo with an accented or CJK filename
      // could type the whole name and the picker never opened. It is not that
      // those files ranked badly; the mention was never detected.
      //
      // Widening it cannot catch an email, because `@` there is not preceded
      // by whitespace, and a decorator that matches simply finds nothing.
      var m = v.match(/(?:^|\s)@(\S*)$/);
      if (m) {
        // A NEW mention starts with an empty list rather than the previous
        // mention's. Carrying the old hits over meant the first frame of a
        // fresh `@` showed answers to a question nobody had asked.
        if (!wasFile) S.files = [];
        S.qp = { kind: "file", q: m[1] };
        scheduleSearch(m[1], !wasFile);
      } else {
        S.qp = null;
        S.searching = false;
      }
    }
    S.qpIndex = 0;
    renderQuickPick();
  }

  /**
   * Ask the host for candidates.
   *
   * `now` is the first ask of a mention - the keystroke that typed the `@`
   * itself. That one goes out immediately: the picker has just opened with
   * nothing in it, so there is no flicker for a debounce to protect, and 150ms
   * of an empty picker is 150ms of the panel looking broken. Every keystroke
   * after it is debounced as before, because those DO replace a list that is
   * already on screen.
   *
   * `S.searching` exists because "no answer yet" and "no matches" are not the
   * same fact and the picker was rendering them with the same sentence. On a
   * workspace big enough for the scan to take a moment, "No matching files"
   * was the only thing anyone ever saw.
   */
  function scheduleSearch(query, now) {
    if (S.searchTimer) clearTimeout(S.searchTimer);
    S.searching = true;
    var run = function () {
      S.fileQuery = query;
      post("searchFiles", { query: query });
    };
    if (now) run();
    else S.searchTimer = setTimeout(run, 150);
  }

  function qpItems() {
    if (S.agentOpen) {
      // "None" is a row rather than a separate control: leaving an agent is
      // exactly as common as entering one, and hiding the way out is how a
      // mode becomes a trap.
      var out = [{ group: "Agents" }, { agent: "", desc: "No agent - the default assistant", active: !S.activeAgent }];
      for (var a = 0; a < S.agents.length; a++) {
        out.push({
          agent: S.agents[a].name,
          desc: S.agents[a].description || "",
          scope: agentScope(S.agents[a]),
          active: S.agents[a].name === S.activeAgent
        });
      }
      return out;
    }
    if (S.modelOpen) {
      var rows = [];
      var current = activeProfile();
      // Auto first, and only when there is a choice to make. With one profile
      // "let the extension pick" and "pick that one" are the same instruction,
      // and offering both invites the user to wonder what the difference is.
      var pinned = (S.config && S.config.activeProfile) || "";
      var hasAuto = S.models.length > 1;
      if (hasAuto) {
        rows.push({
          auto: true,
          model: "Auto",
          // When Auto is what is in force, say what it currently resolves to.
          // "Follow the first healthy endpoint" describes the rule; naming the
          // answer is what the user actually wants to know, and it is the only
          // way the endpoint in use stays visible once the dot moves up here.
          desc: pinned === "" && current
            ? "Following " + current.id + " - the first healthy endpoint"
            : "Follow the first healthy endpoint",
          active: pinned === ""
        });
      }
      // Grouped by KIND, not by endpoint.
      //
      // Endpoint was the obvious grouping and the wrong one: with one model per
      // profile it produced a header per row, so the list was twice as tall as
      // it needed to be and every header restated a name the row below already
      // carried. What a user is choosing between here is capability - "I want
      // the one that thinks", "I want the one that sees" - so that is what the
      // headers say, and the endpoint moves onto the row where it belongs as
      // the answer to "which of these serves it".
      //
      // Buckets are walked in LLM_KINDS order rather than in profile order, so
      // the list reads the same way every time regardless of what order the
      // endpoints happen to load in. A profile whose kind this build does not
      // recognise resolves through llmKind() to chat rather than vanishing.
      for (var k = 0; k < LLM_KINDS.length; k++) {
        var bucket = [];
        for (var bi = 0; bi < S.models.length; bi++) {
          if (llmKind(S.models[bi].kind).id === LLM_KINDS[k].id) bucket.push(S.models[bi]);
        }
        if (!bucket.length) continue;
        rows.push({ group: LLM_KINDS[k].label, groupKind: LLM_KINDS[k].id, groupHue: LLM_KINDS[k].hue });
        for (var bj = 0; bj < bucket.length; bj++) {
          var g = bucket[bj];
          for (var j = 0; j < g.models.length; j++) {
            rows.push({
              endpoint: g.group,
              model: g.models[j],
              kind: g.kind,
            // Exactly one row in this list is the selection. With an Auto row
            // present it owns the unpinned state, so a model row is lit only
            // when it is pinned by name - otherwise Auto and the endpoint it
            // resolved to both lit up, which reads as two selections. With no
            // Auto row there is nothing else to own it, so the single resolved
            // endpoint is the selection.
              active: hasAuto
                ? pinned === g.group
                : Boolean(current && current.id === g.group)
            });
          }
        }
      }
      return rows;
    }
    if (!S.qp) return [];
    var q = S.qp.q.toLowerCase();
    if (S.qp.kind === "cmd") return slashItems(q);
    return S.files.map(function (f) { return { file: f.path, badge: f.kind }; });
  }

  /**
   * What `/` offers.
   *
   * Skills first, because that is what a slash means here: the SKILL.md files
   * in this workspace plus the ones that ship with the extension, exactly as
   * they appear on disk. The extension's own features are still reachable, but
   * they are chrome - they sit in a second group under "Commands" so they
   * cannot crowd out the thing the user is actually looking for.
   *
   * Disabled skills are omitted rather than greyed: an unchecked skill is not
   * in the model's system prompt, so offering it here would invoke a name the
   * model has never been told about.
   */
  /**
   * 0 when `q` starts the name, 1 when it appears later, -1 when not at all.
   *
   * The filter was prefix-only, which made `/` a completer rather than a
   * search: `tls-basics` sat in the list while typing `basics` found nothing.
   * A name is often easier to recall by its middle than its start, and the
   * list is long enough that scrolling is not an answer on its own.
   *
   * Prefix still ranks first, because when someone types the beginning of a
   * name that is the one they mean.
   */
  function slashRank(name, q) {
    var i = name.indexOf(q);
    return i < 0 ? -1 : i === 0 ? 0 : 1;
  }

  function slashItems(q) {
    var rows = [];
    // An empty q matches every name, so this is also the "just typed /" case:
    // the whole list, alphabetical, to be scrolled or narrowed.
    var skills = S.skills
      .filter(function (s) { return s.enabled && slashRank(s.name.toLowerCase(), q) >= 0; })
      .sort(function (a, b) {
        return slashRank(a.name.toLowerCase(), q) - slashRank(b.name.toLowerCase(), q) ||
          a.name.localeCompare(b.name);
      });
    if (skills.length) {
      rows.push({ group: "Skills" });
      for (var i = 0; i < skills.length; i++) {
        rows.push({
          skill: skills[i].name,
          desc: skills[i].description || "",
          src: skills[i].source
        });
      }
    }
    var cmds = CMDS
      .filter(function (c) { return slashRank(c[0].slice(1), q) >= 0; })
      .sort(function (a, b) {
        return slashRank(a[0].slice(1), q) - slashRank(b[0].slice(1), q) ||
          a[0].localeCompare(b[0]);
      });
    if (cmds.length) {
      rows.push({ group: "Commands" });
      for (var j = 0; j < cmds.length; j++) {
        rows.push({ cmd: cmds[j][0], desc: cmds[j][1] });
      }
    }
    return rows;
  }

  /**
   * What `@` is looking at, said out loud.
   *
   * `@` searches the whole workspace from its root, always - there is no
   * "current directory" to be in, because the composer is not a shell. But
   * nothing said so, and the question "where is this pointing?" has no answer
   * anywhere on screen: the rows show paths relative to a root that is never
   * named, which reads as relative to something the user has to guess.
   *
   * It is shown on the EMPTY states too. That is the moment the question
   * actually gets asked - a search that found nothing is when you want to know
   * where it looked.
   */
  function scopeLine() {
    var open = S.workspace && S.workspace.open;
    var name = (S.workspace && S.workspace.name) || "";
    if (!open) {
      return '<div class="qp-scope" data-none="1">' + icon("i-folder", "ic-11") +
        "<span>No folder open - nothing to attach</span></div>";
    }
    return '<div class="qp-scope">' + icon("i-folder", "ic-11") +
      '<span class="qp-scope-t ell">' + esc(name) + "/</span>" +
      '<span class="sp"></span>' +
      '<span class="qp-scope-n">whole workspace</span></div>';
  }

  function renderQuickPick() {
    var qp = $("qp");
    var items = qpItems();
    var selectable = items.filter(function (r) { return !r.group; });
    if (!items.length) {
      if (S.qp && S.qp.kind === "file") {
        qp.innerHTML = scopeLine() + (S.searching
          ? '<div class="qp-empty" data-busy="1">Searching the workspace…</div>'
          : '<div class="qp-empty">No matching files</div>');
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
      if (r.group) {
        // In the model listbox the header IS the classification, so it carries
        // the kind's hue. Everywhere else a group header is just a divider.
        html += r.groupKind
          ? '<div class="qp-group" data-kind="' + esc(r.groupKind) + '" style="color:' + r.groupHue + '">' +
            esc(r.group) + "</div>"
          : '<div class="qp-group">' + esc(r.group) + "</div>";
        continue;
      }
      idx++;
      var on = idx === S.qpIndex ? "1" : "0";
      if (r.skill) {
        html += '<button class="qp-row" role="option" data-active="' + on + '" data-i="' + idx + '">' +
          icon("i-book", "ic-13") + '<span class="n">/' + esc(r.skill) + "</span>" +
          '<span class="d ell" title="' + esc(r.desc) + '">' + esc(r.desc) + "</span>" +
          '<span class="qp-src">' + esc(r.src) + "</span></button>";
      } else if (r.cmd) {
        html += '<button class="qp-row" role="option" data-active="' + on + '" data-i="' + idx + '">' +
          icon("i-term", "ic-13") + '<span class="n">' + esc(r.cmd) + "</span>" +
          '<span class="d ell">' + esc(r.desc) + "</span></button>";
      } else if (r.file) {
        var isDir = r.badge === "folder";
        html += '<button class="qp-row" role="option" data-active="' + on + '" data-i="' + idx + '">' +
          icon(isDir ? "i-folder" : "i-file", "ic-13") +
          '<span class="n ell">@' + esc(r.file) + (isDir ? "/" : "") + "</span>" +
          '<span class="d">' + esc(r.badge) + "</span></button>";
      } else if (r.agent !== undefined) {
        // The scope is on the row because the scope is what is being chosen
        // between: two agents with the same persona and different tool lists
        // are different agents, and a picker showing only names hides that.
        html += '<button class="qp-row" role="option" data-active="' + on + '" data-i="' + idx + '">' +
          '<span class="qp-check">' + (r.active ? icon("i-check", "ic-13") : "") + "</span>" +
          '<span class="n ell">' + esc(r.agent || "None") + "</span>" +
          '<span class="d ell" title="' + esc(r.scope || r.desc) + '">' + esc(r.desc) + "</span></button>";
      } else if (r.auto) {
        // Same row shape as a real model, because it sits in the same list and
        // is chosen the same way. Its kind slot stays empty rather than saying
        // "AUTO": which kind it resolves to depends on which endpoint is
        // healthy at the time, and claiming one would be a guess.
        html += '<button class="qp-row mdl" role="option" data-active="' + on + '"' +
          ' data-on="' + (r.active ? "1" : "0") + '" aria-selected="' + (r.active ? "true" : "false") + '"' +
          ' data-i="' + idx + '">' +
          '<span class="mdl-dot"></span>' +
          '<span class="mdl-col">' +
            '<span class="mdl-id ell">' + esc(r.model) + "</span>" +
            '<span class="mdl-note">' + esc(r.desc) + "</span>" +
          "</span></button>";
      } else {
        /* The model row is the one picker row that carries three facts rather
           than one: which endpoint, what sort of model it is, and what that
           means. It follows the Genesis model listbox exactly - a 5px selection
           dot, a stacked id-over-note column, and a right-hand mono tag - which
           is why it is its own row shape instead of the single-line default the
           file, skill and command rows use. */
        var k = llmKind(r.kind);
        // `data-active` is the KEYBOARD cursor and `data-on` is the endpoint
        // actually in force. They are different rows most of the time, and the
        // design distinguishes them: the cursor moves the row background, the
        // selection lights the dot and brightens the id.
        //
        // The kind is on the header above, so the row spends its three slots
        // on what distinguishes models WITHIN a kind: the id, which endpoint
        // serves it, and how much context it has. That is the mockup's row
        // exactly - id over a note, with a mono figure on the right.
        var ctx = ctxLabel(r.endpoint);
        html += '<button class="qp-row mdl" role="option" data-active="' + on + '"' +
          ' data-on="' + (r.active ? "1" : "0") + '" aria-selected="' + (r.active ? "true" : "false") + '"' +
          ' data-i="' + idx + '"' +
          ' title="' + esc(r.model + " - " + k.label + ". " + k.note + ". Served by " + r.endpoint + ".") + '">' +
          '<span class="mdl-dot"></span>' +
          '<span class="mdl-col">' +
            '<span class="mdl-id ell">' + esc(r.model) + "</span>" +
            '<span class="mdl-note ell">' + esc(r.endpoint) + "</span>" +
          "</span>" +
          (ctx ? '<span class="mdl-ctx">' + esc(ctx) + "</span>" : "") +
          "</button>";
      }
    }
    // The scope header rides above the rows for the file picker only: the
    // slash list has no scope to state, it is the extension's own commands.
    qp.innerHTML = (S.qp && S.qp.kind === "file" ? scopeLine() : "") + html;
    // Which picker this is. The model listbox is drawn as a list of things to
    // compare rather than a fuzzy-find dropdown, and the CSS keys off this
    // rather than guessing from the rows it happens to contain.
    qp.setAttribute("data-mode", S.modelOpen ? "model" : S.agentOpen ? "agent" : "find");
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

    if (r.skill) {
      // Leaves the turn in the composer rather than sending it: a skill is a
      // preamble to a request ("/canvas-design a launch poster"), not a
      // request on its own.
      draft.value = "/" + r.skill + " ";
    } else if (r.cmd) {
      runSlash(r.cmd, draft);
    } else if (r.file) {
      // A folder keeps its trailing slash so the model can tell "this
      // directory" from "a file with no extension".
      var pathText = r.file + (r.badge === "folder" ? "/" : "");
      // A path containing whitespace is quoted. The host reads a bare mention
      // up to the first space, so `@src/my notes.md` reached it as `src/my` -
      // a path that does not exist - and the file was dropped without a word.
      // The picker had found it, offered it and inserted it, so every visible
      // sign said it had worked.
      //
      // The directory slash goes INSIDE the quotes. Outside it would sit after
      // the closing quote, where the host's quoted branch never sees it.
      var ref = /\s/.test(pathText) ? '"' + pathText + '"' : pathText;
      // Same class as the detector above, for the same reason: a narrower one
      // here would leave the tail of a non-ASCII path behind the inserted one.
      draft.value = draft.value.replace(/@(\S*)$/, "@" + ref + " ");
    } else if (r.agent !== undefined) {
      post("setAgent", { name: r.agent });
      S.agentOpen = false;
    } else if (r.auto) {
      // An empty activeProfile is what "auto" already meant to the host; the
      // picker just had no way to say it.
      post("selectModel", { endpoint: "", model: "" });
      S.modelOpen = false;
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
    // The editor-side ones first. They resolve their own target from the
    // active editor, so there is nothing to put in the composer and nothing
    // to send.
    if (EDITOR_CMDS[cmd]) {
      draft.value = "";
      post("editorCommand", { command: EDITOR_CMDS[cmd] });
      return;
    }
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
      case "/export":
        draft.value = ""; post("exportChat", { scope: "current" }); break;
      case "/agent":
        draft.value = ""; S.agentOpen = true; S.modelOpen = false; S.qpIndex = 0; renderQuickPick(); return;
      case "/review":
        draft.value = ""; sendText(REVIEW_PROMPT); break;
      case "/skills":
        draft.value = ""; setTab("diagnostics"); openSection("secSk"); renderSkills(); break;
      case "/help": {
        draft.value = "";
        var skills = S.skills.filter(function (s) { return s.enabled; });
        var text = "Skills - type / to insert one\n\n" +
          (skills.length
            ? skills.map(function (s) { return "/" + s.name + "  -  " + (s.description || ""); }).join("\n")
            : "No skills enabled. Add a SKILL.md under .agent/skills/.") +
          "\n\nCommands\n\n" +
          CMDS.map(function (c) { return c[0] + "  -  " + c[1]; }).join("\n");
        aiEl = null;
        add(div("note-box", esc(text)));
        break;
      }
      default:
        draft.value = cmd + " ";
    }
  }

  function sendText(text) {
    var trimmed = String(text).trim();
    if (!trimmed) return;
    if (!S.workspace.open) {
      addError({
        message: "Open a folder first.",
        fix: "Genesis reads endpoint profiles and skills from the folder you have open, " +
          "and confines every write to it.",
      });
      return;
    }
    if (!hasEndpoint()) {
      addError({
        message: "Select an endpoint profile first.",
        fix: "Create one in .agent/endpoints/, or pick an existing profile.",
        action: "endpoints",
      });
      return;
    }
    if (S.running) {
      // Mid-turn: hand it to the host and stop there. None of the turn setup
      // below applies - no second aura, no second running flag, and the
      // message is not painted yet because it has not been accepted. The host
      // answers with inputAccepted, and with steerAccepted once the model has
      // actually been given it.
      var mid = { text: trimmed };
      if (S.attachments && S.attachments.length) {
        mid.attachments = S.attachments.map(function (a) {
          return { name: a.name, mediaType: a.mediaType, data: a.data };
        });
      }
      post("sendMessage", mid);
      S.attachments = [];
      renderAttachments();
      return;
    }
    addUser(trimmed, S.attachments);
    aiEl = null;
    // One verb per turn, held for its whole length.
    S.idleVerb = pickVerb(S.phase);
    S.gerund = S.idleVerb;
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

  /**
   * A failure, said in a way somebody can act on.
   *
   * This was one <span>. The host joined the message and the raw response body
   * with a newline before it ever got here, so a 502 from a re-signing proxy
   * printed a bare status code followed by up to two thousand characters of
   * somebody's HTML error page, uncapped, in a 340px column - and offered
   * nothing to do about it.
   *
   * Four parts now, and three of them are optional so a plain message stays a
   * plain message:
   *
   *   message  the cause, in a sentence. Always.
   *   fix      the action, in a sentence. Printed under it, quieter.
   *   detail   the evidence - a response body, a stack. COLLAPSED, because it
   *            is what you read second and only sometimes, and bounded by CSS
   *            because a gateway decides its length and we do not.
   *   action   one button to the surface that can answer "why", which for a
   *            turn failure is always the ladder. Reaching it used to require
   *            knowing the tab existed.
   */
  function addError(m) {
    // Tolerates the old shape. Several callers still send a bare string, and a
    // failure is the worst possible moment to throw on the failure renderer.
    var e = typeof m === "string" ? { message: m } : (m || {});
    var message = e.message || "Something went wrong.";
    aiEl = null;
    closeToolGroup();
    announce(message);

    var html = icon("i-warn", "ic-13") +
      '<span class="err-col"><span class="err-msg">' + esc(message) + "</span>" +
      (e.fix ? '<span class="err-fix">' + esc(e.fix) + "</span>" : "");

    if (e.detail) {
      html += '<button class="err-more" data-err-raw aria-expanded="false">' +
        icon("i-chev", "ic-9 chev") + "<span>Show the response</span></button>" +
        '<pre class="err-raw" hidden></pre>';
    }
    if (e.action) {
      html += '<span class="err-acts">' +
        (e.action === "endpoints"
          ? '<button class="btn sm" data-act="ccEndpoints">Open Control Center</button>' +
            '<button class="btn sm go" data-act="newEndpoint">Create endpoint profile</button>'
          : '<button class="btn sm go" data-act="doctor">Run diagnostics</button>') +
        "</span>";
    }
    html += "</span>";

    var box = div("err-box", html);
    // textContent, not innerHTML: the body is a gateway's, and a gateway that
    // is misbehaving is exactly the one whose output should not be markup.
    if (e.detail) box.querySelector(".err-raw").textContent = e.detail;
    box.addEventListener("click", function (ev) {
      var t = ev.target.closest("[data-err-raw]");
      if (!t) return;
      var pre = box.querySelector(".err-raw");
      var open = !pre.hidden;
      pre.hidden = open;
      t.setAttribute("aria-expanded", open ? "false" : "true");
      t.querySelector("span").textContent = open ? "Show the response" : "Hide the response";
    });
    add(box);
    return box;
  }

  /**
   * A confirmation the conversation itself should carry.
   *
   * VS Code's own notification toast disappears after a few seconds and takes
   * the path with it, which for an export is the one thing the user needs
   * afterwards. This stays in the transcript, and its path opens the file.
   */
  function addNotice(iconId, text, openPath) {
    aiEl = null;
    closeToolGroup();
    var box = div("ok-box", icon(iconId, "ic-13") + "<span>" + esc(text) + "</span>");
    if (openPath) {
      var open = document.createElement("button");
      open.className = "btn sm";
      open.textContent = "Open";
      open.addEventListener("click", function () { post("openFile", { path: openPath }); });
      box.appendChild(open);
    }
    add(box);
  }

  /**
   * A generated image, shown where it was produced.
   *
   * The host resolves `src` into a webview URI because only it can; without one
   * the card still renders with the path and the prompt, which is the useful
   * half - the file is on disk either way, and a broken <img> would suggest the
   * generation had failed when it had not.
   */
  function addImage(m) {
    aiEl = null;
    closeToolGroup();
    var card = div("gen-img");
    // A button, not an anchor: the click opens an editor tab through the host,
    // it never navigates. An <a href> that is always preventDefault-ed claims
    // otherwise, and makes the webview attempt a navigation it cannot perform.
    var body = m.src
      ? '<button type="button" class="gi-frame" title="Open ' + esc(m.path) + '">' +
          '<img src="' + esc(m.src) + '" alt="' + esc(m.prompt) + '" loading="lazy">' +
        "</button>"
      : '<div class="gi-frame gi-missing">' + icon("i-file", "ic-14") + "<span>saved to disk</span></div>";
    card.innerHTML =
      body +
      '<div class="gi-meta">' +
        '<span class="gi-path mono ell" title="' + esc(m.path) + '">' + esc(m.path) + "</span>" +
        '<button class="mini" data-img="open" data-path="' + esc(m.path) +
          '" title="Open in the editor" aria-label="Open in the editor">' +
          icon("i-file", "ic-13") + "</button>" +
      "</div>" +
      '<div class="gi-prompt">' + esc(m.prompt) + "</div>";
    // The <a> is inert in a webview, so opening goes through the host, which is
    // also the only side that can put the file in an editor tab.
    card.addEventListener("click", function (e) {
      if (!e.target.closest("[data-img], .gi-frame")) return;
      e.preventDefault();
      post("openFile", { path: m.path });
    });
    add(card);
    if (atBottom()) scroll();
  }


  /**
   * The conversation-title strip.
   *
   * Hidden while the name is still a placeholder: "Untitled 3" above every
   * transcript is chrome that tells you nothing. Once the model has named the
   * conversation the strip appears with something worth reading.
   */
  /**
   * The conversation's name, in the strip under the tabs.
   *
   * Not in the header: the header holds the wordmark, which is static. This sits
   * where the transcript begins, which is what it labels.
   *
   * It is derived from the first thing the user said, so it appears immediately
   * and never changes underneath them. Several conversations called "Hi" is the
   * accepted cost of that - a name that arrives late and rewrites itself is
   * worse than a dull one that was right from the first frame.
   */
  function renderTitle() {
    var el = $("convoTitle");
    if (!el) return;
    var t = String(S.title || "").trim();
    if (!t || /^Untitled( \d+)?$/.test(t)) {
      el.hidden = true;
      el.textContent = "";
      return;
    }
    el.textContent = t;
    el.title = t;
    el.hidden = false;
  }

  /* ───────────────────────── footer ───────────────────────── */

  /* The footer says which endpoint is answering, and nothing else.

     The context readout is gone in both places it ever lived. It came out
     from under the composer first, where it changed on every frame directly
     beneath the thing being typed, and then out of the header, where it was a
     small blue meter that moved constantly and told you nothing you could act
     on until it was nearly full. The usage is still tracked and still printed
     on each turn's footer line, which is where a figure belongs: attached to
     the turn that spent it, once, and not moving afterwards. */
  /* The label the button WANTS to show, before it is cut to fit. Kept apart
     from the DOM text because the fitter reads the element's own width to
     decide the cut, and measuring a string against a box already containing a
     truncated copy of itself converges on the wrong answer. */
  var modelLabel = "No model";

  /**
   * Show the END of the model id when the whole of it will not fit.
   *
   * `text-overflow: ellipsis` cuts the tail, which is the wrong half here.
   * Model ids share their prefixes - `claude-sonnet-4-6`, `claude-opus-4-1`,
   * `openai/gpt-oss-20b` - so the row's narrowest case, about seven characters
   * at a 360px panel, spends all seven on "claude-" and distinguishes nothing.
   * Truncating before the first distinguishing character is the same as
   * showing no name at all.
   *
   * Binary search rather than a character-width estimate: the face is
   * proportional at some weights and the id carries digits, slashes and
   * hyphens whose advances differ, so anything averaged is wrong by a
   * character or two exactly when the budget is a character or two.
   */
  function fitModelName() {
    var el = $("modelName");
    if (!el) return;
    el.textContent = modelLabel;
    var room = el.clientWidth;
    // Zero while the panel is hidden or not yet laid out. Leave the full text:
    // a fit computed against no width would cut everything, and renderFooter
    // runs again on the next state sync.
    if (room <= 0 || el.scrollWidth <= room) return;

    // Measured in a detached span carrying the element's own computed font, so
    // the answer holds whatever the type system is doing today.
    var probe = document.createElement("span");
    probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre;left:-9999px;font:" +
      getComputedStyle(el).font;
    document.body.appendChild(probe);
    var fits = function (n) {
      probe.textContent = "\u2026" + modelLabel.slice(modelLabel.length - n);
      return probe.getBoundingClientRect().width <= room;
    };
    var lo = 0, hi = modelLabel.length;
    while (lo < hi) {
      var mid = Math.ceil((lo + hi) / 2);
      if (fits(mid)) lo = mid; else hi = mid - 1;
    }
    probe.remove();
    // Nothing fits, not even one character behind the ellipsis. Leave the full
    // label and let the CSS clip it: a bare ellipsis names nothing at all.
    el.textContent = lo > 0 ? "\u2026" + modelLabel.slice(modelLabel.length - lo) : modelLabel;
  }

  function renderFooter() {
    var active = activeProfile();
    // Named here and not inline: it is the model button's tooltip that needs
    // it, and without the declaration `name` silently resolves to
    // `window.name` - an empty string, and a tooltip that lost its endpoint.
    var name = active ? active.id : "No endpoint";
    /* THE DOT READS THE STATUS, NOT ONLY THE TLS ERROR.
     *
     * It was `S.tlsError ? 1 : 0`, so a gateway answering 502 - no TLS problem
     * anywhere - left the health dot green while every turn failed. The host
     * has always broadcast a real StatusDto with an `error` state; the webview
     * dropped `statusChanged` on the floor (the case was an empty `break`).
     *
     * And it is NAMED. Five pixels of hue is not a state: a red/green
     * colour-blind reader cannot tell the two apart, and the dot sits inside a
     * button whose accessible name is the model, so a screen reader was never
     * told the endpoint's health at all. */
    var bad = !!S.tlsError || (S.status && S.status.state === "error");
    var dot = $("epDot");
    dot.setAttribute("data-err", bad ? "1" : "0");
    var health = bad
      ? (S.tlsError ? "Endpoint failing - TLS error" : "Endpoint failing")
      : active ? "Endpoint healthy" : "No endpoint";
    dot.setAttribute("aria-label", health);
    dot.title = health;
    // "Auto" when no profile is pinned and there is more than one to
    // choose from: the label has to say the choice is being made for you.
    var pinnedTo = (S.config && S.config.activeProfile) || "";
    modelLabel = active
      ? (pinnedTo === "" && S.models.length > 1 ? "Auto · " + active.model : active.model)
      : "No model";
    fitModelName();
    // THE MODEL FIRST, THEN THE ENDPOINT.
    //
    // This named only the endpoint. That was defensible while the button was
    // wide enough to print the model id in full - the tooltip added the one
    // fact the label was missing. The button now gives its width back to keep
    // the composer on one row, so the label is the part that ellipsises and
    // the tooltip is the only place the whole id can be read. A tooltip that
    // answers a question the label already answered, while withholding the one
    // it does not, is worse than no tooltip.
    $("modelBtn").title =
      (active ? active.model + " · " + name : name) +
      (S.tlsError ? " - TLS error" : "");
    // The button's own name carries the health too, because the dot inside it
    // is decoration to anything that reads names rather than pixels.
    $("modelBtn").setAttribute("aria-label",
      "Model: " + (active ? active.model + " on " + name : "none") + " - " + health);
  }

  /* ─────────────────────── diagnostics: TLS ─────────────────────── */

  function renderTls() {
    var e = S.tlsError;
    var badge = $("tlsBadge");
    badge.textContent = e ? "1" : S.traceRun ? "OK" : "-";
    badge.className = e ? "badge alert" : "badge";

    // #5 - a count, not a dot and not a status word. The number is what is
    // actionable: how many rungs are failing right now.
    var failing = 0;
    for (var i = 0; i < S.rungs.length; i++) if (S.rungs[i].status === "fail") failing++;
    if (!failing && e) failing = 1;
    setTabCount("tabDiag", "tabCount", "Diagnostics", failing, "checks failing");

    var html = "";
    if (!e) {
      if (!S.traceRun && !S.rungs.length) {
        html += '<div class="ok-state"><p>No trace yet - run diagnostics to check the connection.</p>' +
          '<div><button class="btn sm go" data-tls="trace">Run trace</button></div></div>';
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
            '<span class="k">Cert subject</span><span class="v ell">' + esc(e.certSubject || "-") + "</span>" +
            '<span class="k">Cert issuer</span><span class="v ell">' + esc(e.certIssuer || "-") + "</span>" +
            '<span class="k">TLS version</span><span class="v">' + esc(e.tlsVersion || "-") + "</span>") +
        "</div>" +
        (e.proxied
          ? '<div class="proxied-note">Certificate details unavailable - the failing certificate was presented inside the CONNECT tunnel.</div>'
          : "") +
        "</div>";

      html += '<div class="fixk"><div class="l">Exact fix - set this configuration key:</div>' +
        '<div class="row"><code>"' + esc(e.fixKey) + '": "' + esc(e.fixValue) + '"</code>' +
        '<button class="mini" data-tls="copy" title="Copy" aria-label="Copy fix key">' + icon("i-copy", "ic-13") + "</button></div>" +
        (S.copied ? '<div class="copied">Copied to clipboard</div>' : "") + "</div>";

      if (S.caUpload) {
        html += '<div class="upload"><label for="caPath">CA bundle file (.pem, .crt, .cer)</label>' +
          '<div class="split"><input id="caPath" readonly placeholder="No file selected…" value="' + esc(S.caUpload.path) + '">' +
          '<button class="btn" data-tls="browse">Browse…</button></div>' +
          '<div class="hint2">The selected path will be written to <code>genesis.caBundlePath</code> ' +
            'in your <b>user</b> settings. It is a path on this machine, so it deliberately does ' +
            'not go into the repository&rsquo;s workspace settings, where it would resolve to ' +
            'nothing for everyone else who clones it.</div>' +
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
      '<button class="btn sm wait" data-tls="trace"' + (S.tracing ? " disabled" : "") + ">" +
      (S.tracing ? spinner(13) : icon("i-refresh", "ic-13")) +
      "<span>" + (S.tracing ? "Running…" : "Re-run trace") + "</span></button></div>";

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

  /* What each rung state looks like and what it is called.
   *
   * PASS AND FAIL USED TO DIFFER ONLY IN HUE. Both were an 8px filled circle
   * in the same place at the same size - --kx-accent against --kx-error - and
   * the markup carried no status word at all. So the one surface whose entire
   * job is saying what is broken said nothing to a deuteranope (red text on a
   * dark panel reads as a muddy grey barely distinct from --kx-fg-2) and
   * nothing at all to a screen reader.
   *
   * The MCP tab had already solved this: mcpPill pairs every state with a word
   * AND a glyph, and 9px check and cross glyphs read fine there. This is the
   * same treatment, so the two lists of health now speak one language.
   *
   * The word is hidden from sight rather than printed: the rung's name column
   * is 56px in a 340px panel and there is nowhere to put it, and the glyph is
   * the sighted carrier. */
  var RUNG_STATE = {
    pass:    ["i-check", "passed"],
    fail:    ["i-x", "failed"],
    warn:    ["i-warn", "warning"],
    skipped: ["i-minus", "skipped"],
    pending: ["", "running"]
  };

  function rungRow(name, status, detail, fix, ms) {
    var st = RUNG_STATE[status] || RUNG_STATE.pending;
    return '<div class="rung" data-s="' + esc(status) + '">' +
      '<span class="rail">' +
        (st[0] ? icon(st[0], "ic-11 node-ic") : '<span class="node"></span>') +
      "</span>" +
      '<span class="rung-state vh">' + st[1] + "</span>" +
      '<span class="nm">' + esc(RUNG_LABELS[name] || name || "") + "</span>" +
      '<span class="body"><span class="dt">' + esc(detail) + "</span>" +
      (fix ? '<div class="fx">' + esc(fix) + "</div>" : "") + "</span>" +
      /* A rung still running has no time to report yet, and a bare "-" there
         is indistinguishable from one that finished without a measurement.
         The spinner says which of the two this is. */
      '<span class="ms">' + (status === "pending" ? spinner(12)
        : status === "pass" || status === "fail" || status === "warn"
        ? (ms ? ms + "ms" : "-") : "-") + "</span></div>";
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
          : '<span style="color:var(--kx-fg-3)">' + icon(iconId, "ic-14") + "</span>") +
        '<span class="ell"><span class="id ell">' + esc(p.id) + "</span>" +
        '<span class="url ell" title="' + esc(p.status === "error" ? p.error || "" : p.baseUrl) + '">' +
        esc(p.status === "error" ? (p.error || "Failed to parse") : p.baseUrl) + "</span></span>" +
        // The kind, on the row that manages endpoints as well as on the one
        // that picks between them. It is a required field now; having to open
        // the edit form to find out what an endpoint is would undo the point
        // of asking. Suppressed for a profile that failed to parse, which has
        // no honest kind to report.
        (p.status === "error" ? "" :
          '<span class="ep-kind" style="color:' + llmKind(p.kind).hue + '"' +
          ' title="' + esc(llmKind(p.kind).label + " - " + llmKind(p.kind).note) + '">' +
          esc(llmKind(p.kind).label) + "</span>") +
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
      // A disabled placeholder rather than a pre-selected kind, so an
      // unanswered field looks unanswered instead of looking like "chat".
      var kindOpts = '<option value=""' + (f.kind ? "" : " selected") + " disabled>Choose one…</option>";
      for (var kq = 0; kq < LLM_KINDS.length; kq++) {
        kindOpts += '<option value="' + LLM_KINDS[kq].id + '"' +
          (f.kind === LLM_KINDS[kq].id ? " selected" : "") + ">" + esc(LLM_KINDS[kq].label) + "</option>";
      }
      var needsKey = f.type !== "local";
      html += '<div class="form"><div class="t">' + (f.isNew ? "Add endpoint" : "Edit endpoint") + "</div>" +
        '<div class="fgrid">' +
          '<label for="fId">ID</label><input id="fId" value="' + esc(f.id) + '" placeholder="openrouter">' +
          '<label for="fName">Display Name</label><input id="fName" value="' + esc(f.name) + '" placeholder="OpenRouter">' +
          '<label for="fUrl">Base URL</label><input id="fUrl" value="' + esc(f.url) + '" placeholder="https://openrouter.ai/api/v1">' +
          '<label for="fType">Provider Type</label><select id="fType">' + opts + "</select>" +
          // The credential comes before the model, because it is what makes the
          // model field usable: Load asks the gateway, and no gateway answers
          // without a key. The old order put the Load button above the field
          // that arms it, so the first thing a new endpoint did was fail.
          (needsKey
            ? '<label for="fKey">API Key</label>' +
              '<span class="f-with-btn">' +
                '<input id="fKey" type="password" autocomplete="off" spellcheck="false" value="" placeholder="' +
                (f.hasStoredKey ? "stored - leave blank to keep" : "paste the token") + '">' +
              "</span>" +
              '<span></span><span class="f-hint">' +
                (f.hasStoredKey
                  ? "A key is already stored. Leave blank to keep it."
                  : "Held in VS Code SecretStorage, never written to the YAML.") +
              "</span>"
            : "") +
          // A typed model id is the most expensive mistake this form allows: a
          // wrong one either 404s with a message about the route, or is listed
          // by the gateway and still not servable, in which case the request
          // hangs. The list comes from the gateway itself. It stays an input,
          // not a select, because plenty of gateways serve no /models route.
          '<label for="fModel">Model</label>' +
          '<span class="f-with-btn">' +
            '<input id="fModel" list="fModelList" value="' + esc(f.model || "") + '" placeholder="openrouter/free">' +
            '<datalist id="fModelList"></datalist>' +
            '<button type="button" class="btn sm" data-ep="models" title="Ask the gateway which models it serves">Load</button>' +
          "</span>" +
          '<span></span><span class="f-hint" id="fModelHint"></span>' +
          // Directly under the model id, because it is a statement ABOUT that
          // id. Mandatory and unset by default: it is the one thing a gateway
          // cannot be probed for, and it silently decides whether vision is on
          // and whether tools are offered at all.
          '<label for="fKind">Model Type <span class="req" title="Required">*</span></label>' +
          '<select id="fKind" data-empty="' + (f.kind ? "0" : "1") + '" aria-required="true">' + kindOpts + "</select>" +
          '<span></span><span class="f-hint" id="fKindHint"' + (f.kind ? "" : ' data-err="1"') + ">" +
            esc(f.kind
              ? llmKind(f.kind).note + ". " + kindImplies(f.kind)
              : "Required. The gateway cannot be asked what sort of model it serves.") +
          "</span>" +
          '<label for="fPath">Route</label><input id="fPath" value="' + esc(f.chatPath || "") + '" placeholder="auto - derived from Base URL">' +
          '<label for="fTimeout">Timeout</label>' +
          '<div class="fsplit">' +
            '<input id="fTimeout" type="number" min="1" max="600" step="1" value="' +
              esc(f.timeoutMs ? Math.round(f.timeoutMs / 1000) : "") + '" placeholder="30"><span class="unit">seconds</span>' +
          "</div>" +
          '<label for="fHttp2">HTTP/2</label>' +
          '<div class="fsplit">' +
            '<input id="fHttp2" type="checkbox"' + (f.http2 ? " checked" : "") + '>' +
            '<span class="unit">last resort - slows streaming badly</span>' +
          "</div>" +
        "</div>" +
        (needsKey
          ? '<div class="hint2">The key is stored in VS Code SecretStorage. The YAML only holds a <code>${secret:…}</code> reference, so the profile is safe to commit.</div>'
          : "") +
        renderEpCheck() +
        '<div class="row"><button class="btn" data-ep="cancel">Cancel</button>' +
        '<button class="btn wait" data-ep="check"' + (S.epCheck && S.epCheck.running ? " disabled" : "") + ">" +
        (S.epCheck && S.epCheck.running ? spinner(13) + "<span>Checking…</span>" : "<span>Check connection</span>") +
        "</button>" +
        '<button class="btn primary" data-ep="save">Save</button></div></div>';
    }
    $("epBody").innerHTML = html;
    // Re-rendering replaces the whole subtree, and check rungs re-render on
    // every arriving rung. The typed key is restored as a property rather than
    // an attribute so it never appears in the markup string above.
    if (S.epForm && S.epForm.apiKey && $("fKey")) $("fKey").value = S.epForm.apiKey;
  }

  /**
   * Snapshot the form inputs into the store.
   *
   * Must run before anything that re-renders the panel, otherwise a check
   * result arriving mid-edit wipes what the user has typed.
   */
  function readEpForm() {
    if (!S.epForm || !$("fId")) return S.epForm;
    var key = $("fKey") ? $("fKey").value : "";
    S.epForm.id = $("fId").value.trim();
    S.epForm.name = $("fName").value.trim();
    S.epForm.url = $("fUrl").value.trim();
    S.epForm.type = $("fType").value;
    S.epForm.kind = $("fKind") ? $("fKind").value : "";
    S.epForm.model = $("fModel") ? $("fModel").value.trim() : "";
    S.epForm.chatPath = $("fPath") ? $("fPath").value.trim() : "";
    // Entered in seconds because nobody thinks in milliseconds; stored in ms
    // because that is what the profile and undici take.
    var secs = $("fTimeout") ? parseFloat($("fTimeout").value) : NaN;
    S.epForm.timeoutMs = isFinite(secs) && secs > 0 ? Math.round(secs * 1000) : 0;
    S.epForm.http2 = $("fHttp2") ? $("fHttp2").checked : false;
    if (key) S.epForm.apiKey = key;
    return S.epForm;
  }

  /**
   * The connection-check panel inside the endpoint form.
   *
   * Rungs stream in one at a time, so this renders whatever has arrived and
   * appends a pending row while the walk is still going - the same shape the
   * TLS trace uses, because it is literally the same ladder underneath.
   */
  function renderEpCheck() {
    var c = S.epCheck;
    if (!c) return "";
    var out = '<div class="ep-check" data-ok="' + (c.done ? (c.ok ? "1" : "0") : "") + '">';
    if (c.done) {
      out += '<div class="ep-check-banner" data-ok="' + (c.ok ? "1" : "0") + '">' +
        icon(c.ok ? "i-check" : "i-warn", "ic-13") +
        "<span>" + esc(c.summary) + "</span></div>";
    }
    for (var i = 0; i < c.rungs.length; i++) {
      var r = c.rungs[i];
      out += rungRow(r.name, r.status, r.detail, r.fix, r.ms);
    }
    if (c.running) out += rungRow("", "pending", "Checking…", undefined, null);
    return out + "</div>";
  }

  /* ─────────────────────────── MCP ───────────────────────────
   *
   * One row per configured server: a 3px status rail, the name with a pill, the
   * transport line, and the tool count. Ready servers list their tools as chips
   * (capped, with a "+N more" tail - a 14-tool server would otherwise push the
   * next row off the panel); a failed one gets a card with the reason and the
   * two actions that can do something about it.
   *
   * One status signal per row, as the review asked: the rail and the pill agree
   * because they read the same field, and there is no third indicator to drift.
   */
  var MCP_CHIP_CAP = 5;

  /**
   * The waiting mark: three arcs from the palette, each on its own period.
   *
   * A single rotating ring reads as a stalled GIF; three arcs at 1.1s, 1.7s
   * and 2.6s never repeat the same figure, so the eye keeps reading it as
   * work in progress. Colours are the wall, the shadow and the frame, so it
   * belongs to this app rather than to the operating system.
   */
  function spinner(size) {
    var s = size || 13;
    return '<svg class="kx-spin" width="' + s + '" height="' + s + '" viewBox="0 0 24 24" ' +
      'fill="none" aria-hidden="true">' +
      '<circle class="a1" cx="12" cy="12" r="10" stroke="var(--kx-accent)" stroke-width="2.5" ' +
        'stroke-linecap="round" stroke-dasharray="16 47"/>' +
      '<circle class="a2" cx="12" cy="12" r="6.5" stroke="var(--kx-agent)" stroke-width="2.5" ' +
        'stroke-linecap="round" stroke-dasharray="10 31"/>' +
      '<circle class="a3" cx="12" cy="12" r="3" stroke="var(--kx-active)" stroke-width="2.5" ' +
        'stroke-linecap="round" stroke-dasharray="5 14"/>' +
      "</svg>";
  }

  /**
   * Does this MCP tool change anything, or only read?
   *
   * McpServerDto carries tool NAMES and nothing else - the protocol has no
   * write flag - so this is a heuristic over the leading verb, not a fact the
   * server told us. It is conservative in the direction that keeps the amber
   * meaningful: an unrecognised verb is treated as read-only rather than
   * warned about, because crying wolf on every tool would make the warning
   * worthless. The verdict is always stated in the chip's title, so the guess
   * is visible rather than silently trusted.
   *
   * Kept self-contained and at this level on purpose: test/mcp-render.cjs
   * lifts whole functions out of this file by brace matching, so a nested
   * helper's closing brace would truncate whatever function encloses it.
   */
  function mcpToolWrites(name) {
    return /^(write|create|delete|remove|update|patch|put|post|set|move|rename|append|edit|upload|publish|send|insert|drop|exec|execute|run|apply|commit|push|merge|revoke|grant|install|restart|kill)(_|$)/i
      .test(String(name || ""));
  }

  function mcpPill(state) {
    if (state === "ready") return '<span class="mcp-pill ok">' + icon("i-check", "ic-9") + "connected</span>";
    if (state === "starting") return '<span class="mcp-pill">starting…</span>';
    // `idle` and `stopped` are both "declared, reachable, nothing asked of it".
    // They fell through to the red `unavailable` pill, which said a healthy
    // server had failed - the loudest thing the tab can say, about the one
    // state that means nothing is wrong. The mockup paints this orange and
    // calls it Idle; both words are kept because main's protocol distinguishes
    // "never started" from "was running, now stopped".
    if (state === "idle") return '<span class="mcp-pill idle">idle</span>';
    if (state === "stopped") return '<span class="mcp-pill idle">stopped</span>';
    // Declared with enabled:false. Not an error - it was never started on
    // purpose - so it must not wear the red "unavailable" pill.
    if (state === "disabled") return '<span class="mcp-pill">disabled</span>';
    return '<span class="mcp-pill err">' + icon("i-x", "ic-9") + "unavailable</span>";
  }

  function renderMcp() {
    var body = $("mcpBody");
    if (!body) return;
    var m = S.mcp || { servers: [], warnings: [] };
    var servers = m.servers || [];

    // Caption and actions are two GROUPS, not five siblings, for the same
    // reason the composer's `.tb-actions` is a group: this row wraps at a
    // narrow panel, and a flex-grow spacer is itself a wrappable item. With
    // `.sp` between them, "Edit config" left the panel entirely at 280px -
    // clipped by the scroller, with no scrollbar to say so. Grouped, the two
    // buttons drop to a second row together and both stay reachable.
    //
    // "Servers" and "· 4 configured" are one group for a second reason: as
    // siblings the phrase broke between "·" and "configured", which reads as
    // two facts rather than one caption.
    var head = '<div class="mcp-head">' +
      '<span class="mcp-cap">' +
        "<span class=\"l\">Servers</span>" +
        '<span class="when">' + (servers.length ? "· " + servers.length + " configured" : "") + "</span>" +
      "</span>" +
      '<span class="mcp-acts">' +
        '<button class="btn sm" data-mcp="reload">' + icon("i-refresh", "ic-13") + "<span>Reload</span></button>" +
        '<button class="btn sm" data-mcp="open">Edit config</button>' +
      "</span>" +
      "</div>";

    if (m.warnings && m.warnings.length) {
      head += '<div class="warn-line" style="padding:0 16px 10px">' + esc(m.warnings.join(" ")) + "</div>";
    }

    if (!servers.length) {
      body.innerHTML = head +
        '<div class="mcp-empty">' +
        "<p>No MCP servers configured.</p>" +
        '<p class="s">Declare them in <code>.agent/mcp.json</code>, in the same shape Claude Desktop uses. ' +
        "Their tools reach the model as <code>mcp__server__tool</code>, and are withheld in Ask and Plan mode.</p>" +
        '<div><button class="btn sm primary" data-mcp="open">Create config</button></div>' +
        "</div>";
      return;
    }

    var rows = "", tools = 0, down = 0;
    for (var i = 0; i < servers.length; i++) {
      var sv = servers[i];
      var ready = sv.state === "ready";
      var off = sv.state === "disabled";
      // Defaulted rather than trusted. The host always sends both fields, but a
      // stateSync from an older build - or a server that answered the handshake
      // and nothing else - renders "undefined tools" without this.
      var n = typeof sv.toolCount === "number" ? sv.toolCount : 0;
      var list = Array.isArray(sv.tools) ? sv.tools : [];
      if (ready) tools += n;
      else if (sv.state === "failed") down++;
      // A disabled server is configuration, not a fault. It is listed so the
      // panel reflects mcp.json, but it is not counted as "unavailable".

      rows += '<div class="mcp-row" data-state="' + esc(sv.state) + '">' +
        
        '<span class="mid">' +
          // The name ellipsises at a narrow width and had no title, so a long
          // server name simply could not be read. The line under it has always
          // carried one for the command.
          '<span class="top"><span class="nm" title="' + esc(sv.name) + '">' +
            esc(sv.name) + "</span>" + mcpPill(sv.state) +
            // The read-only claim, shown because it is the one thing that lets
            // this server's tools be used in Ask and Plan. A claim nobody can
            // see is a claim nobody can audit - and the title says plainly
            // that the user made it and the extension did not check it.
            (sv.readOnly
              ? '<span class="mcp-ro" title="You declared this server read-only in .agent/mcp.json, ' +
                'so its tools are offered in Ask and Plan. Nothing verifies that claim.">read-only</span>'
              : "") +
          "</span>" +
          '<span class="sub ell" title="' + esc(sv.command) + '">' +
            esc(sv.transport || "stdio") + " · " +
            esc(sv.serverInfo ? sv.serverInfo.name + " " + sv.serverInfo.version : sv.command) +
          "</span>" +
        "</span>" +
        '<span class="count">' + (ready ? n + (n === 1 ? " tool" : " tools") : off ? "off" : "no tools") + "</span>" +
        "</div>";

      if (off) {
        rows += '<div class="mcp-err" data-kind="hint">' +
          '<div class="t">Declared in <code>.agent/mcp.json</code> with <code>"enabled": false</code>, ' +
          "so it was not started and its tools are not offered to the model.</div>" +
          '<div class="acts">' +
            '<button class="btn sm" data-mcp="open">Edit config</button>' +
          "</div></div>";
      }

      if (ready && list.length) {
        var shown = list.slice(0, MCP_CHIP_CAP);
        var chips = shown.map(function (t) {
          var w = mcpToolWrites(t);
          var why = w
            ? t + " - classified as a tool that writes, because its name leads with a verb that changes state. It can act on the server, not just read from it."
            : t + " - classified read-only, because its name leads with no state-changing verb. Genesis expects it to read and return, never to modify.";
          return '<span class="mcp-chip" data-w="' + (w ? "1" : "0") + '" title="' + esc(why) + '">' + esc(t) + "</span>";
        }).join("");
        if (list.length > shown.length) {
          chips += '<span class="mcp-more" title="' + esc(list.join(", ")) + '">+' +
            (list.length - shown.length) + " more</span>";
        }
        rows += '<div class="mcp-chips">' + chips + "</div>";
      }

      if (!ready && sv.error) {
        var open = S.mcpLogs && S.mcpLogs[sv.name] !== undefined;
        rows += '<div class="mcp-err">' +
          "<div class=\"t\">" + esc(sv.error) + "</div>" +
          '<div class="acts">' +
            '<button class="btn sm primary" data-mcp="reconnect" data-name="' + esc(sv.name) + '">Reconnect</button>' +
            '<button class="btn sm" data-mcp="log" data-name="' + esc(sv.name) + '" aria-expanded="' +
              (open ? "true" : "false") + '">' + (open ? "Hide log" : "View log") + "</button>" +
          "</div>" +
          (open ? '<pre class="mcp-log">' + esc(S.mcpLogs[sv.name]) + "</pre>" : "") +
          "</div>";
      }
    }

    var foot = '<div class="mcp-foot">' +
      "<span>" + tools + (tools === 1 ? " tool" : " tools") + " exposed to the model</span>" +
      '<span class="sp"></span>' +
      (down
        ? '<span class="bad">' + icon("i-x", "ic-9") + down + (down === 1 ? " server" : " servers") + " unavailable</span>"
        : "") +
      "</div>";

    body.innerHTML = head + rows + foot;
  }

  function renderMcpCount() {
    var servers = (S.mcp && S.mcp.servers) || [];
    var down = 0;
    for (var i = 0; i < servers.length; i++) if (servers[i].state === "failed") down++;
    // Same rule as Diagnostics: a count, and only when something is wrong.
    setTabCount("tabMcp", "mcpCount", "MCP", down, "servers unavailable");
  }

  function onMcpClick(e) {
    var b = e.target.closest("[data-mcp]");
    if (!b) return;
    var a = b.getAttribute("data-mcp");
    if (a === "reload") post("mcpReload");
    // Creates the file when it is missing, then opens it. Posting `openFile`
    // here asked VS Code to open a path that, for the "Create config" button,
    // is missing by definition.
    else if (a === "open") post("mcpOpenConfig");
    else if (a === "reconnect") post("mcpReconnect", { name: b.getAttribute("data-name") });
    else if (a === "log") {
      // This posted `copyText` with the server's own name: it put a string on
      // the clipboard and showed nothing at all. The stderr tail is the only
      // place a failed start explains itself.
      var nm = b.getAttribute("data-name") || "";
      if (S.mcpLogs && S.mcpLogs[nm] !== undefined) {
        delete S.mcpLogs[nm];       // a second click closes it
        renderMcp();
      } else {
        post("mcpLog", { name: nm });
      }
    }
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
          ? ' style="background:var(--kx-accent);border-color:var(--kx-accent);color:var(--kx-on-accent)"'
          : "") + ">" + (s.enabled ? icon("i-check", "ic-9") : "") + "</span>" +
        '<span class="nm ell">' + esc(s.name) + "</span>" +
        '<span class="ds ell" title="' + esc(s.description) + '">' + esc(s.description) + "</span>" +
        '<span class="src">' + esc(s.source) + "</span></button>";
    }
    // Level 1 of the disclosure only: the fixed rules block plus one
    // "name: description" line per enabled skill, at ~4 chars a token. The
    // bodies are not counted because they are not in the prompt until the
    // model calls read_skill.
    var chars = 0;
    for (var n = 0; n < S.skills.length; n++) {
      if (!S.skills[n].enabled) continue;
      chars += S.skills[n].name.length + (S.skills[n].description || "").length + 4;
    }
    var tokens = enabled ? Math.round(chars / 4) + 140 : 0;
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
      if (body) { aiEl = null; addAiStatic(body); }

      var calls = msg.toolCalls || [];
      if (!calls.length) continue;
      // Same strip the live path builds; the elapsed stamp is meaningless on a
      // replay, so it is cleared rather than showing time since page load.
      var g = openToolGroup();
      for (var k = 0; k < calls.length; k++) {
        var call = calls[k];
        var el = toolCard(call.name, call.arguments);
        /* Replay never runs toolEnd, so the running spinner the card is built
           with has to be settled here by hand. Nothing on a restored
           transcript is still in flight, and a card left spinning would claim
           otherwise for as long as the session stayed open. */
        el.querySelector(".tool-meta").innerHTML =
          '<span class="tool-ok">' + icon("i-check", "ic-13") + "</span>";
        el.setAttribute("data-error", "0");
        // The rail dot settles with the tick. Setting one and not the other
        // left a restored card showing a green check beside a grey "still
        // running" dot - the two marks contradicting each other on the same
        // row.
        el.setAttribute("data-done", "1");
        var res = resultFor[call.id];
        // Same IN/OUT shape the live path builds, so reopening a session does
        // not quietly downgrade its command cards to a bare output block.
        if (call.name === "run_command" && call.arguments && call.arguments.command) {
          var rcmd = div("term-block cmd-in");
          rcmd.textContent = String(call.arguments.command);
          el.querySelector(".tool-body").appendChild(ioRow("IN", rcmd));
          if (res) el.querySelector(".tool-body").appendChild(ioRow("OUT", resultBlock(res, call.name)));
        } else if (res) el.querySelector(".tool-body").appendChild(resultBlock(res, call.name));
        g.querySelector(".tool-group-body").appendChild(el);
        g._count++;
      }
      g.querySelector(".n").textContent = g._count + (g._count === 1 ? " step" : " steps");
      g.querySelector(".ms").textContent = "";
      g.setAttribute("data-open", "0");
      closeToolGroup();
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

  /**
   * The contract version this frontend was built against. See PROTOCOL_VERSION
   * in src/ui/protocol.ts.
   */
  var PROTOCOL_VERSION = 1;
  var versionWarned = false;

  function hydrate(state) {
    /* The two halves ship together, so this normally never fires. It fires when
       a webview outlives an extension update installed while VS Code is
       running: the panel is restored against the new host, and every message
       type it does not recognise is silently ignored while every field that
       moved reads as undefined. That produced a plausible, stale, wrong panel
       with nothing suggesting a reload. */
    if (!versionWarned && state && typeof state.protocolVersion === "number" &&
        state.protocolVersion !== PROTOCOL_VERSION) {
      versionWarned = true;
      addError({
        message: "This panel is running an older build than the extension.",
        fix: "Reload the window (Developer: Reload Window) so the panel and the extension " +
             "match. Until then some things here may be out of date or missing."
      });
    }
    S.workspace = state.workspace;
    S.running = state.running;
    S.phase = state.phase;
    S.endpoint = state.endpoint;
    S.profiles = state.profiles || [];
    S.skills = state.skills || [];
    S.skillWarnings = state.skillWarnings || [];
    S.agents = state.agents || [];
    S.agentWarnings = state.agentWarnings || [];
    S.activeAgent = state.activeAgent || "";
    S.mcp = state.mcp || { servers: [], warnings: [] };
    S.config = state.config;
    /* The host has always sent `status` in the sync payload and this handler
       has always dropped it, so `S.status` was written by exactly one message:
       `statusChanged`. That is a PUSH, sent when the status changes - not when
       a panel opens - so a webview built while the gateway was failing came up
       with no status at all and renderFooter's `bad` was false. The health dot
       sat green, and stayed green until the endpoint's state next CHANGED.

       That is the one case the dot exists for. VS Code's status bar, which the
       host renders from the same StatusDto, showed "ERROR - HTTP" the whole
       time; the panel's own dot disagreed with it. Reloading the window - the
       first thing anyone tries - reproduced it rather than clearing it, since
       a reload is a fresh sync and no change. */
    S.status = state.status || null;
    S.tlsError = state.tlsError;
    S.rungs = state.rungs || [];
    S.tracing = state.tracing;
    S.traceRun = S.rungs.length > 0;
    S.todos = state.todos || [];
    S.sessions = state.sessions || [];
    S.selection = state.selection;
    S.context = state.context;
    S.changes = state.changes || [];
    S.models = state.models || [];

    S.sessionId = state.session ? state.session.id : null;
    S.title = state.session ? state.session.title : "";

    applyPhase(S.phase, true);
    renderSession(state.session ? state.session.messages : []);
    todoEl = null;
    renderTodos(S.todos);
    setChangesOpen(S.changesOpen);
    renderChanges(null);
    renderSelection();
    renderTip(false);
    renderPerm();
    // Survives a full re-render: the host pushes this on its own schedule, so
    // a stateSync that dropped it would blank the chip until the cursor next
    // moved, which on a still editor could be a long time.
    renderEditorChip();
    renderTitle();
    renderFooter();
    renderTls();
    renderEndpoints();
    renderSkills();
    renderAgents();
    renderAgentBar();
    renderMcp();
    renderMcpCount();
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

  /**
   * The file the editor is on, which the model is told about automatically.
   *
   * Kept visibly distinct from the attachment chips below it. An attachment is
   * something the user chose and can remove; this is a readout of where their
   * cursor is, and offering a dismiss button on it would promise a control
   * that does not exist. It goes quiet the moment focus leaves a real file, so
   * the composer says nothing rather than something stale.
   */
  function renderEditorChip() {
    var pill = $("edPill");
    var e = S.editor;
    if (!e || !e.file) { pill.hidden = true; return; }
    var nm = $("edName");
    nm.textContent = e.file;
    nm.title = e.file + (e.language ? " · " + e.language : "");
    var prob = $("edProb");
    var n = (e.errors || 0) + (e.warnings || 0);
    if (n) {
      // Errors win the colour when there are both: one error matters more
      // than nine warnings, and two numbers here would be noise.
      prob.textContent = e.errors ? e.errors + (e.warnings ? "+" : "") : String(e.warnings);
      prob.setAttribute("data-err", e.errors ? "1" : "0");
      prob.title = e.errors + " error(s), " + e.warnings + " warning(s) in this file";
      prob.hidden = false;
    } else {
      prob.hidden = true;
    }
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

  /* ───────────────────────── clipboard ─────────────────────────
   *
   * A screenshot is the fastest way to show a model what is wrong, and until
   * now the only route in was the file picker - which meant saving the
   * screenshot to disk first, finding it, and picking it. Ctrl+V puts it
   * straight into the composer.
   *
   * The same limits as the picker apply, enforced here because these bytes
   * never pass through it.
   */
  var ATTACH_MAX = 10 * 1024 * 1024;   // 10 MB, matching pickAndAttach
  var ATTACH_COUNT_MAX = 10;
  /* Characters past which pasted text becomes a file rather than composer
     content. A pasted log is something to hand over, not something to edit,
     and dropping 60,000 characters into a textarea makes the box unusable and
     hides the send button behind a scroll. */
  var PASTE_AS_FILE = 8000;
  var pasteSeq = 0;

  /** Names for pasted content, which arrives with no useful filename. */
  function pasteName(mediaType) {
    var ext = ({
      "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif",
      "image/webp": "webp", "image/svg+xml": "svg", "text/plain": "txt",
    })[mediaType] || "bin";
    return "pasted-" + ++pasteSeq + "." + ext;
  }

  /**
   * A string as an attachment, in the shape the composer and the wire use.
   *
   * Lifted out of `onPaste`, which has turned a large text paste into a
   * `text/plain` attachment since it shipped. Attaching a transcript message is
   * that same operation with the message's text instead of the clipboard's, and
   * two copies of a base64 encoder is how they stop agreeing.
   *
   * The host decodes it in `decodeTextAttachment` and inlines it as
   * ``Attached file `name`:`` with its own 60,000-character cap, so nothing
   * downstream needs to know where the text came from.
   */
  function textAttachment(name, text) {
    var bytes = new TextEncoder().encode(text);
    var b64 = "";
    // Chunked, because String.fromCharCode.apply on a large array overflows
    // the argument list.
    for (var k = 0; k < bytes.length; k += 8192) {
      b64 += String.fromCharCode.apply(null, bytes.subarray(k, k + 8192));
    }
    return { name: name, mediaType: "text/plain", data: btoa(b64), size: bytes.length };
  }

  function addAttachment(a) {
    if (!S.attachments) S.attachments = [];
    if (S.attachments.length >= ATTACH_COUNT_MAX) {
      addError("Up to " + ATTACH_COUNT_MAX + " attachments per message.");
      return false;
    }
    S.attachments.push(a);
    return true;
  }

  /** Read a Blob into the base64 shape the host and the wire already use. */
  function readBlob(blob, name, done) {
    if (blob.size > ATTACH_MAX) {
      addError(
        name + " is " + (blob.size / 1048576).toFixed(1) + " MB. The limit is 10 MB."
      );
      done(false);
      return;
    }
    var r = new FileReader();
    r.onload = function () {
      // readAsDataURL gives "data:<mime>;base64,<payload>"; the wire wants only
      // the payload, and the media type is tracked separately.
      var s = String(r.result || "");
      var comma = s.indexOf(",");
      done(addAttachment({
        name: name,
        mediaType: blob.type || "application/octet-stream",
        data: comma === -1 ? "" : s.slice(comma + 1),
        size: blob.size,
      }));
    };
    r.onerror = function () {
      addError("Could not read " + name + " from the clipboard.");
      done(false);
    };
    r.readAsDataURL(blob);
  }

  /* ───────────────────────── drag and drop ─────────────────────────
   *
   * Files dropped ON THE COMPOSER become attachments. Files dropped anywhere
   * else in the panel are refused, and that refusal is the point rather than
   * an omission.
   *
   * A webview is a browser frame, and a browser's default action for a dropped
   * file is to NAVIGATE TO IT. Dropped on the transcript, that replaces the
   * whole panel with a rendering of the file and there is no back button - the
   * conversation is simply gone until the view is reloaded. So the document
   * cancels dragover and drop everywhere, and the composer is the one element
   * that opts back in.
   *
   * Reuses readBlob, so the size cap, the count cap and the base64 shape are
   * the paste path's, not a second implementation of them.
   */
  function takeFiles(list, whenDone) {
    var blobs = [];
    for (var i = 0; i < (list ? list.length : 0); i++) blobs.push(list[i]);
    if (!blobs.length) return false;
    var left = blobs.length;
    var any = false;
    for (var b = 0; b < blobs.length; b++) {
      (function (blob) {
        var nm = blob.name || pasteName(blob.type);
        readBlob(blob, nm, function (ok) {
          any = any || ok;
          if (--left === 0 && any) whenDone();
        });
      })(blobs[b]);
    }
    return true;
  }

  /**
   * Paths out of a VS Code drag.
   *
   * A file dragged from the OS arrives as `dataTransfer.files` and can be read
   * here. A file dragged from VS CODE'S OWN EXPLORER does not: the webview is
   * an iframe inside the workbench, the drag never leaves the application, and
   * what arrives is a `text/uri-list` of `file://` URIs with an empty `files`
   * list. Handling only `Files` is why dropping onto the composer appeared to
   * do nothing - the commonest way to drag a file in an editor was the one
   * case that was not implemented.
   *
   * The host reads those paths, because the webview cannot: it has no file
   * access, and `file://` is not fetchable under this CSP.
   */
  function uriListPaths(dt) {
    var out = [];
    var raw = "";
    try {
      raw = dt.getData("text/uri-list") || dt.getData("resourceurls") || "";
    } catch (e) { return out; }
    if (!raw) return out;

    // `resourceurls` is a JSON array of URI strings; `text/uri-list` is
    // newline-separated with `#` comment lines.
    if (raw.charAt(0) === "[") {
      try {
        var arr = JSON.parse(raw);
        for (var i = 0; i < arr.length; i++) {
          var v = typeof arr[i] === "string" ? arr[i] : (arr[i] && arr[i].external);
          if (v) out.push(String(v));
        }
        return out;
      } catch (e) { /* fall through to the line form */ }
    }
    var lines = raw.split(/\r?\n/);
    for (var k = 0; k < lines.length; k++) {
      var line = lines[k].trim();
      if (line && line.charAt(0) !== "#") out.push(line);
    }
    return out;
  }

  function wireDrop() {
    var composer = document.querySelector(".composer");
    if (!composer) return;

    /* The document-wide guard.
     *
     * A webview is a browser frame, and a browser's default action for a
     * dropped file is to NAVIGATE TO IT - which replaces the whole panel with
     * a rendering of the file, with no way back short of reloading the view.
     * `dragover` has to be cancelled as well: without it `drop` never fires
     * anywhere, because the default dragover handler rejects the drag before
     * it reaches any element.
     *
     * CAPTURE PHASE. The workbench also listens for drags, and a bubbling
     * listener runs after anything that calls stopPropagation on the way down.
     */
    document.addEventListener("dragover", function (e) { e.preventDefault(); }, true);
    document.addEventListener("drop", function (e) { e.preventDefault(); }, true);

    // A counter, not a boolean: dragging across a child element fires leave on
    // the parent before enter on the child, so a boolean flickers the outline
    // off and on as the pointer crosses the textarea.
    var depth = 0;
    var carriesFiles = function (e) {
      var t = e.dataTransfer && e.dataTransfer.types;
      if (!t) return false;
      for (var i = 0; i < t.length; i++) {
        // "Files" is an OS drag. The other two are the workbench dragging one
        // of its own resources, which is the same intent by a different route.
        if (t[i] === "Files" || t[i] === "text/uri-list" || t[i] === "resourceurls") return true;
      }
      return false;
    };

    composer.addEventListener("dragenter", function (e) {
      if (!carriesFiles(e)) return;
      depth++;
      composer.setAttribute("data-drop", "1");
    }, true);
    composer.addEventListener("dragleave", function () {
      if (depth > 0) depth--;
      if (!depth) composer.removeAttribute("data-drop");
    }, true);
    composer.addEventListener("dragover", function (e) {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      // Tells the OS this is a copy rather than a move, which is what changes
      // the cursor to the one with a plus on it.
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    }, true);
    composer.addEventListener("drop", function (e) {
      e.preventDefault();
      e.stopPropagation();
      depth = 0;
      composer.removeAttribute("data-drop");
      var dt = e.dataTransfer;
      if (!dt) return;

      // OS drag first: those bytes are already here and need no round trip.
      if (dt.files && dt.files.length) {
        takeFiles(dt.files, function () {
          renderAttachments();
          syncComposer();
        });
        return;
      }
      // Otherwise it came from inside VS Code, and only the host can read it.
      var paths = uriListPaths(dt);
      if (paths.length) post("attachPaths", { paths: paths });
    }, true);
  }

  function onPaste(e) {
    var cd = e.clipboardData;
    if (!cd) return;

    // Files first: a screenshot arrives as an image/* item, and a file copied
    // from the file manager arrives the same way with a real name.
    var blobs = [];
    var items = cd.items || [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].kind !== "file") continue;
      var f = items[i].getAsFile();
      if (f) blobs.push(f);
    }

    if (blobs.length) {
      // Stop the textarea from also handling this paste; some hosts would
      // otherwise insert the file's name as text next to the attachment.
      e.preventDefault();
      var left = blobs.length;
      var any = false;
      for (var b = 0; b < blobs.length; b++) {
        (function (blob) {
          // A screenshot's File carries a generic name or none at all.
          var nm = blob.name && blob.name !== "image.png" ? blob.name : pasteName(blob.type);
          readBlob(blob, nm, function (ok) {
            any = any || ok;
            if (--left === 0 && any) {
              renderAttachments();
              syncComposer();
            }
          });
        })(blobs[b]);
      }
      return;
    }

    // A large text paste becomes a file rather than composer content.
    var text = cd.getData("text/plain") || "";
    if (text.length > PASTE_AS_FILE) {
      e.preventDefault();
      var ok = addAttachment(textAttachment(pasteName("text/plain"), text));
      if (ok) {
        renderAttachments();
        syncComposer();
      }
      return;
    }
    // Everything else is an ordinary paste; let the textarea have it.
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
      else if (a === "agents") setTab("agents");
      else if (a === "exportChat") post("exportChat", { scope: "current" });
      else if (a === "exportAll") post("exportChat", { scope: "all" });
      else if (a === "settings") post("openSettings");
      else if (a === "docs") post("openControlCenter", { section: "docs" });
      else if (a === "issue") post("openControlCenter", { section: "about" });
    });
    $("historyPop").addEventListener("click", function (e) {
      var stop = e.target.closest("[data-stop]");
      if (stop) {
        // Nested inside the row like Delete is, so the load handler must not
        // also fire on the way up and switch you into the chat you just
        // stopped.
        e.stopPropagation();
        post("stopSession", { id: stop.getAttribute("data-stop") });
        return;
      }
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
      // The welcome screen's "All" opens the history popover, and it lives in
      // the transcript rather than the header - without this exemption this
      // closer fires on the same click and shuts it again.
      if (!e.target.closest(".kx-header") && !e.target.closest('[data-act="history"]')) closePops();
      // The sheet covers the panel and handles its own backdrop click, so the
      // document-level closer must not also fire on it.
      if (!e.target.closest("#permBtn") && !e.target.closest("#permPop")) togglePerm(false);
      if (S.modelOpen && !e.target.closest("#modelBtn") && !e.target.closest("#qp")) {
        S.modelOpen = false;
        renderQuickPick();
      }
    });

    $("tabSession").addEventListener("click", function () { setTab("session"); });
    $("tabDiag").addEventListener("click", function () { setTab("diagnostics"); });
    // One listener on the strip rather than four on the tabs: the handler works
    // off S.tab, not off the element the key landed on, so it behaves the same
    // whichever tab has focus.
    document.querySelector(".kx-tabs").addEventListener("keydown", onTabKey);
    $("ccBtn").addEventListener("click", function () { post("openControlCenter", {}); });

    document.addEventListener("click", function (e) {
      var head = e.target.closest(".sec-head");
      if (!head) return;
      var sec = $(head.getAttribute("data-sec"));
      var open = sec.getAttribute("data-open") === "1";
      sec.setAttribute("data-open", open ? "0" : "1");
      head.setAttribute("aria-expanded", open ? "false" : "true");
      sec.querySelector(".sec-body").hidden = open;
      saveUiState();
    });

    $("phaseSeg").addEventListener("click", function (e) {
      var b = e.target.closest("[data-phase]");
      if (b) applyPhase(b.getAttribute("data-phase"));
    });

    /* RIGHT-CLICK ON A MESSAGE, AND ONLY ON A MESSAGE.
     *
     * Tool cards, diff cards, the error box and the welcome screen keep VS
     * Code's own menu - and so does a fenced code block, checked first because
     * it sits INSIDE `.msg-ai` and would otherwise be caught by it. */
    logEl.addEventListener("contextmenu", function (e) {
      if (e.target.closest(".cb")) return;
      var el = e.target.closest(".msg-user, .msg-ai");
      if (!el) return;
      e.preventDefault();
      /* The Menu key and Shift+F10 raise this event too, with clientX and
         clientY both 0 - so a keyboard user would get the menu pinned to the
         panel's top-left corner rather than to the message they are on. */
      var x = e.clientX;
      var y = e.clientY;
      if (!x && !y && el.getBoundingClientRect) {
        var r = el.getBoundingClientRect();
        x = r.left + 8;
        y = r.top + 8;
      }
      openMsgMenu(el, x, y);
    });

    $("msgMenu").addEventListener("click", function (e) {
      var row = e.target.closest("[data-mm]");
      if (!row) return;
      var el = $("msgMenu")._target;
      if (el) onMsgAction(row.getAttribute("data-mm"), el);
      // The document-level closer hides it a moment later, on the same click.
    });

    // The log's own scrolling is the only other thing that changes the answer.
    logEl.addEventListener("scroll", syncToLatest);
    /* A menu anchored to a pointer position is wrong the instant the content
       under it moves, and the transcript scrolls on its own while a turn
       streams.
       
       MEASURED, NOT MERELY OBSERVED. Closing on the bare event was wrong and
       the browser suite caught it: a scroll event queued just BEFORE the menu
       opened - by the click's own scroll-into-view, or by a delta landing
       mid-stream - is delivered at the next rendering opportunity, which is
       after the contextmenu handler has run. The menu opened and vanished on
       the same gesture. So this compares against the offset the menu was
       anchored at and ignores anything that did not actually move. */
    logEl.addEventListener("scroll", function () {
      var menu = $("msgMenu");
      if (!menu || menu.hidden) return;
      if (Math.abs(logEl.scrollTop - (menu._scrollAt || 0)) > 4) menu.hidden = true;
    });
    $("toLatest").addEventListener("click", function () {
      scroll();
      syncToLatest();
      $("draft").focus();
    });

    logEl.addEventListener("click", function (e) {
      // Code-block copy is delegated because md() writes blocks as innerHTML on
      // every repaint - a listener bound per block would be lost each flush.
      var cbc = e.target.closest("[data-cb-copy]");
      if (cbc) {
        var pre = cbc.closest(".cb") && cbc.closest(".cb").querySelector("pre");
        if (pre) {
          post("copyText", { text: pre.textContent });
          var was = cbc.innerHTML;
          cbc.innerHTML = icon("i-check", "ic-11");
          cbc.setAttribute("data-done", "1");
          setTimeout(function () { cbc.innerHTML = was; cbc.removeAttribute("data-done"); }, 1200);
        }
        return;
      }
      // Delete is checked BEFORE load: it sits inside the same row, so a click
      // on the bin would otherwise also match the row's [data-session] on the
      // way up and open the very conversation being thrown away.
      var wdel = e.target.closest(".welcome [data-del]");
      if (wdel) {
        post("deleteSession", { id: wdel.getAttribute("data-del") });
        return;
      }
      var recent = e.target.closest(".welcome [data-session]");
      if (recent) { post("loadSession", { id: recent.getAttribute("data-session") }); return; }
      var sug = e.target.closest("[data-sug]");
      if (sug) { sendText(sug.getAttribute("data-sug")); return; }
      // A welcome opener. The slash ones go through runSlash so they behave
      // exactly as if typed - /explain and /tests resolve their own target
      // from the active editor and send nothing on their own - and "review"
      // is a real prompt, so it is sent.
      var st = e.target.closest("[data-starter]");
      if (st) {
        var run = st.getAttribute("data-starter");
        var box = $("draft");
        if (run === "review") sendText(REVIEW_PROMPT);
        else { runSlash(run.slice(1), box); syncComposer(); box.focus(); }
        return;
      }
      var act = e.target.closest("[data-act]");
      if (!act) return;
      var a = act.getAttribute("data-act");
      if (a === "doctor") { setTab("diagnostics"); openSection("secTls"); post("runTrace"); }
      else if (a === "openFolder") post("openFolder");
      else if (a === "newEndpoint") post("newEndpoint");
      else if (a === "ccEndpoints") post("openControlCenter", { section: "endpoints" });
      else if (a === "history") {
        // Same sequence the header's history button uses: ask the host to
        // refresh the list, render, then show. Skipping listSessions would
        // open the popover on whatever was cached at boot.
        closePops();
        post("listSessions");
        renderHistory();
        $("historyPop").hidden = false;
        $("histBtn").setAttribute("aria-expanded", "true");
      }
    });

    var draft = $("draft");
    var warmed = false;
    draft.addEventListener("input", function () {
      syncComposer();
      detectQuickPick();
      renderDraftMirror();
      /* Pay the connection, credential and prompt-cache costs of the next turn
         while the user is still typing, rather than after they press Enter.

         ON THE FIRST KEYSTROKE, NOT ON FOCUS. Warming builds the endpoint
         client, and building one runs the profile's transform module and
         spawns its `exec` credential helper - both of them programs named by
         files in the open folder. Hanging that off `focus` meant clicking into
         the text box was enough to run them, before the user had asked for
         anything at all. Typing a character is a deliberate act; putting the
         cursor somewhere is not.

         Once per composer, because the host debounces but a message per
         keystroke is still a message per keystroke. */
      if (!warmed && draft.value.trim()) {
        warmed = true;
        post("warm");
      }
      // Cheap, synchronous, and the whole reason a draft survives the view
      // being collapsed. See saveUiState.
      saveUiState();
    });
    // A long draft scrolls inside a fixed-height box; the mirror has to follow
    // or the colouring slides off the text it belongs to.
    draft.addEventListener("scroll", function () {
      $("draftMirror").scrollTop = draft.scrollTop;
    });
    draft.addEventListener("keydown", onDraftKey);

    $("qp").addEventListener("click", function (e) {
      var b = e.target.closest("[data-i]");
      if (!b) return;
      S.qpIndex = Number(b.getAttribute("data-i"));
      acceptQuickPick();
    });
    /* The panel is draggable, so the room the label has is not fixed at render
       time. Without this the name is fitted once, to whatever width the panel
       happened to have when the endpoint last changed, and dragging the panel
       wider leaves it truncated while dragging it narrower overflows it.
       Observed on the button rather than the window: the button's width is
       what the fit is against, and it changes for reasons other than a window
       resize - the mode label appearing at 500px takes 46px out of it. */
    if (typeof ResizeObserver === "function") {
      new ResizeObserver(function () { fitModelName(); }).observe($("modelBtn"));
    }
    $("modelBtn").addEventListener("click", function (e) {
      e.stopPropagation();
      S.modelOpen = !S.modelOpen;
      S.qp = null;
      S.qpIndex = 0;
      renderQuickPick();
    });
    $("clipBtn").addEventListener("click", function () {
      post("attachFiles");
    });
    // On the textarea rather than the document, so a paste into some other
    // field cannot silently become an attachment.
    draft.addEventListener("paste", onPaste);
    wireDrop();
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
    $("chgToggle").addEventListener("click", function () { setChangesOpen(!S.changesOpen); });
    $("chgClear").addEventListener("click", function () {
      // Optimistic: the list is a view of the host's map, and the host answers
      // with an empty changesUpdated, but waiting for the round trip makes the
      // button feel unresponsive on a busy turn.
      S.changes = [];
      renderChanges(null);
      post("clearChanges");
    });
    $("chgList").addEventListener("click", function (e) {
      var row = e.target.closest("[data-chg]");
      if (row) post("openFile", { path: row.getAttribute("data-chg") });
    });
    $("queueList").addEventListener("click", function (e) {
      var b = e.target.closest("[data-q]");
      if (!b) return;
      var row = b.closest(".queue-row");
      if (!row) return;
      var id = row.getAttribute("data-id");
      // Optimistic, for the same reason the change list is: the host answers
      // with a fresh queue either way, and a row that sits there after you
      // press the cross is the exact complaint this tray exists to answer.
      S.queue = S.queue.filter(function (q) { return q.id !== id; });
      renderQueue();
      post(b.getAttribute("data-q") === "now" ? "promoteQueued" : "cancelQueued", { id: id });
    });
    $("queueClear").addEventListener("click", function () {
      var ids = S.queue.map(function (q) { return q.id; });
      S.queue = [];
      renderQueue();
      for (var i = 0; i < ids.length; i++) post("cancelQueued", { id: ids[i] });
    });
    $("tipNext").addEventListener("click", function () { renderTip(true); });
    watchTips();

    $("permBtn").addEventListener("click", function (e) {
      e.stopPropagation();
      togglePerm();
    });
    $("permPop").addEventListener("click", function (e) {
      // The X, and the dimmed backdrop itself. A modal sheet that can only be
      // dismissed by choosing something is a trap; clicking away is how every
      // other sheet on the platform closes.
      if (e.target.closest("[data-perm-close]") || !e.target.closest(".perm-card")) {
        togglePerm(false);
        return;
      }
      var b = e.target.closest("[data-perm]");
      if (!b) return;
      var mode = b.getAttribute("data-perm");
      /* ONE MORE PRESS FOR THE ONE THAT GIVES EVERYTHING AWAY.
       *
       * Full-auto was a single click on a row the same weight as the other
       * two, so browsing the sheet to see what the modes were could hand the
       * agent unattended shell access. The sheet's own comment calls this
       * control "a decision worth stopping for"; it stopped for the decision
       * and not for the one decision that matters.
       *
       * The row asks to be pressed again rather than opening a dialog: a
       * confirmation on top of a sheet is two modals deep, and the row already
       * carries the alarm hue that says which one this is. Any other row, or
       * closing the sheet, cancels it. */
      if (mode === "full-auto" && b.getAttribute("data-arm") !== "1") {
        var armed = $("permList").querySelectorAll("[data-arm]");
        for (var i = 0; i < armed.length; i++) armed[i].removeAttribute("data-arm");
        b.setAttribute("data-arm", "1");
        b.querySelector(".m").textContent =
          "Press again to confirm. Nothing will ask you before it runs.";
        return;
      }
      // Straight to the host: approvalMode is a real setting, so the panel
      // shows what it is rather than keeping a second copy of the truth.
      post("setConfig", { key: "approvalMode", value: mode });
      togglePerm(false);
    });

    $("selClear").addEventListener("click", function () {
      S.selection = null;
      renderSelection();
    });
    $("sendBtn").addEventListener("click", function () {
      // While a turn runs the button interrupts, but a draft with text in it
      // means the user wants to say something, not to stop the model. Sending
      // it is what they asked for; the host decides whether that queues or
      // steers. Stop is still available on an empty draft, and on Escape.
      if (S.running && !draft.value.trim() && !(S.attachments || []).length) { post("interrupt"); return; }
      sendText(draft.value);
      draft.value = "";
      S.attachments = [];
      renderAttachments();
      syncComposer();
    });

    document.addEventListener("keydown", function (e) {
      /* Escape shuts the menu FIRST. Interrupting a turn because the user
         wanted to dismiss a menu is the wrong reading of one keystroke. */
      if (e.key === "Escape" && $("msgMenu") && !$("msgMenu").hidden) {
        $("msgMenu").hidden = true;
        return;
      }
      if (e.key === "Escape" && S.running && $("qp").hidden) post("interrupt");
    });

    $("agentLeave").addEventListener("click", function () { post("setAgent", { name: "" }); });
    // On the wrapper rather than the list: the header's New agent button is a
    // sibling of the list, and it is the one control that has to work when the
    // list is empty.
    $("viewAgents").addEventListener("click", onAgentClick);
    $("tlsBody").addEventListener("click", onTlsClick);
    $("epBody").addEventListener("click", onEpClick);
    // Delegated, because the form is re-rendered wholesale on every check rung
    // and a listener bound to the select would not survive that. The hint has
    // to move with the answer: it states what the chosen kind will do to the
    // generated capability block, so a stale one is worse than none.
    $("epBody").addEventListener("change", function (e) {
      var sel = e.target.closest && e.target.closest("#fKind");
      if (!sel) return;
      readEpForm();
      var hint = $("fKindHint");
      if (!hint) return;
      if (sel.value) {
        hint.removeAttribute("data-err");
        hint.textContent = llmKind(sel.value).note + ". " + kindImplies(sel.value);
      } else {
        hint.setAttribute("data-err", "1");
        hint.textContent = "Required. The gateway cannot be asked what sort of model it serves.";
      }
      sel.setAttribute("data-empty", sel.value ? "0" : "1");
    });
    $("skBody").addEventListener("click", onSkillClick);
    $("mcpBody").addEventListener("click", onMcpClick);
    $("tabMcp").addEventListener("click", function () { setTab("mcp"); });
    $("tabAgents").addEventListener("click", function () { setTab("agents"); });
  }

  function onDraftKey(e) {
    var draft = $("draft");

    /* An IME composition owns Enter.
     *
     * Typing Japanese, Chinese or Korean means typing latin keys, then pressing
     * Enter to commit the candidate the IME is offering. Treating that Enter as
     * "send" fires the message mid-word and leaves the composition unfinished -
     * the panel was unusable for anyone typing a CJK language. The same applies
     * to the quick-picker below, so this returns before any key handling.
     *
     * `isComposing` is the modern signal; keyCode 229 is what older IMEs on
     * Windows report, and costs one comparison to cover. */
    if (e.isComposing || e.keyCode === 229) return;

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
      var idx = PHASE_CYCLE.indexOf(S.phase);
      applyPhase(PHASE_CYCLE[(idx + 1) % PHASE_CYCLE.length]);
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
      S.epForm = {
        // `kind` starts empty on purpose. It is the one field with no safe
        // default: guessing it would seed the wrong capabilities silently, and
        // a pre-selected value is a question nobody reads. Save refuses until
        // it is answered.
        isNew: true, id: "", name: "", url: "", type: "openai-compatible",
        kind: "", model: "", chatPath: "", apiKey: "", hasStoredKey: false,
        timeoutMs: 0, http2: false
      };
      S.epCheck = null;
      renderEndpoints();
    } else if (a === "cancel") {
      S.epForm = null;
      S.epCheck = null;
      renderEndpoints();
    } else if (a === "edit") {
      for (var i = 0; i < S.profiles.length; i++) {
        if (S.profiles[i].id !== id) continue;
        var p = S.profiles[i];
        S.epForm = {
          isNew: false, id: p.id, name: p.description || p.id,
          url: p.baseUrl === "-" ? "" : p.baseUrl,
          type: p.wire === "anthropic" ? "anthropic" : "openai-compatible",
          kind: p.kind || "",
          model: p.model === "-" ? "" : p.model,
          chatPath: p.chatPath || "",
          timeoutMs: p.timeoutMs || 0,
          http2: !!p.http2,
          apiKey: "",
          // The DTO carries the raw template, never the value, so this is the
          // only way the form can tell "a key exists" from "no key set".
          hasStoredKey: (p.authSummary || "").indexOf("${secret:") !== -1,
          originalId: p.id
        };
        S.epCheck = null;
        renderEndpoints();
        break;
      }
    } else if (a === "del") {
      post("deleteEndpoint", { id: id });
    } else if (a === "models") {
      var mDraft = readEpForm();
      if (!mDraft) return;
      var hint = $("fModelHint");
      // Says what it is doing, because it is trying every id the gateway lists
      // and that takes a few seconds - silence would read as a hung button.
      if (hint) {
        hint.innerHTML = spinner() +
          "<span>Asking the gateway, then checking which ids actually answer…</span>";
        hint.removeAttribute("data-err");
      }
      if (b) b.setAttribute("data-busy", "1");
      post("listModels", { endpoint: epPayload(mDraft) });
    } else if (a === "check") {
      var draft = readEpForm();
      if (!draft) return;
      S.epCheck = { id: draft.id || "draft", running: true, done: false, ok: false, summary: "", rungs: [] };
      renderEndpoints();
      post("checkEndpoint", { endpoint: epPayload(draft) });
    } else if (a === "save") {
      var draftSave = readEpForm();
      if (!draftSave) return;
      // Mandatory, and enforced here rather than only on the host: the host
      // throws, and a thrown save closes the form and loses everything typed.
      // Catching it in the panel keeps the form open with the answer one click
      // away, which is the difference between a validation and a punishment.
      if (!draftSave.kind) {
        renderEndpoints();
        var kSel = $("fKind"), kHint = $("fKindHint");
        if (kHint) {
          kHint.setAttribute("data-err", "1");
          kHint.textContent = "Choose what kind of model this endpoint serves before saving.";
        }
        if (kSel && kSel.focus) kSel.focus();
        return;
      }
      var form = epPayload(draftSave);
      S.epForm = null;
      S.epCheck = null;
      renderEndpoints();
      if (form.id) post("saveEndpoint", { endpoint: form });
    }
  }

  /** The wire shape of the form. `apiKey` is omitted when nothing was typed. */
  function epPayload(f) {
    var out = {
      id: f.id, name: f.name, url: f.url, type: f.type,
      kind: f.kind || "", model: f.model || "", chatPath: f.chatPath || "",
      http2: !!f.http2, hasStoredKey: !!f.hasStoredKey
    };
    if (f.timeoutMs) out.timeoutMs = f.timeoutMs;
    if (f.apiKey) out.apiKey = f.apiKey;
    if (f.originalId) out.originalId = f.originalId;
    return out;
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

      case "thinking":
        addThinking(m.text);
        break;

      case "streamReset":
        resetAi();
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

      case "imageGenerated":
        addImage(m);
        break;

      case "mcpLog":
        if (!S.mcpLogs) S.mcpLogs = {};
        S.mcpLogs[m.name] = m.log;
        renderMcp();
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
        applyTouch(m.file);
        break;

      case "changesUpdated":
        S.changes = m.files || [];
        renderChanges(null);
        break;

      case "turnEnd":
        S.running = false;
        endStream();
        endTurn();
        aiEl = null;
        pendingTool = null;
        syncComposer();
        // The one announcement a turn earns. The reply itself is navigable in
        // the transcript; what someone not watching the screen needs is to
        // know it has stopped arriving.
        announce("Finished.");
        break;

      case "error":
        // The whole message, not just its text: the host sends the cause, the
        // remedy, the raw evidence and the route out as four separate fields
        // now. See ErrorOut in src/ui/protocol.ts.
        addError(m);
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
        // A reload can land while the form is open (the file watcher fires on
        // every save). Snapshot first so it re-renders with what was typed.
        readEpForm();
        renderEndpoints();
        renderFooter();
        syncComposer();
        if (logEl.querySelector(".welcome")) renderWelcome(false); // a refresh under the panel, not an arrival
        break;

      case "endpointCheckStarted":
        readEpForm();
        S.epCheck = { id: m.id, running: true, done: false, ok: false, summary: "", rungs: [] };
        renderEndpoints();
        break;

      case "endpointCheckRung":
        if (!S.epCheck) break;
        readEpForm();
        S.epCheck.rungs = S.epCheck.rungs.concat([m.rung]);
        renderEndpoints();
        break;

      case "queueChanged":
        // A retry pressed during a turn lands here rather than in the
        // transcript, and the button has to stop spinning either way.
        clearRetrySpinners();
        S.queue = m.items || [];
        S.pending = S.queue.length;
        renderQueue();
        break;

      case "inputAccepted": {
        // Confirms the message was taken rather than swallowed. Without this
        // the composer clears and nothing visibly happens, which reads as the
        // message having been lost.
        // Queued messages are drawn by renderQueue() from `queueChanged`; this
        // is left holding the steer case only, which genuinely IS an event -
        // the message has gone, and there is nothing left waiting to show.
        if (m.mode !== "steer") break;
        S.pending = m.depth;
        var word = "Sent to the model - it will read this before its next step.";
        // The chips go on the note because the composer's pills have already
        // cleared: without them a message queued with a screenshot attached
        // showed only the sentence, which is what it looked like back when the
        // attachment really was being dropped.
        var note = div("queued-note", icon(m.mode === "steer" ? "i-up" : "i-clock", "ic-11") +
          "<span>" + esc(word) + "</span>" + attChips(m.files));
        add(note);
        break;
      }

      case "steerAccepted":
        // It is a user turn: the reply after it was written knowing it - and
        // it carries its files, because the host sends them with it now.
        addUser(m.text, m.files);
        break;

      case "modelsListed": {
        var dl = $("fModelList");
        var mh = $("fModelHint");
        var lb = document.querySelector('[data-ep="models"]');
        if (lb) lb.removeAttribute("data-busy");
        if (dl) {
          dl.innerHTML = (m.models || [])
            .map(function (id) { return '<option value="' + esc(id) + '"></option>'; })
            .join("");
        }
        if (mh) {
          // Assigning textContent replaces the spinner node as well as the
          // message, so the busy state clears itself here.
          if (m.error) {
            // Not a failure of the endpoint - plenty of gateways serve no
            // /models route - so it reads as information, not an error state.
            mh.textContent = "Could not list models: " + m.error + " Type the id instead.";
            mh.setAttribute("data-err", "1");
          } else {
            var n = (m.models || []).length;
            var listed = m.listed || 0;
            // Both numbers, because they differ a lot and the gap is the point:
            // a listed id is not a servable one, and that is what makes a model
            // hang instead of failing cleanly.
            mh.textContent = n
              ? n + " of " + listed + " listed model" + (listed === 1 ? "" : "s") +
                " answered - start typing to filter. The rest 404 or never reply."
              : listed
                ? "None of the " + listed + " listed models answered. Check the key and the base URL."
                : "The gateway listed no models. Type the id instead.";
            mh.removeAttribute("data-err");
          }
        }
        break;
      }

      case "endpointCheckDone":
        readEpForm();
        S.epCheck = {
          id: m.id, running: false, done: true,
          ok: !!m.ok, summary: m.summary || "", rungs: m.rungs || []
        };
        renderEndpoints();
        break;

      case "mcpChanged":
        S.mcp = { servers: m.servers || [], warnings: m.warnings || [] };
        renderMcp();
        renderMcpCount();
        break;

      case "agentsReloaded":
        S.agents = m.agents || [];
        S.agentWarnings = m.warnings || [];
        S.activeAgent = m.active || "";
        renderAgents();
        renderAgentBar();
        break;

      case "agentChanged":
        S.activeAgent = m.agent ? m.agent.name : "";
        for (var ai = 0; ai < S.agents.length; ai++) {
          S.agents[ai].active = S.agents[ai].name === S.activeAgent;
        }
        renderAgents();
        renderAgentBar();
        break;

      case "skillsReloaded":
        S.skills = m.skills || [];
        S.skillWarnings = m.warnings || [];
        renderSkills();
        break;

      case "contextUsage":
        S.context = { used: m.used, limit: m.limit, exact: m.exact === true };
        renderFooter();
        break;

      case "selectionChanged":
        S.selection = m.selection;
        renderSelection();
        break;

      case "editorContextChanged":
        S.editor = m;
        renderEditorChip();
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
        S.title = m.title || "";
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
        renderTitle();
        renderFooter();
        syncComposer();
        break;

      case "sessionTitled":
        // Only the name changed - the transcript on screen must not be touched.
        if (m.id === S.sessionId) { S.title = m.title || ""; renderTitle(); }
        break;

      case "sessionsListed":
        // The empty screen lists these, and on a fresh chat the list arrives
        // after the screen is already drawn. Without this it stayed blank
        // until something else forced a re-render.
        S.sessions = m.sessions || [];
        renderHistory();
        if (logEl.querySelector(".welcome")) renderWelcome(false); // a refresh under the panel, not an arrival
        break;


      case "configChanged":
        S.config = m.config;
        // The footer shows the approval mode, so it has to follow a change
        // made anywhere else - the Control Center, or settings.json by hand.
        renderPerm();
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
        // Was an empty break, which is why the health dot only ever knew about
        // TLS. See renderFooter.
        S.status = m.status;
        renderFooter();
        break;

      case "caBundlePicked":
        if (S.caUpload) { S.caUpload.path = m.path; renderTls(); }
        break;

      case "fileResults":
        if (m.query !== S.fileQuery) break;
        S.files = m.files || [];
        S.searching = false;
        S.qpIndex = 0;
        renderQuickPick();
        break;

      case "chatExported": {
        var what = m.scope === "all"
          ? m.sessions + (m.sessions === 1 ? " conversation" : " conversations")
          : "This conversation";
        addNotice("i-download",
          what + " · " + m.messages + (m.messages === 1 ? " message" : " messages") +
          " exported to " + m.path, m.path);
        break;
      }

      case "bundleExported":
        /* This was in the do-nothing list, so "Export offline bundle" wrote a
           folder and the panel said nothing whatsoever - the command looked
           like it had failed. Same treatment the chat export gets, for the same
           reason: what the user needs afterwards is the path.

           It used to end "and no credentials", which was the same unchecked
           claim the README made. The export scans what it copied now, so this
           reports the count it was given. */
        addNotice("i-download",
          "Offline bundle written to " + m.path +
          (m.redactions
            ? " - " + m.redactions + (m.redactions === 1 ? " credential was" : " credentials were") +
              " found in this workspace's config and redacted from the copy. See its README."
            : " - it holds this workspace's .agent configuration, scanned and clear of credentials."),
          m.path);
        break;

      case "checkpointsListed":
      case "checkpointRestored":
      case "logLine":
      case "navigate":
        break;

      /* AN UNRECOGNISED MESSAGE IS A FACT, NOT A NO-OP.
       *
       * Both sides used to switch on `type` and fall off the end in silence,
       * so a host newer than this cached document produced a control that did
       * nothing at all: no error, no console line, nothing for a bug report to
       * name. The `ready` handshake compares builds and says so properly; this
       * is the backstop for anything that slips past it. */
      default:
        if (window.console && console.warn) {
          console.warn(
            "[genesis] the extension sent a message this panel does not handle: " + m.type +
            ". This panel is build " + ((window.__kx && window.__kx.build) || "unknown") +
            "; reload the window if controls are not responding."
          );
        }
        break;
    }
  });

  /* ───────────────────────── boot ───────────────────────── */

  mount();
  wire();
  // After wire() so the listeners that keep it saved are already attached, and
  // before the first render so nothing paints twice.
  restoreUiState();
  renderWelcome();
  renderFooter();
  renderTls();
  renderEndpoints();
  renderSkills();
  syncComposer();
  // The build this document was served from, so the host can say so if VS
  // Code has handed the user a cached panel from before an update.
  post("ready", { build: (window.__kx && window.__kx.build) || "" });
})();
} /* end _sbRun */
