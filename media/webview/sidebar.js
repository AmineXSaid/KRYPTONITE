/* KRYPTONITE sidebar frontend. Plain DOM, zero dependencies.
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
    '<symbol id="i-info" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5" ' + S6 + ' stroke-width="1.5"/><path d="M12 11v5.5M12 7.5v.5" ' + S6 + ' stroke-width="1.7"/></symbol>' +
    '<symbol id="i-clip" viewBox="0 0 24 24"><path d="M17.5 10.5l-6.8 6.8a3 3 0 01-4.2-4.2l7.5-7.5a4.5 4.5 0 016.4 6.4l-7.5 7.5" ' + S6 + ' stroke-width="1.5"/></symbol>' +
    '<symbol id="i-up" viewBox="0 0 24 24"><path d="M12 19V5M6 11l6-6 6 6" ' + S6 + ' stroke-width="1.7"/></symbol>' +
    '<symbol id="i-stop" viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor"/></symbol>' +
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
    /* Not an icon: the header's ornament, and the only decorative mark in the
       product. A hairline rule broken by a single cut stone - the crystal's
       geometry at a twentieth of its size, so it belongs to the mark at the
       other end of the header without competing with it. Portrait, like the
       crystal, and stroked rather than filled, because the house rule is that
       the only glow in the panel lives inside the artwork itself. */
    '<symbol id="i-facet" viewBox="0 0 10 22">' +
      '<path d="M5 .8V7.4M5 14.6v6.6" ' + S6 + ' stroke-width=".9" stroke-linecap="round"/>' +
      '<path d="M5 8.1 7.7 11 5 13.9 2.3 11Z" stroke="currentColor" fill="currentColor" ' +
        'fill-opacity=".16" stroke-width=".9" stroke-linejoin="round"/>' +
      '<path d="M2.3 11h5.4" ' + S6 + ' stroke-width=".7" stroke-opacity=".7"/>' +
    '</symbol>';

  /* Ladder rung name -> the short label the design shows. */
  var RUNG_LABELS = {
    "Certificates and keys": "Config", "Profile": "Config", "DNS": "DNS", "TCP": "TCP",
    "TLS handshake": "TLS", "Authentication": "Auth", "Completion": "HTTP",
    "Streaming": "Stream", "Tool calling": "Tools"
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
  function pickVerb(phase) {
    var pool = phase === "plan" ? PLAN_VERBS : IDLE_VERBS;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  /* Extension features, not skills. `/` lists the workspace's SKILL.md files
     first and these underneath - see slashItems(). `/skill:` is gone: every
     skill now has its own row, which is what it was a stand-in for. */
  var CMDS = [
    ["/clear", "Clear conversation history"],
    ["/doctor", "Run TLS connection diagnostics"],
    ["/endpoints", "Manage endpoint profiles"],
    ["/model", "Select a model"],
    ["/review", "Review current changes"],
    ["/checkpoint", "Restore a previous checkpoint"],
    ["/skills", "Open the skills panel"],
    ["/help", "Show available commands"]
  ];

  var REVIEW_PROMPT =
    "Review the changes currently in the workspace. Read the modified files, " +
    "summarise what changed, and flag anything risky or inconsistent.";

  var EP_ICON = {
    anthropic: "i-kx", "openai-compatible": "i-globe", azure: "i-globe",
    local: "i-monitor", custom: "i-globe", raw: "i-globe", openai: "i-globe"
  };

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
    running: false,
    phase: "act",
    endpoint: null,
    profiles: [],
    skills: [],
    skillWarnings: [],
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
    models: [],
    /* local-only */
    tab: "session",
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
          '<span class="kx-wordmark">Kryptonite</span><span class="sp"></span>' +
          // The running token count used to sit here. It was the one thing in
          // the panel that changed on every frame, in the one strip that should
          // hold still, and it said nothing the footer meter does not already
          // say next to the number it fills. What is left is an ornament that
          // separates the identity from the controls.
          icon("i-facet", "kx-mark") +
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
          // MCP earns a tab now that it is real. 1a had a "SOON" placeholder,
          // which the review deleted; 1b replaces it with the live surface.
          '<button class="kx-tab" id="tabMcp" role="tab" aria-selected="false" aria-controls="viewMcp">MCP<span class="tab-count" id="mcpCount" hidden></span></button>' +
          '<button class="kx-tab" id="tabDiag" role="tab" aria-selected="false" aria-controls="viewDiag">Diagnostics<span class="tab-count" id="tabCount" hidden></span></button>' +
        '</nav>' +
        '<div class="plan-banner" id="planBanner" hidden>' +
          '<span class="dot"></span><span class="lbl">Plan phase</span>' +
          '<span class="sub">read-only tools · no edits applied</span>' +
        '</div>' +
        '<section class="view" id="viewSession" role="tabpanel" aria-labelledby="tabSession">' +
          // The conversation's name. Placeholder until the model has been asked
          // for a real one, so the strip never appears and disappears.
          '<div class="convo-title" id="convoTitle" hidden></div>' +
          '<div id="log" aria-live="polite"></div>' +
          '<div class="composer-wrap">' +
            '<div class="qp" id="qp" role="listbox" hidden></div>' +
            '<div class="composer">' +
              '<div class="sel-pill" id="selPill" hidden>' + icon("i-file", "ic-13") +
                '<span id="selText"></span><span class="sp"></span>' +
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
              '<textarea id="draft" rows="1" aria-label="Message" placeholder="Ask Kryptonite anything…   ( / skills · @ files )"></textarea>' +
              '<div class="toolbar">' +
                // #4 - the control row carries controls only. The keycap that
                // used to sit here was chrome describing chrome; the shortcut
                // lives in the group's accessible name and the tooltip, where a
                // keyboard user finds it and everyone else is not taxed for it.
                '<div class="seg" id="phaseSeg" role="group" title="Shift+Tab to switch phase"' +
                  ' aria-label="Phase - press Shift+Tab to switch">' +
                  '<button data-phase="plan" data-on="0">Plan</button>' +
                  '<button data-phase="act" data-on="1">Act</button>' +
                '</div>' +
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
        '<section class="view" id="viewMcp" role="tabpanel" aria-labelledby="tabMcp" hidden>' +
          '<div class="mcp-wrap" id="mcpBody"></div>' +
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
      '<span class="badge" id="' + badgeId + '">-</span></button>' +
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
     single message - the old list showed only a title and a timestamp, which
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

  /* Three tabs now, so the two-way boolean became a table. */
  var TABS = [
    ["session", "tabSession", "viewSession"],
    ["mcp", "tabMcp", "viewMcp"],
    ["diagnostics", "tabDiag", "viewDiag"]
  ];

  function setTab(tab) {
    S.tab = tab;
    for (var i = 0; i < TABS.length; i++) {
      var on = TABS[i][0] === tab;
      $(TABS[i][1]).setAttribute("aria-selected", on ? "true" : "false");
      $(TABS[i][2]).hidden = !on;
    }
    if (tab === "mcp") renderMcp();
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
    return el;
  }
  function clearTranscript() {
    if (aiPaint) { clearTimeout(aiPaint); aiPaint = null; }
    if (aiFrame) { cancelAnimationFrame(aiFrame); aiFrame = 0; }
    logEl.innerHTML = "";
    aiEl = null; streamEl = null; pendingTool = null; todoEl = null; toolGroup = null;
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

  function addUser(content, files) {
    closeToolGroup();
    var att = attChips(files);
    if (typeof content === "string") {
      add(div("msg-user", '<div class="u-body">' + esc(content) + att + "</div>"));
      return;
    }
    if (!Array.isArray(content)) {
      add(div("msg-user", '<div class="u-body">' + esc(String(content)) + att + "</div>"));
      return;
    }
    var html = "";
    for (var i = 0; i < content.length; i++) {
      var b = content[i];
      if (b.type === "image") {
        html += '<img class="msg-img" src="data:' + esc(b.mediaType) + ';base64,' + b.data + '" alt="attached image">';
      } else if (b.type === "text") {
        html += "<span>" + esc(b.text) + "</span>";
      }
    }
    add(div("msg-user", '<div class="u-body">' + html + att + "</div>"));
  }

  /* Re-rendering the answer is throttled, because it costs the whole message.
   *
   * `md()` parses from scratch and innerHTML replaces the subtree, so doing it
   * per delta is O(n²) in the number of deltas. Measured in the harness at a
   * constant payload: 50 deltas took 8ms, 100 took 436ms, 200 took 2.4s and 400
   * took 10s - each doubling roughly quadrupling. Real streaming arrives token
   * by token, so a long reply meant thousands of deltas and a locked panel.
   *
   * Text still accumulates on every delta; only the paint is coalesced. At 50ms
   * that is twenty repaints a second, which reads as continuous, and the cost
   * becomes a function of elapsed time rather than of delta count. */
  var aiPaint = null;

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

  function paintAi() {
    if (!aiEl) return;
    var full = aiEl._raw || "";
    var shown = aiEl._shown || 0;
    if (shown === full.length) return;
    // Measured before the content grows, not after. A coalesced paint adds a
    // screenful at once, so checking afterwards always reads as "the user has
    // scrolled up" and autoscroll silently stops following the answer.
    var stick = atBottom();
    aiEl._shown = full.length;
    aiEl.innerHTML = md(full);
    if (stick) scroll();
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
    aiEl._shown = next;
    aiEl.innerHTML = md(full.slice(0, next));
    if (stick) scroll();

    if (next < full.length) aiFrame = requestAnimationFrame(typeStep);
  }

  /** Reveal everything immediately. Used at turn end and before reordering. */
  function flushAi() {
    if (aiPaint) { clearTimeout(aiPaint); aiPaint = null; }
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
    el.innerHTML = md(text);
    return el;
  }

  function appendAi(text) {
    if (!aiEl) {
      // Prose after a run of tools ends the strip - the model has stopped
      // working and started explaining.
      closeToolGroup();
      aiEl = add(div("msg-ai", ""));
      aiEl._raw = "";
      aiEl._shown = 0;
      aiEl._done = false;
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
      '<button class="tool-head">' + icon("i-chev", "ic-9 chev") +
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
    if (preview) body.appendChild(preview);
    else if (text) body.appendChild(resultBlock(text, name));
    if (text.length > MODEL_TRUNCATION) {
      body.appendChild(div("trunc-note",
        icon("i-warn", "ic-11") + "<span>Output truncated to 60,000 characters for the model</span>"));
    }
    if (isError) {
      el.setAttribute("data-open", "1");
      body.hidden = false;
    }
    // Back to the turn's own verb, not a fresh one - the work has not changed.
    S.gerund = S.idleVerb || "Thinking…";
    tickGerund();
  }

  /**
   * Large results are assigned as a single textContent write. Splitting them
   * per line would build tens of thousands of nodes and lock the webview.
   */
  function resultBlock(text, name) {
    var wrap = document.createElement("div");
    // Shell output wraps and reads as a console; file contents stay a snippet.
    var pre = div(name === "run_command" ? "term-block" : "code-block");
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

  function addDiff(m) {
    aiEl = null;
    closeToolGroup();
    var rows = pairWords(parsePatch(m.patch)), body = "";
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
    closeToolGroup();
    todoEl = add(div("card", html));
  }

  function addPermission(m) {
    aiEl = null;
    closeToolGroup();
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

  /**
   * The Overload aura: spinning radiation rays, three frame-swapped ki bands,
   * a shockwave ring and three rising embers, all behind a crystal that never
   * moves. Every layer is a bare span positioned by CSS - the markup carries
   * no geometry so the whole composition can be retuned in sidebar.css alone.
   */
  function auraMarkup() {
    return '<span class="rad">' +
      '<span class="rays"></span>' +
      '<span class="ki ki1"></span><span class="ki ki2"></span><span class="ki ki3"></span>' +
      '<span class="shock"></span>' +
      '<span class="em em1"></span><span class="em em2"></span><span class="em em3"></span>' +
      crystal(21, "crystal") + "</span>";
  }

  function startStream() {
    if (!streamEl) {
      streamEl = add(div("stream", auraMarkup() + '<span class="g"></span><span class="m"></span>'));
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
    flushAi();
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
  function endTurn() {
    closeToolGroup();
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
      } else if (a === "retry") post("sendMessage", { text: "Retry that last step." });
      else if (a === "branch") post("newChat");
    });
    add(foot);
    add(div("turn-div"));
  }

  /* ───────────────────────── composer ───────────────────────── */

  function syncComposer() {
    var draft = $("draft");
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
    draft.placeholder = blocked
      ? "Configure an endpoint first…"
      : S.phase === "plan"
        ? "Describe what to plan…   ( / skills · @ files )"
        : "Ask Kryptonite anything…   ( / skills · @ files )";

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
    $("atBtn").disabled = blocked;
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
  function slashItems(q) {
    var rows = [];
    // An empty q matches every name, so this is also the "just typed /" case.
    var skills = S.skills.filter(function (s) {
      return s.enabled && s.name.toLowerCase().indexOf(q) === 0;
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
    var cmds = CMDS.filter(function (c) { return c[0].slice(1).indexOf(q) === 0; });
    if (cmds.length) {
      rows.push({ group: "Commands" });
      for (var j = 0; j < cmds.length; j++) {
        rows.push({ cmd: cmds[j][0], desc: cmds[j][1] });
      }
    }
    return rows;
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
      var suffix = r.badge === "folder" ? "/ " : " ";
      draft.value = draft.value.replace(/@([\w./-]*)$/, "@" + r.file + suffix);
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
    if (!S.workspace.open) { addError("Open a folder first."); return; }
    if (!hasEndpoint()) { addError("Select an endpoint profile first."); return; }
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

  function addError(message) {
    aiEl = null;
    closeToolGroup();
    add(div("err-box", icon("i-warn", "ic-13") + "<span>" + esc(message) + "</span>"));
    return;
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

  function renderFooter() {
    var used = S.context ? S.context.used : 0;
    var limit = S.context ? S.context.limit : 0;
    // A figure is printed only when the gateway reported real token usage.
    // The fallback is a chars/3.6 estimate that drifts about a tenth of a k
    // per message, and a number that is quietly wrong is worse than the meter
    // alone - so when it is not exact, only the meter speaks.
    var exact = S.context ? S.context.exact === true : false;
    $("ctxText").textContent = exact ? fmtK(used) + " / " + fmtK(limit) : "";
    $("ctxText").title = exact ? "Reported by the endpoint" : "";
    var pct = limit ? Math.min(100, (used / limit) * 100) : 0;
    $("ctxFill").style.width = pct + "%";
    // Sky while the bar is only a reading; amber and then coral once the
    // number stops being information and starts being a problem.
    $("ctxFill").setAttribute("data-level", pct >= 90 ? "full" : pct >= 75 ? "warn" : "ok");

    var active = activeProfile();
    var name = active ? active.id : "No endpoint";
    $("epName").textContent = S.tlsError ? name + " - TLS error" : name;
    $("epInd").setAttribute("data-err", S.tlsError ? "1" : "0");
    $("modelName").textContent = active ? active.model : "No model";
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
    var tc = $("tabCount");
    tc.textContent = failing ? String(failing) : "";
    tc.hidden = !failing;

    var html = "";
    if (!e) {
      if (!S.traceRun && !S.rungs.length) {
        html += '<div class="ok-state"><p>No trace yet - run diagnostics to check the connection.</p>' +
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

  function rungRow(name, status, detail, fix, ms) {
    return '<div class="rung" data-s="' + esc(status) + '">' +
      '<span class="rail"><span class="node"></span></span>' +
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
      '<circle class="a2" cx="12" cy="12" r="6.5" stroke="var(--kx-mcp)" stroke-width="2.5" ' +
        'stroke-linecap="round" stroke-dasharray="10 31"/>' +
      '<circle class="a3" cx="12" cy="12" r="3" stroke="var(--kx-active)" stroke-width="2.5" ' +
        'stroke-linecap="round" stroke-dasharray="5 14"/>' +
      "</svg>";
  }

  function mcpPill(state) {
    if (state === "ready") return '<span class="mcp-pill ok">' + icon("i-check", "ic-9") + "connected</span>";
    if (state === "starting") return '<span class="mcp-pill">starting…</span>';
    if (state === "stopped") return '<span class="mcp-pill">stopped</span>';
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

    var head = '<div class="mcp-head">' +
      "<span class=\"l\">Servers</span>" +
      '<span class="when">' + (servers.length ? "· " + servers.length + " configured" : "") + "</span>" +
      '<span class="sp"></span>' +
      '<button class="btn sm" data-mcp="reload">' + icon("i-refresh", "ic-13") + "<span>Reload</span></button>" +
      '<button class="btn sm" data-mcp="open">Edit config</button>' +
      "</div>";

    if (m.warnings && m.warnings.length) {
      head += '<div class="warn-line" style="padding:0 16px 10px">' + esc(m.warnings.join(" ")) + "</div>";
    }

    if (!servers.length) {
      body.innerHTML = head +
        '<div class="mcp-empty">' +
        "<p>No MCP servers configured.</p>" +
        '<p class="s">Declare them in <code>.agent/mcp.json</code>, in the same shape Claude Desktop uses. ' +
        "Their tools reach the model as <code>mcp__server__tool</code>, and are withheld in Plan mode.</p>" +
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
        '<span class="rail"></span>' +
        '<span class="mid">' +
          '<span class="top"><span class="nm">' + esc(sv.name) + "</span>" + mcpPill(sv.state) + "</span>" +
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
        var chips = shown.map(function (t) { return '<span class="mcp-chip">' + esc(t) + "</span>"; }).join("");
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
    var el = $("mcpCount");
    if (!el) return;
    var servers = (S.mcp && S.mcp.servers) || [];
    var down = 0;
    for (var i = 0; i < servers.length; i++) if (servers[i].state === "failed") down++;
    // Same rule as Diagnostics: a count, and only when something is wrong.
    el.textContent = down ? String(down) : "";
    el.hidden = !down;
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
          ? ' style="background:var(--kx-accent);border-color:var(--kx-accent);color:var(--vscode-sideBar-background)"'
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
        var res = resultFor[call.id];
        if (res) el.querySelector(".tool-body").appendChild(resultBlock(res, call.name));
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

  function hydrate(state) {
    S.workspace = state.workspace;
    S.running = state.running;
    S.phase = state.phase;
    S.endpoint = state.endpoint;
    S.profiles = state.profiles || [];
    S.skills = state.skills || [];
    S.skillWarnings = state.skillWarnings || [];
    S.mcp = state.mcp || { servers: [], warnings: [] };
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
    S.title = state.session ? state.session.title : "";

    applyPhase(S.phase, true);
    renderSession(state.session ? state.session.messages : []);
    todoEl = null;
    renderTodos(S.todos);
    renderSelection();
    // Survives a full re-render: the host pushes this on its own schedule, so
    // a stateSync that dropped it would blank the chip until the cursor next
    // moved, which on a still editor could be a long time.
    renderEditorChip();
    renderTitle();
    renderFooter();
    renderTls();
    renderEndpoints();
    renderSkills();
  renderMcp();
  renderMcpCount();
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
      var bytes = new TextEncoder().encode(text);
      var b64 = "";
      // Chunked, because String.fromCharCode.apply on a large array overflows
      // the argument list.
      for (var k = 0; k < bytes.length; k += 8192) {
        b64 += String.fromCharCode.apply(null, bytes.subarray(k, k + 8192));
      }
      var ok = addAttachment({
        name: pasteName("text/plain"),
        mediaType: "text/plain",
        data: btoa(b64),
        size: bytes.length,
      });
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
    // Pay the connection, credential, and prompt-cache costs of the next turn
    // while the user is still typing, instead of after they press Enter. The
    // host debounces this and ignores it while a turn is running.
    draft.addEventListener("focus", function () { post("warm"); });

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
    // On the textarea rather than the document, so a paste into some other
    // field cannot silently become an attachment.
    draft.addEventListener("paste", onPaste);
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
      if (e.key === "Escape" && S.running && $("qp").hidden) post("interrupt");
    });

    $("tlsBody").addEventListener("click", onTlsClick);
    $("epBody").addEventListener("click", onEpClick);
    $("skBody").addEventListener("click", onSkillClick);
    $("mcpBody").addEventListener("click", onMcpClick);
    $("tabMcp").addEventListener("click", function () { setTab("mcp"); });
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
      S.epForm = {
        isNew: true, id: "", name: "", url: "", type: "openai-compatible",
        model: "", chatPath: "", apiKey: "", hasStoredKey: false,
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
      var form = epPayload(readEpForm());
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
      model: f.model || "", chatPath: f.chatPath || "",
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
        break;

      case "turnEnd":
        S.running = false;
        endStream();
        endTurn();
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
        // A reload can land while the form is open (the file watcher fires on
        // every save). Snapshot first so it re-renders with what was typed.
        readEpForm();
        renderEndpoints();
        renderFooter();
        syncComposer();
        if (logEl.querySelector(".welcome")) renderWelcome();
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

      case "inputAccepted": {
        // Confirms the message was taken rather than swallowed. Without this
        // the composer clears and nothing visibly happens, which reads as the
        // message having been lost.
        S.pending = m.depth;
        var word = m.mode === "steer"
          ? "Sent to the model - it will read this before its next step."
          : m.depth > 1
            ? m.depth + " messages queued for when this turn finishes."
            : "Queued - it will be sent when this turn finishes.";
        var note = div("queued-note", icon(m.mode === "steer" ? "i-up" : "i-clock", "ic-11") +
          "<span>" + esc(word) + "</span>");
        add(note);
        break;
      }

      case "steerAccepted":
        // It is a user turn: the reply after it was written knowing it.
        addUser(m.text);
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
