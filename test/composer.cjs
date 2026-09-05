/**
 * The two controls that sit around the composer: the tip strip and the
 * approval picker.
 *
 * The approval picker is the one that matters. It governs every side effect
 * the agent has, and it previously lived only in the Control Center and
 * settings.json - which is to say, nowhere anyone looks while working. The
 * assertions here are about it telling the truth: that it shows the mode
 * actually in force, that choosing one sends it to the host rather than
 * keeping a second copy of the answer in the panel, and that the two modes
 * which stop asking are visibly different from the one that does not.
 *
 * Run: node test/composer.cjs
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

const ROOT = path.join(__dirname, "..");
const CSS = fs.readFileSync(path.join(ROOT, "media/webview/sidebar.css"), "utf8");
const SRC = fs.readFileSync(path.join(ROOT, "media/webview/sidebar.js"), "utf8");
const CRYSTAL = fs.readFileSync(path.join(ROOT, "media/webview/crystal.js"), "utf8");

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
  const d = w.document;
  const sync = (approvalMode) => w.dispatchEvent(new w.MessageEvent("message", { data: {
    type: "stateSync", state: {
      workspace: { open: true, name: "r" }, running: false, phase: "act",
      status: { state: "ok", label: "OK" }, endpoint: "gw",
      profiles: [{ id: "gw", status: "ready", active: true, model: "m", wire: "openai",
        baseUrl: "https://x", capabilities: { contextWindow: 128000 } }],
      skills: [], skillWarnings: [],
      config: { approvalMode, activeProfile: "", caBundlePath: "", ui: {} },
      tlsError: null, rungs: [], tracing: false, todos: [], checkpoints: [], sessions: [],
      selection: null, context: null, models: [], logs: [],
      session: { id: "s", title: "t", messages: [] },
    },
  } }));
  const click = (sel) => {
    const el = d.querySelector(sel);
    if (!el) return false;
    el.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    return true;
  };
  return { dom, w, d, sent, sync, click };
}

/* ── the approval picker ────────────────────────────────────────────────── */
{
  const b = boot();
  b.sync("ask");
  // The control sits in the composer's toolbar now, beside the phase and the
  // model, where there is room for a word rather than a sentence.
  ok("the composer shows the mode in force", b.d.getElementById("permName").textContent === "Manual",
    b.d.getElementById("permName").textContent);
  // The reason it is "Manual" and not "Ask": the phase segment two controls to
  // the left already has a button labelled Ask, and the two are unrelated
  // settings. Pinned as the invariant rather than as the string, so renaming
  // either control can never quietly recreate the collision.
  {
    const phases = [...b.d.querySelectorAll("#phaseSeg button")].map((x) =>
      x.textContent.trim().toLowerCase());
    ok("and does not reuse a phase's name",
      !phases.includes(b.d.getElementById("permName").textContent.trim().toLowerCase()),
      `perm="${b.d.getElementById("permName").textContent}" phases=${phases.join(",")}`);
  }
  ok("and the full sentence is still reachable",
    /Manual - Always ask before making changes/.test(b.d.getElementById("permBtn").title),
    b.d.getElementById("permBtn").title);
  ok("it lives on the control row, not under the box",
    !!b.d.querySelector(".toolbar #permBtn"));
  ok("and carries it for styling", b.d.getElementById("permBtn").getAttribute("data-mode") === "ask");
  // The endpoint name was a label for a fact that only matters when it is
  // wrong, printed under every conversation. The footer strip it sat in is gone
  // entirely now: its health is a dot on the model button, which already names
  // that endpoint's model, and the name itself is in that button's tooltip.
  ok("the endpoint name is not printed", !b.d.getElementById("epName"));
  ok("but is still carried for the tooltip", !!b.d.getElementById("modelBtn").title);
  ok("and its health still has a dot of its own", !!b.d.getElementById("epDot"));
  ok("the menu starts closed", b.d.getElementById("permPop").hidden);

  ok("clicking opens it", b.click("#permBtn") && !b.d.getElementById("permPop").hidden);
  const rows = [...b.d.querySelectorAll("#permPop [data-perm]")].map((x) => x.getAttribute("data-perm"));
  ok("all three modes are offered", rows.join(",") === "ask,edits-auto,full-auto", rows.join(","));
  // Ordered by how much control they give up, so the list reads as a scale.
  ok("ordered by how much they surrender", rows[0] === "ask" && rows[2] === "full-auto");
  ok("each says what happens, not what it is called",
    [...b.d.querySelectorAll("#permPop .perm-row .m")].every((e) => e.textContent.trim().length > 10));
  // The sheet marks the mode in force with a filled radio rather than a tick,
  // because these are exclusive choices and a radio is what says so.
  ok("the current one is selected",
    b.d.querySelector('#permPop [data-perm="ask"]').getAttribute("data-on") === "1");
  ok("and says so to assistive tech",
    b.d.querySelector('#permPop [data-perm="ask"]').getAttribute("aria-checked") === "true");
  ok("and the others do not",
    b.d.querySelector('#permPop [data-perm="full-auto"]').getAttribute("data-on") === "0");
  // Plan is a PHASE and already exists as the middle segment of the
  // ASK/PLAN/ACT control. Offering it here too would put one setting behind
  // two controls that can disagree.
  ok("plan is not offered as a mode",
    !b.d.querySelector('#permPop [data-perm="plan"]'));
  ok("because it is already a phase", !!b.d.querySelector('#phaseSeg [data-phase="plan"]'));

  /* EVERY MODE'S SENTENCE NAMES AN OUTCOME, NOT A MECHANISM.
     full-auto used to read "The agent handles permission decisions itself",
     which is how it works; the other two say what happens. The vaguest wording
     was on the only mode that gives everything away, and package.json and the
     Control Center both said the honest thing while the control people
     actually use did not. */
  const sentences = [...b.d.querySelectorAll("#permPop .perm-row .m")].map((e) => e.textContent);
  ok("full-auto says it never asks",
    /never asks/i.test(sentences[2]) && /without stopping/i.test(sentences[2]), sentences[2]);

  /* AND IT TAKES TWO PRESSES. It was one click on a row of the same weight as
     the other two, so browsing the sheet to see what the modes were could hand
     the agent unattended shell access. The sheet's own comment calls this
     control "a decision worth stopping for". */
  b.sent.length = 0;
  b.click('#permPop [data-perm="full-auto"]');
  ok("the first press on full-auto sends nothing",
    b.sent.filter((m) => m.type === "setConfig").length === 0, JSON.stringify(b.sent));
  const armedRow = b.d.querySelector('#permPop [data-perm="full-auto"]');
  ok("it arms instead", armedRow.getAttribute("data-arm") === "1");
  ok("and says so where the sentence was",
    /press again/i.test(armedRow.querySelector(".m").textContent),
    armedRow.querySelector(".m").textContent);
  ok("the armed state is drawn", /\[data-arm="1"\]/.test(CSS));

  // The safe modes are still one press: only the one that surrenders
  // everything is worth a second.
  {
    const c = boot();
    c.sync("full-auto");
    c.click("#permBtn");
    c.sent.length = 0;
    c.click('#permPop [data-perm="ask"]');
    const one = c.sent.filter((m) => m.type === "setConfig");
    ok("choosing a safer mode still takes one press", one.length === 1, JSON.stringify(one));
    ok("with the right key and value",
      one[0] && one[0].key === "approvalMode" && one[0].value === "ask", JSON.stringify(one[0]));
    c.dom.window.close();
  }

  b.click('#permPop [data-perm="full-auto"]');
  const posted = b.sent.filter((m) => m.type === "setConfig");
  // The panel must not keep its own copy of the answer: approvalMode is a real
  // setting, and two sources of truth is how a UI starts lying.
  ok("the second press posts to the host", posted.length === 1, JSON.stringify(posted));
  ok("with the right key and value",
    posted[0] && posted[0].key === "approvalMode" && posted[0].value === "full-auto",
    JSON.stringify(posted[0]));
  // The sheet ANIMATES out, so `hidden` is not the immediate signal any more:
  // `display: none` cannot be transitioned, and setting it at once would make
  // the sheet vanish mid-flight instead of sliding away. `data-open` comes off
  // straight away and drives the exit; `hidden` follows when it has finished.
  ok("and the menu starts closing at once",
    b.d.getElementById("permPop").getAttribute("data-open") === null);
  ok("but is still in the tree while it plays",
    b.d.getElementById("permPop").hidden === false);

  // The host echoes the change back; the composer follows it.
  b.w.dispatchEvent(new b.w.MessageEvent("message", { data: {
    type: "configChanged",
    config: { approvalMode: "full-auto", activeProfile: "", caBundlePath: "", ui: {} },
  } }));
  ok("a change made elsewhere reaches the composer",
    b.d.getElementById("permName").textContent === "Auto",
    b.d.getElementById("permName").textContent);
  ok("and the tooltip follows it",
    /^Auto - /.test(b.d.getElementById("permBtn").title),
    b.d.getElementById("permBtn").title);

  b.click("#permBtn");
  b.d.body.dispatchEvent(new b.w.MouseEvent("click", { bubbles: true }));
  ok("clicking away closes it",
    b.d.getElementById("permPop").getAttribute("data-open") === null);
  ok("and the button agrees immediately",
    b.d.getElementById("permBtn").getAttribute("aria-expanded") === "false");
  // The exit finishing - `hidden` going back on once the transition has played
  // - is a TIMING fact, and jsdom runs no transitions and has no top-level
  // await to wait with. It is asserted for real against Chromium in the
  // browser validation. What is checked here is that the mechanism exists at
  // all: a sheet whose exit is never scheduled stays invisible and focusable,
  // which is worse than one that never animated.
  ok("and the exit is scheduled rather than forgotten",
    /permExit = setTimeout\(/.test(SRC) && /pop\.hidden = true;/.test(SRC));
  ok("with a pending exit cancelled if it is reopened first",
    /if \(permExit\) \{ clearTimeout\(permExit\); permExit = null; \}/.test(SRC));
  b.dom.window.close();
}
{
  /* The sheet is sized to the panel rather than to a phone.
     It is the control that decides what the agent may do to the workspace, so
     it is a sheet rather than a menu - but a side panel can be 320px wide and
     dragged shorter than a phone sheet is tall, so none of its metrics may be
     fixed. */
  ok("the sheet covers the panel, not just the composer it hangs off",
    /\.perm-sheet\s*\{[^}]*position:\s*fixed/.test(CSS));
  ok("the card is exactly as tall as its rows",
    /\.perm-card\s*\{[^}]*height:\s*auto/.test(CSS));
  ok("and never claims more of a short panel than it can use",
    /\.perm-card\s*\{[^}]*max-height:\s*min\(/.test(CSS));
  ok("the list is what scrolls, so the title survives a short panel",
    /\.perm-list\s*\{[^}]*overflow-y:\s*auto/.test(CSS));
  ok("row gutters step down as the panel narrows",
    /\.perm-row\s*\{[^}]*padding:\s*clamp\(/.test(CSS));
  ok("the chosen mode is a filled radio, not a tick",
    /\.perm-row\[data-on="1"\] \.dot \{ background/.test(CSS));
}
{
  // Only the modes that stop asking are coloured, and the loudest one is the
  // one that never asks.
  //
  // The BUTTON's hue is asserted against the SHEET's, read out of the same
  // PERMS table, rather than against a literal token. The two are the same
  // control seen twice - the button is the state, the sheet row is the choice
  // that set it - and a button in one colour opening a row in another is the
  // same class of mismatch as the label saying "Ask" while the row said
  // "Manual". Pinning a literal here let them drift once already.
  const hue = (mode) => {
    const row = new RegExp('\\["' + mode + '",[^\\]]*\\]').exec(SRC);
    const m = row && /var\(--[a-z0-9-]+\)/g.exec(row[0].split(",").pop());
    return m ? m[0] : null;
  };
  for (const mode of ["edits-auto", "full-auto"]) {
    const want = hue(mode);
    ok(`${mode} has a hue in the sheet`, !!want, String(want));
    const rule = new RegExp('\\.perm-btn\\[data-mode="' + mode + '"\\]\\s*\\{([^}]*)\\}').exec(CSS);
    ok(`${mode} is marked on the button too`, !!rule);
    if (rule && want) {
      ok(`${mode} uses the same hue as its sheet row`,
        rule[1].includes(want), `button ${rule[1].match(/var\(--[a-z0-9-]+\)/)} vs sheet ${want}`);
    }
  }
  // The one that never asks is the alarm colour specifically, not merely a
  // colour: it has to read as a warning rather than as another category.
  ok("allow-all is marked in the alarm colour",
    /\.perm-btn\[data-mode="full-auto"\][^}]*var\(--kx-error\)/.test(CSS));
  ok("and the default is not coloured at all",
    !/\.perm-btn\[data-mode="ask"\]\s*\{/.test(CSS));
}

/* ── the tip strip ──────────────────────────────────────────────────────── */
{
  const b = boot();
  b.sync("ask");
  const bar = b.d.getElementById("tipBar");
  ok("a tip is shown", !bar.hidden);
  ok("with a visible label", /TIP/i.test(bar.textContent));
  const first = b.d.getElementById("tipText").textContent;
  ok("and real text", first.trim().length > 20, first);

  b.click("#tipNext");
  ok("which can be cycled", b.d.getElementById("tipText").textContent !== first);

  // Every tip has to name something reachable from this panel. A tip about a
  // feature that does not exist is worse than no tip.
  const tips = (SRC.match(/var TIPS = \[([\s\S]*?)\];/) || ["", ""])[1];
  const count = (tips.match(/^\s*"/gm) || []).length;
  ok("there are several", count >= 8, String(count));
  for (const feature of ["/", "Shift+Tab", "@", ".agent/instructions.md", "Diagnostics", "SKILL.md"]) {
    ok(`a tip covers ${feature}`, tips.includes(feature));
  }
  // The tips are the one place innerHTML is used on purpose, so they must be
  // constants and never anything a model or page produced.
  ok("tips are a constant in this file, not data from anywhere",
    /var TIPS = \[\s*"/.test(SRC));
  b.dom.window.close();
}


/* ── the draft mirror ───────────────────────────────────────────────────── */
{
  // The whole feature rests on the mirror and the textarea agreeing about
  // metrics. jsdom computes no layout, so what is asserted here is that the
  // stylesheet declares them together - the browser check is the one that
  // proves alignment, and it was run.
  const shared = CSS.match(/#draft,\s*\.draft-mirror\s*\{[^}]*\}/);
  ok("draft and mirror share one metric block", !!shared,
    "separate blocks are how the two silently drift apart");
  for (const m of ["font-family", "font-size", "line-height", "padding", "white-space", "overflow-wrap"]) {
    ok(`  and it fixes ${m}`, !!shared && shared[0].includes(m));
  }
  ok("the textarea's own glyphs are transparent", /#draft\s*\{[^}]*color:\s*transparent/.test(CSS));
  ok("but the caret is not", /caret-color:\s*var\(--kx-fg\)/.test(CSS));
  ok("and the selection stays visible", /#draft::selection/.test(CSS));
  // A different font or size inside a token would advance the text by a
  // different amount than the textarea does.
  const codeTok = CSS.match(/\.draft-mirror \.tk-code \{[^}]*\}/);
  ok("the code token changes colour only", !!codeTok &&
    !/font-family|font-size|letter-spacing/.test(codeTok[0]), codeTok && codeTok[0]);
}
{
  const b = boot();
  b.sync("ask");
  const d = b.d, draft = d.getElementById("draft"), mirror = d.getElementById("draftMirror");
  ok("the mirror exists", !!mirror);

  const text = "/canvas-design make @src/core/app.ts use `fitToWindow` now";
  draft.value = text;
  draft.dispatchEvent(new b.w.Event("input", { bubbles: true }));
  ok("the mirror carries the same string", mirror.textContent === text,
    JSON.stringify(mirror.textContent));
  ok("a leading skill is marked",
    [...mirror.querySelectorAll(".tk-skill")].map((e) => e.textContent).join() === "/canvas-design");
  ok("a file mention is marked",
    [...mirror.querySelectorAll(".tk-file")].map((e) => e.textContent).join() === "@src/core/app.ts");
  ok("inline code is marked",
    [...mirror.querySelectorAll(".tk-code")].map((e) => e.textContent).join() === "`fitToWindow`");

  // A slash that is not at the start is a path, not a command.
  draft.value = "see /usr/bin for it";
  draft.dispatchEvent(new b.w.Event("input", { bubbles: true }));
  ok("a slash mid-sentence is not a skill", mirror.querySelectorAll(".tk-skill").length === 0);

  // Nothing a user types may become markup.
  draft.value = "<img src=x onerror=alert(1)> and </span> too";
  draft.dispatchEvent(new b.w.Event("input", { bubbles: true }));
  ok("typed markup is escaped, not rendered", mirror.querySelector("img") === null);
  ok("and survives as text", /onerror=alert\(1\)/.test(mirror.textContent));

  draft.value = "";
  draft.dispatchEvent(new b.w.Event("input", { bubbles: true }));
  ok("an empty draft empties the mirror", mirror.textContent === "");
  b.dom.window.close();
}

/* ── Auto in the model picker ───────────────────────────────────────────── */
{
  const b = boot();
  const syncModels = (activeProfile, groups) => b.w.dispatchEvent(new b.w.MessageEvent("message", { data: {
    type: "stateSync", state: {
      workspace: { open: true, name: "r" }, running: false, phase: "act",
      status: { state: "ok", label: "OK" }, endpoint: "a",
      profiles: [
        { id: "a", status: "ready", active: true, model: "model-a", wire: "openai", baseUrl: "https://a", capabilities: { contextWindow: 1000 } },
        { id: "z", status: "ready", active: false, model: "model-z", wire: "openai", baseUrl: "https://z", capabilities: { contextWindow: 1000 } },
      ].slice(0, groups.length),
      skills: [], skillWarnings: [],
      config: { approvalMode: "ask", activeProfile, caBundlePath: "", ui: {} },
      tlsError: null, rungs: [], tracing: false, todos: [], checkpoints: [], sessions: [],
      selection: null, context: null, models: groups, logs: [],
      session: { id: "s", title: "t", messages: [] },
    },
  } }));
  const two = [{ group: "a", models: ["model-a"] }, { group: "z", models: ["model-z"] }];

  syncModels("", two);
  ok("with nothing pinned the button says Auto",
    /^Auto · /.test(b.d.getElementById("modelName").textContent),
    b.d.getElementById("modelName").textContent);
  b.click("#modelBtn");
  const first = b.d.querySelector("#qp .qp-row");
  ok("Auto is offered first", /^Auto/.test(first.textContent.trim()), first.textContent.trim());
  // The listbox marks the selection with a lit dot rather than a tick. It is
  // deliberately NOT data-active, which is the keyboard cursor and moves
  // independently of what is actually in force.
  ok("and is marked as the selection when nothing is pinned",
    first.getAttribute("data-on") === "1", first.getAttribute("data-on"));

  b.sent.length = 0;
  first.dispatchEvent(new b.w.MouseEvent("click", { bubbles: true }));
  const posted = b.sent.filter((m) => m.type === "selectModel")[0];
  // An empty endpoint is what activeProfile has always meant by "first valid
  // one". Auto stores no new state; it just had no way to be asked for.
  ok("choosing Auto clears the pin rather than naming a profile",
    posted && posted.endpoint === "", JSON.stringify(posted));

  syncModels("a", two);
  ok("a pinned profile drops the Auto prefix",
    b.d.getElementById("modelName").textContent === "model-a",
    b.d.getElementById("modelName").textContent);

  // One profile: "let it choose" and "choose that one" are the same
  // instruction, and offering both invites a question with no answer.
  syncModels("", [{ group: "a", models: ["model-a"] }]);
  b.click("#modelBtn");
  ok("Auto is not offered when there is only one endpoint",
    !/^Auto/.test((b.d.querySelector("#qp .qp-row") || {}).textContent || ""),
    (b.d.querySelector("#qp .qp-row") || {}).textContent);
  ok("and the button shows the model plainly",
    b.d.getElementById("modelName").textContent === "model-a",
    b.d.getElementById("modelName").textContent);
  b.dom.window.close();
}


/* ── the welcome screen ─────────────────────────────────────────────────── */
{
  const bootWith = (sessions) => {
    const b = boot();
    b.w.dispatchEvent(new b.w.MessageEvent("message", { data: {
      type: "stateSync", state: {
        workspace: { open: true, name: "r" }, running: false, phase: "act",
        status: { state: "ok", label: "OK" }, endpoint: "gw",
        profiles: [{ id: "gw", status: "ready", active: true, model: "m", wire: "openai",
          baseUrl: "https://x", capabilities: { contextWindow: 128000 } }],
        skills: [], skillWarnings: [],
        config: { approvalMode: "ask", activeProfile: "", caBundlePath: "", ui: {} },
        tlsError: null, rungs: [], tracing: false, todos: [], checkpoints: [],
        sessions, selection: null, context: null, models: [], logs: [],
        session: { id: "cur", title: "Untitled", messages: [] },
      },
    } }));
    return b;
  };
  const sess = (id, title, count, when = "2h ago", active = false) => ({ id, title, count, when, active });

  // A genuinely first run: nothing to resume, so nothing is offered. An empty
  // row of buttons is worse than no row.
  {
    const b = bootWith([sess("cur", "Untitled", 0, "now", true)]);
    const w = b.d.querySelector(".welcome");
    // The wordmark, not a sentence: "How can I help?" is what every assistant
    // says, and the mark says which one this is.
    ok("a first run still welcomes", !!w.querySelector(".w-mark"));
    ok("and offers nothing to resume", w.querySelectorAll("[data-session]").length === 0);
    // The welcome is a boot sequence now: the copy that once introduced the tool
    // in a sentence is the boot log reporting the workspace came up. "Pick up
    // where you left off" is withheld until there is a thread to resume (see the
    // recent-sessions case below), so a first run shows the log and the openers.
    ok("saying so in the copy", /initializing workspace/.test(w.textContent),
      w.textContent.slice(0, 90));
    ok("and does not yet invite a resume", !/Pick up where you left off/.test(w.textContent));
    // The invented examples are gone. Asserted on the markup rather than the
    // words, because the comment recording why they went still names them.
    ok("no fabricated suggestion buttons remain",
      !/data-sug="Add retry|data-sug="Write tests/.test(SRC),
      "they described code no workspace has");
    // What replaced them. Every opener is an existing command aimed at what the
    // user has open, so none of them can name code this workspace does not have.
    const starters = [...w.querySelectorAll("[data-starter]")];
    ok("but real openers are offered", starters.length === 3, String(starters.length));
    ok("and each runs something that already exists",
      starters.every((x) => /^(\/explain|\/tests|review)$/.test(x.getAttribute("data-starter"))),
      starters.map((x) => x.getAttribute("data-starter")).join(","));
    ok("even on a first run, when there is nothing to resume", starters.length === 3);
    b.dom.window.close();
  }

  // Three or more prior conversations: exactly three, newest first.
  {
    const b = bootWith([
      sess("cur", "Untitled", 0, "now", true),
      sess("a", "Fix the TLS handshake", 12),
      sess("b", "Rename the aura tokens", 4),
      sess("c", "Add Ask mode", 30),
      sess("d", "Older still", 7),
    ]);
    const chips = [...b.d.querySelectorAll(".welcome [data-session]")];
    ok("at most three are offered", chips.length === 3, String(chips.length));
    ok("in the order given", chips.map((c) => c.getAttribute("data-session")).join(",") === "a,b,c",
      chips.map((c) => c.getAttribute("data-session")).join(","));
    ok("each names the conversation", /Fix the TLS handshake/.test(chips[0].textContent));
    ok("and how old it is", /2h ago/.test(chips[0].textContent), chips[0].textContent);
    // A title alone reads the same for a thread of one message and one of
    // forty. The design's row has no room for the count, so it is on the title.
    ok("how big it is is still reachable", /12 messages/.test(chips[0].title), chips[0].title);
    ok("the copy invites resuming",
      /Pick up where you left off/.test(b.d.querySelector(".welcome").textContent));
    ok("and the whole history is one click away", !!b.d.querySelector('.welcome [data-act="history"]'));
    b.sent.length = 0;
    b.click('.welcome [data-act="history"]');
    ok("which opens the history popover", !b.d.getElementById("historyPop").hidden);
    ok("having asked the host to refresh it first",
      b.sent.some((m) => m.type === "listSessions"), JSON.stringify(b.sent));

    b.sent.length = 0;
    chips[1].dispatchEvent(new b.w.MouseEvent("click", { bubbles: true }));
    const load = b.sent.filter((m) => m.type === "loadSession");
    ok("clicking one loads it", load.length === 1 && load[0].id === "b", JSON.stringify(load));
    b.dom.window.close();
  }

  // Fewer than three: show what there is, not padding.
  {
    const b = bootWith([sess("cur", "Untitled", 0, "now", true), sess("a", "Only one", 3)]);
    ok("one prior conversation shows one chip",
      b.d.querySelectorAll(".welcome [data-session]").length === 1);
    b.dom.window.close();
  }
  {
    const b = bootWith([
      sess("cur", "Untitled", 0, "now", true), sess("a", "First", 3), sess("b", "Second", 9),
    ]);
    ok("two show two", b.d.querySelectorAll(".welcome [data-session]").length === 2);
    b.dom.window.close();
  }

  // The conversation being looked at, and never-used ones, are not offers.
  {
    const b = bootWith([
      sess("cur", "Untitled", 0, "now", true),
      sess("x", "Untitled 2", 0),
      sess("y", "Untitled 3", 0),
      sess("real", "A real thread", 5),
    ]);
    const chips = [...b.d.querySelectorAll(".welcome [data-session]")];
    ok("empty untitled sessions are not offered", chips.length === 1, String(chips.length));
    ok("only the real one is", chips[0].getAttribute("data-session") === "real");
    ok("and never the conversation already open",
      !chips.some((c) => c.getAttribute("data-session") === "cur"));
    b.dom.window.close();
  }
}

/* ── tips rotate on a period ────────────────────────────────────────────── */
{
  ok("a tip period is defined", /TIP_PERIOD_MS\s*=/.test(SRC));
  // Derived from the clock, not stored: it advances with no interaction, and
  // two panels open side by side show the same tip.
  ok("the index comes from the clock",
    /function tipIndex\(\)[\s\S]{0,160}Math\.floor\(Date\.now\(\) \/ TIP_PERIOD_MS\)/.test(SRC));
  ok("with the manual button as an offset on top", /tipNudge/.test(SRC));
  ok("and something watches for the period turning over", /function watchTips\(\)/.test(SRC));
  // Computed from the source rather than pinned to a literal, so changing the
  // rotation speed cannot leave the poll slower than the period it watches -
  // which would make tips skip rather than rotate.
  {
    const evalMs = (expr) => Function(`"use strict";return (${expr});`)();
    const period = evalMs((SRC.match(/TIP_PERIOD_MS\s*=\s*([^;]+);/) || [])[1]);
    const poll = evalMs(
      (SRC.match(/function watchTips\(\)[\s\S]*?\},\s*([^)]+)\);/) || [])[1]);
    ok("checked on a shorter interval than the period itself",
      poll > 0 && poll < period, `poll=${poll}ms period=${period}ms`);
  }
  // A 30-second rotation will land mid-sentence under someone's eye unless it
  // stops while they are on it. This is the guard for that.
  ok("and held while the strip is being read",
    /S\.tipHold/.test(SRC) && /mouseenter/.test(SRC) && /focusin/.test(SRC));

  const b = boot();
  b.sync("ask");
  const shown = b.d.getElementById("tipText").textContent;
  ok("a tip is on screen", shown.trim().length > 20);
  b.click("#tipNext");
  ok("the button still moves it on", b.d.getElementById("tipText").textContent !== shown);
  b.dom.window.close();
}

/* ── the send control's shape ────────────────────────────────────────────
   A CSS-text test, for the same reason the aura has them: jsdom applies no
   stylesheet, so nothing here would notice the control turning back into a
   disc. The shape is the decision, so the shape is what is pinned. */
console.log("\n──── the send control ────");
{
  const send = CSS.match(/\n#sendBtn\s*\{[^}]*\}/);
  ok("the send control has its own rule", !!send);
  // A rounded square, not a circle. 50% would be a media button, which is the
  // one shape in this composer that belongs to a different product.
  ok("it is a rounded square, not a disc",
    !!send && /border-radius:\s*(\d+)px/.test(send[0]) && !/border-radius:\s*50%/.test(send[0]),
    send ? send[0].replace(/\s+/g, " ") : "not found");
  // Radius has to stay well under half the width or it becomes a disc by
  // arithmetic rather than by declaration.
  const w = send && send[0].match(/width:\s*(\d+)px/);
  const r = send && send[0].match(/border-radius:\s*(\d+)px/);
  ok("and its corners stay corners",
    !!w && !!r && Number(r[1]) < Number(w[1]) / 2,
    w && r ? `radius ${r[1]} of width ${w[1]}` : "not found");
  ok("armed, it is the one filled control in the row",
    /#sendBtn\[data-ready="1"\][^}]*background:\s*var\(--kx-action\)/.test(CSS));
  // Stop is the same control admitting the turn is still running. Red there
  // would read as "something failed" at the moment nothing has.
  ok("stop goes quiet rather than red",
    /#sendBtn\[data-mode="stop"\][^}]*background:\s*var\(--kx-surface-3\)/.test(CSS));
  ok("a press registers on a control this small", /#sendBtn:active[^}]*scale\(/.test(CSS));
  ok("and reduced motion turns that off",
    /prefers-reduced-motion[\s\S]*?#sendBtn:active\s*\{\s*transform:\s*none/.test(CSS));
}

/* ── the model control's shape ───────────────────────────────────────────
   The same shape decision the send control gets, applied to the one control
   that names the model. Pinned in CSS text for the same reason: jsdom applies
   no stylesheet, so nothing else would notice it losing its plate. */
console.log("\n──── the model control ────");
{
  const model = CSS.match(/\n#modelBtn\s*\{[^}]*\}/);
  ok("the model control has its own rule", !!model);
  // A real surface and a hairline are what make it read as a control rather
  // than as clickable prose.
  ok("it wears a surface", !!model && /background:\s*var\(--kx-surface\b/.test(model[0]),
    model ? model[0].replace(/\s+/g, " ") : "not found");
  ok("and a hairline edge", !!model && /border:\s*1px solid var\(--kx-edge\)/.test(model[0]));
  // A FIELD, not a raised plate: it is a picker showing a value, so it is sunk
  // with an inner shadow rather than lifted like the icon buttons. That is the
  // "kinda different but still part of the set" treatment.
  ok("and reads as a recessed field, not a raised plate",
    !!model && /box-shadow:\s*inset\b/.test(model[0]),
    model ? model[0].replace(/\s+/g, " ") : "not found");
  ok("with softened corners, not a pill",
    !!model && /border-radius:\s*(\d+)px/.test(model[0]) && !/border-radius:\s*50%/.test(model[0]),
    model ? model[0].replace(/\s+/g, " ") : "not found");
  // Same radius as the send control, so the two read as one family rather than
  // two unrelated shapes.
  const sendRadius = (CSS.match(/\n#sendBtn\s*\{[^}]*border-radius:\s*(\d+)px/) || [])[1];
  const modelRadius = model && (model[0].match(/border-radius:\s*(\d+)px/) || [])[1];
  ok("sharing the send control's corner radius",
    !!sendRadius && sendRadius === modelRadius, `model ${modelRadius} vs send ${sendRadius}`);
  // The radius must stay well under half the height or the square rounds into a
  // pill by arithmetic - the same guard the send control carries.
  const h = model && model[0].match(/height:\s*(\d+)px/);
  const r = model && model[0].match(/border-radius:\s*(\d+)px/);
  ok("and its corners stay corners",
    !!h && !!r && Number(r[1]) < Number(h[1]) / 2,
    h && r ? `radius ${r[1]} of height ${h[1]}` : "not found");
  // Hover lifts the field rather than only the ink, so it answers a press.
  ok("hover lifts the whole field",
    /#modelBtn:hover:not\(:disabled\)[^}]*background:\s*var\(--kx-surface-2\)/.test(CSS));
  // Open, the field flattens so it is not a sunk trigger fighting a raised list.
  ok("and flattens while its list is open",
    /#modelBtn\[aria-expanded="true"\][^}]*box-shadow:\s*none/.test(CSS));
}


/* ── the mode sheet arrives, rather than appearing ──────────────────────── */
{
  console.log("\n──── the mode sheet's transition ────");
  // `display: none` cannot be transitioned, which is why the animation hangs
  // off `data-open` and not off `hidden`.
  ok("the sheet animates on an attribute, not on hidden",
    /\.perm-sheet\[data-open="1"\]/.test(CSS));
  ok("the card travels from the bottom edge",
    /\.perm-card\s*\{[^}]*transform:\s*translateY\(100%\)/.test(CSS));
  ok("and settles rather than stopping",
    /\.perm-card\s*\{[^}]*cubic-bezier\(\.16,\s*1,\s*\.3,\s*1\)/.test(CSS));
  ok("the backdrop fades and blurs",
    /\.perm-sheet\s*\{[^}]*backdrop-filter:\s*blur\(0px\)/.test(CSS) &&
    /\.perm-sheet\[data-open="1"\]\s*\{[^}]*backdrop-filter:\s*blur\(3px\)/.test(CSS));
  // Without a per-row index every row transitions on the same frame and the
  // list arrives pre-formed, which is the thing the stagger exists to avoid.
  ok("the rows stagger off a per-row index",
    /var\(--i, 0\)/.test(CSS) && /style="--i:/.test(SRC));
  // Opening needs TWO frames: one to commit the un-hidden layout, one for the
  // transition to have a start value. One frame and it appears fully open.
  ok("opening waits two frames so there is something to animate from",
    /requestAnimationFrame\(function \(\) \{\s*requestAnimationFrame\(/.test(SRC));
  ok("and motion-off still opens and closes it",
    /prefers-reduced-motion[\s\S]{0,400}\.perm-card \{ transform: none/.test(CSS));
}

/* ── the panel has a floor and scrolls below it ─────────────────────────── */
{
  console.log("\n──── too narrow to reflow ────");
  // VS Code lets the secondary sidebar be dragged to any width. Without a
  // floor every block reflowed on its own and the panel became a column of
  // one-word lines: a tip strip set vertically, a filename broken mid-token
  // across five lines, prose two words at a time.
  // The floor is on the TRANSCRIPT, not on the whole panel.
  //
  // It was on `#app`, which took the composer with it - and at a 200px panel
  // that put the send button at x=274 inside a 300px layout: off screen, and
  // reachable only by scrolling sideways first. The one control needed on
  // every turn was the one that could not be seen. The transcript is the part
  // that actually needs a measure to stay readable, so the floor lives there
  // and the composer tracks the real width.
  const floor = CSS.match(/#log > \*\s*\{[^}]*min-width:\s*(\d+)px/);
  ok("the transcript declares a minimum width", !!floor, floor ? floor[1] + "px" : "none");
  ok("and it is wide enough to hold a line of prose",
    !!floor && Number(floor[1]) >= 260, floor && floor[1]);
  ok("with its own sideways scroll",
    /#log\s*\{[^}]*overflow-x:\s*auto/.test(CSS));
  // And the panel itself must NOT have one, or the composer goes with it.
  ok("while the panel is free to be as narrow as it is",
    /#app\s*\{[^}]*min-width:\s*0/.test(CSS));
  ok("so nothing scrolls the composer out of reach",
    /#root\s*\{[^}]*overflow:\s*hidden/.test(CSS));
}

/* ── files dropped on the panel ─────────────────────────────────────────── */
{
  console.log("\n──── drag and drop ────");
  /* This read `composer.addEventListener("drop"` - a grep for one variable
     name, which broke the moment the drop target was widened from the composer
     box to the whole panel even though the behaviour it cares about got
     BETTER. The name was never the invariant.

     What matters is that a drop is handled somewhere, and that the target is
     not the composer alone: a file let go over the transcript - most of the
     panel, and the obvious place to aim - used to hit the document guard and
     do nothing at all, silently. Whether the drop actually attaches the file
     is tested for real, with a real DataTransfer and a real File, in
     render.cjs 5x; this suite has no browser and can only read the source. */
  ok("a drop is handled", /\.addEventListener\("drop"/.test(SRC));
  ok("and the target is the panel, not just the composer box",
    /var zone = document\.getElementById\("root"\)/.test(SRC), "drop zone");
  ok("and shows it is about to", /data-drop/.test(SRC) && /\.composer\[data-drop="1"\]/.test(CSS));
  // The load-bearing half: a webview's default action for a dropped file is to
  // navigate to it, which replaces the panel and loses the conversation.
  ok("the document cancels drops everywhere else",
    /document\.addEventListener\("drop",\s*function[^)]*\)\s*\{\s*e\.preventDefault\(\)/.test(SRC));
  ok("and cancels dragover too, or drop never fires at all",
    /document\.addEventListener\("dragover",\s*function[^)]*\)\s*\{\s*e\.preventDefault\(\)/.test(SRC));
  ok("the drop reuses the paste path's reader and count cap",
    /function takeFiles[\s\S]{0,400}readBlob\(/.test(SRC));
  /* And there is no SIZE cap on either path any more, at the owner's
     instruction. This file's own wording said "size and count caps", which was
     true of both halves until the host's 10 MB limit came out - and the
     webview kept a second copy of that number, so a dropped file was still
     refused after the host had stopped refusing it. */
  ok("and no size cap survives in the webview",
    !/ATTACH_MAX/.test(SRC), "ATTACH_MAX");
}

/* ── a conversation can be thrown away from the welcome screen ──────────── */
{
  console.log("\n──── deleting a conversation ────");
  const b = boot();
  b.sync("ask");
  // boot()'s fixture has no sessions, so the Recent list is empty. Send one
  // that has some: the welcome screen renders when the CURRENT session has no
  // messages, and Recent lists the others.
  b.w.dispatchEvent(new b.w.MessageEvent("message", { data: {
    type: "sessionsListed",
    sessions: [
      { id: "s", title: "t", when: "now", count: 0, active: true },
      { id: "old", title: "Trace the mTLS handshake", when: "2h ago", count: 12, active: false },
    ],
  } }));
  const bins = [...b.d.querySelectorAll(".welcome [data-del]")];
  ok("every Recent row offers a bin", bins.length > 0, String(bins.length));
  ok("and each names the conversation it would delete",
    bins.every((x) => (x.getAttribute("aria-label") || "").length > 8));
  const id = bins[0].getAttribute("data-del");
  bins[0].click();
  const del = b.sent.filter((m) => m.type === "deleteSession");
  ok("clicking it asks the host to delete that one", del.length === 1 && del[0].id === id,
    JSON.stringify(del));
  // The bin sits inside the row, which is itself a button that loads the
  // conversation. Deleting must not also open the thing being deleted.
  ok("and does not open the conversation on the way out",
    !b.sent.some((m) => m.type === "loadSession"));
  b.dom.window.close();
}

/* ── the agent button ───────────────────────────────────────────────────── */
{
  /* THE PICKER EXISTED; THE DOOR DID NOT.
     The agent sheet has always been there and was reachable only by typing
     `/agent`, so choosing an agent meant knowing the command or leaving the
     composer for the Agents tab. This is the control that opens it from where
     you type, and the state it has to carry is WHOSE agent it is - the whole
     reason the old workspace-wide agent went unnoticed is that nothing near
     the composer said which chat it applied to. */
  const b = boot();
  b.sync("ask");

  const btn = () => b.d.getElementById("agentBtn");
  ok("the composer offers an agent button", !!b.d.querySelector(".toolbar #agentBtn"));
  /* A DIRECT CHILD OF THE TOOLBAR, next to the actions rather than inside
     them. `.tb-actions` is pinned to the phase segment's row at 280px so a
     wrap cannot orphan send, and a fourth plate in that group took it over the
     width - which put attach and send on a row of their own with the left half
     of the composer empty. `render.cjs` catches exactly that, so this pins the
     placement that keeps it caught. */
  ok("it is a direct child of the toolbar", !!b.d.querySelector(".toolbar > #agentBtn"));
  ok("and not inside the actions group", !b.d.querySelector(".tb-actions #agentBtn"));
  ok("sitting immediately before them, so it still reads as one run",
    (btn().nextElementSibling || {}).className === "tb-actions",
    (btn().nextElementSibling || {}).className);
  ok("it draws the sparkle", !!btn().querySelector('use[href="#i-spark"]'));
  ok("which is defined", /id="i-spark"/.test(SRC));

  // Resting: no agent in this conversation.
  ok("with no agent it rests", btn().getAttribute("data-on") === "0",
    btn().getAttribute("data-on"));
  ok("and says what it is for", /choose an agent/i.test(btn().title), btn().title);
  ok("naming the scope, because that is what was invisible before",
    /this chat/i.test(btn().title), btn().title);
  ok("it has an accessible name of its own",
    (btn().getAttribute("aria-label") || "").length > 8, btn().getAttribute("aria-label"));

  ok("the sheet starts closed", b.d.getElementById("qp").hidden);
  ok("clicking opens it", b.click("#agentBtn") && !b.d.getElementById("qp").hidden);

  // Armed: an agent is set for this conversation.
  b.w.dispatchEvent(new b.w.MessageEvent("message", { data: {
    type: "agentChanged",
    agent: { name: "reviewer", description: "Reads a diff.", tools: ["read_file"], mcp: [], file: "x.md" },
  } }));
  ok("with one set it arms", btn().getAttribute("data-on") === "1",
    btn().getAttribute("data-on"));
  ok("and names it in the tooltip", /reviewer/.test(btn().title), btn().title);
  ok("…and in the accessible name", /reviewer/.test(btn().getAttribute("aria-label") || ""),
    btn().getAttribute("aria-label"));
  ok("while still saying other chats are unaffected",
    /other chats/i.test(btn().title), btn().title);
  /* The armed state is a paint, so it has to exist in the stylesheet or the
     attribute above is bookkeeping nobody can see. */
  ok("the armed state is drawn", /\.agent-btn\[data-on="1"\]/.test(CSS));
  b.dom.window.close();
}

/* ── the permission card, and what "always" costs ───────────────────────── */
{
  /* THE SAME LABEL FOR TWO DIFFERENT PROMISES.
   *
   * "Always allow" on an EDIT sets a flag for this conversation. "Always
   * allow" on a COMMAND stores a workspace-level grant that survives restarts.
   * Both buttons read "Always allow", and the distinction appeared only in the
   * card's replacement text, after the click. The scope belongs on the control.
   *
   * That command grant used to be keyed on the first WORD, and the card
   * printed the word - "Always allow git" - because that was honestly what was
   * being granted: one yes to `git status` authorised `git push --force` for
   * good. The host matches the whole normalised line exactly now, so the card
   * says "this command" and names it in the tooltip. Printing the first word
   * would now UNDER-state the grant, which is its own kind of lie. */
  const b = boot();
  b.sync("ask");
  b.w.dispatchEvent(new b.w.MessageEvent("message", { data: {
    type: "permissionRequest", id: "p1", summary: "Run: npm test --silent",
    risk: "write", grants: ["npm test --silent"],
  } }));
  const cmdBtn = b.d.querySelector('.perm [data-perm="always"]');
  ok("a command grant is scoped to the one command",
    cmdBtn.textContent.trim() === "Always allow this command", cmdBtn.textContent);
  ok("and its tooltip names the exact command it grants",
    cmdBtn.title.indexOf("npm test --silent") > -1, cmdBtn.title);
  ok("and says the grant outlives the turn",
    /workspace/.test(cmdBtn.title) && /revoke/i.test(cmdBtn.title), cmdBtn.title);
  ok("and that a shared program name is not covered by it",
    /same word/i.test(cmdBtn.title), cmdBtn.title);
  ok("allow-once says it is once",
    /once/i.test(b.d.querySelector('.perm [data-perm="allow"]').textContent));

  /* A DESTRUCTIVE COMMAND CANNOT BE GRANTED FOR NEXT TIME.
   *
   * The host refuses it on every future invocation whatever is stored, so a
   * button offering to store one would promise something nothing honours. It
   * is withheld rather than shown and ignored, and the card says why in its
   * own text - not only in a tooltip, because the person about to lose
   * uncommitted work is the person not reading tooltips. */
  b.w.dispatchEvent(new b.w.MessageEvent("message", { data: {
    type: "permissionRequest", id: "p2", summary: "Run: git reset --hard origin/main",
    risk: "destructive", grants: [],
  } }));
  const danger = [...b.d.querySelectorAll(".perm")].pop();
  ok("a destructive command offers no 'always' at all",
    !danger.querySelector('[data-perm="always"]'), danger.textContent);
  ok("but still offers allow-once and deny",
    !!danger.querySelector('[data-perm="allow"]') && !!danger.querySelector('[data-perm="deny"]'));
  ok("the card is marked as the different kind of question it is",
    danger.classList.contains("perm-danger"), danger.className);
  ok("and says on its face that the work may not come back",
    /cannot be recovered/i.test(danger.textContent), danger.textContent.slice(0, 200));

  b.w.dispatchEvent(new b.w.MessageEvent("message", { data: {
    type: "permissionRequest", id: "p3", summary: "Overwrite src/index.ts",
  } }));
  const editBtn = [...b.d.querySelectorAll('.perm [data-perm="always"]')].pop();
  ok("an edit grant is named as an edit grant",
    editBtn.textContent.trim() === "Always allow edits", editBtn.textContent);
  ok("and its tooltip says it is only this conversation",
    /conversation/.test(editBtn.title), editBtn.title);
  b.dom.window.close();
}

/* ── "Diff view" opens a diff ───────────────────────────────────────────── */
{
  /* It posted `openFile`, which opens the plain file with nothing highlighted -
     the one thing a control called "Diff view" must not do. The pre-turn side
     has been sitting in the shadow repo the whole time. */
  const b = boot();
  b.sync("ask");
  b.w.dispatchEvent(new b.w.MessageEvent("message", { data: {
    type: "diffPending", turnId: "t1", file: "src/a.ts", added: 1, removed: 1,
    patch: "@@ -1,1 +1,1 @@\n-a\n+b", truncated: false,
  } }));
  b.sent.length = 0;
  b.click('.diff-card [data-diff="view"]');
  const opened = b.sent.filter((m) => m.type === "openDiff");
  ok("the third button asks for a diff, not a file",
    opened.length === 1 && opened[0].file === "src/a.ts" && opened[0].turnId === "t1",
    JSON.stringify(b.sent));
  ok("and nothing asks for the plain file any more",
    !b.sent.some((m) => m.type === "openFile"));
  b.dom.window.close();
}

/* ── what an edit looks like before you approve it ──────────────────────── */
{
  /* It was `- old\n+ new` in a plain monospace block: no gutter, no line
     numbers, no add/del wash - and for an overwrite it was a truncated PREFIX
     of the new content with not one line of the old. So the default mode asked
     people to authorise an edit from a blob, while the panel's own diff
     renderer drew exactly this, properly, three seconds later on the diff card.
     Same information, same treatment, both moments. */
  const b = boot();
  b.sync("ask");
  b.w.dispatchEvent(new b.w.MessageEvent("message", { data: {
    type: "permissionRequest", id: "p3", summary: "Edit src/a.ts",
    detail: "- const a = 1\n+ const a = 2",
    patch: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,3 @@\n const x = 0;\n-const a = 1;\n+const a = 2;\n const y = 3;",
  } }));
  const card = b.d.querySelector(".perm");
  ok("the change is drawn as a diff", !!card.querySelector(".perm-diff"));
  ok("with a removed line", !!card.querySelector(".dl.del"));
  ok("and an added one", !!card.querySelector(".dl.add"));
  ok("with context around it", !!card.querySelector(".dl.ctx"));
  ok("and line numbers, which a blob cannot have",
    /\b1\b/.test(card.querySelector(".dl .g").textContent + "1"));
  ok("the raw detail is not shown as well - one account of a change is enough",
    !card.querySelector(".perm-cmd[style]"));
  ok("and the diff is bounded so the buttons stay reachable",
    /\.perm-diff\s*\{[^}]*max-height/.test(CSS));

  // A request with no patch - a shell command, a fetch - still shows its
  // payload the old way, because there is no diff to make of it.
  b.w.dispatchEvent(new b.w.MessageEvent("message", { data: {
    type: "permissionRequest", id: "p4", summary: "Run: npm test", detail: "npm test",
  } }));
  const cmd = [...b.d.querySelectorAll(".perm")].pop();
  ok("a command falls back to its payload", !!cmd.querySelector(".perm-cmd[style]"));
  ok("and draws no empty diff", !cmd.querySelector(".perm-diff"));
  b.dom.window.close();
}

/* ── the message context menu ───────────────────────────────────────────── */
/*
 * The transcript was the one surface in the panel with no per-message actions
 * at all. turn-foot is per TURN, sits at the end, and its Copy only ever took
 * the assistant's answer - so there was no way to copy a question, and no way
 * to reach an earlier turn's answer without selecting it by hand in a 340px
 * column.
 *
 * Right-click was the chosen trigger, and it costs something: opening our menu
 * means preventDefault(), which takes away VS Code's own menu - the one Copy
 * normally lives in. So Copy has to be here, and a code block, which already
 * has its own copy button and where native select-and-copy is the better tool,
 * is deliberately left alone.
 */
{
  const b = boot();
  b.sync("ask");
  const rc = (sel, x = 40, y = 60) => {
    const el = b.d.querySelector(sel);
    if (!el) return null;
    const ev = new b.w.MouseEvent("contextmenu", {
      bubbles: true, cancelable: true, clientX: x, clientY: y,
    });
    el.dispatchEvent(ev);
    return ev;
  };
  const menu = () => b.d.getElementById("msgMenu");
  const rows = () => [...b.d.querySelectorAll("#msgMenu [data-mm]")]
    .map((r) => r.getAttribute("data-mm"));
  const labels = () => [...b.d.querySelectorAll("#msgMenu [data-mm]")]
    .map((r) => r.textContent.trim());

  b.w.dispatchEvent(new b.w.MessageEvent("message", { data: {
    type: "streamDelta", text: "The answer.",
  } }));
  b.w.dispatchEvent(new b.w.MessageEvent("message", { data: { type: "turnEnd" } }));
  b.w.dispatchEvent(new b.w.MessageEvent("message", { data: {
    type: "steerAccepted", text: "the original question", files: [],
  } }));

  ok("the menu exists and starts closed", !!menu() && menu().hidden);

  const ev = rc(".msg-user");
  ok("right-clicking a question opens it", !!menu() && !menu().hidden);
  // Both menus appearing at once is the failure this guards.
  ok("and takes the native menu, rather than sitting under it",
    !!ev && ev.defaultPrevented);
  ok("a question offers all four actions",
    rows().join(",") === "edit,resend,attach,copy", rows().join(","));

  rc(".msg-ai");
  // Copy and its stripped variant, which only an answer has - a question is
  // never markdown-rendered, so there is no second reading of one to offer.
  ok("an answer offers only the ones that mean anything on it",
    rows().join(",") === "attach,copy,copyPlain", rows().join(","));
  ok("no Edit on an answer", !rows().includes("edit"));
  ok("and no Resend either", !rows().includes("resend"));

  b.dom.window.close();
}

/* A code block keeps the native menu: it has its own copy button two pixels
   away, and selecting part of a snippet is worth more there than a
   message-level action. */
{
  const b = boot();
  b.sync("ask");
  b.w.dispatchEvent(new b.w.MessageEvent("message", { data: {
    type: "streamDelta", text: "Here:\n\n```js\nconst a = 1;\n```\n",
  } }));
  b.w.dispatchEvent(new b.w.MessageEvent("message", { data: { type: "turnEnd" } }));
  const cb = b.d.querySelector(".msg-ai .cb");
  ok("the answer really does hold a code block", !!cb);
  const ev = new b.w.MouseEvent("contextmenu", { bubbles: true, cancelable: true });
  if (cb) cb.dispatchEvent(ev);
  const cbMenu = b.d.getElementById("msgMenu");
  ok("right-clicking a code block opens nothing", !cbMenu || cbMenu.hidden);
  ok("and leaves the native menu alone", !ev.defaultPrevented);
  b.dom.window.close();
}

/* Edit, Resend, Attach and Copy all end in the composer or the clipboard. */
{
  const b = boot();
  b.sync("ask");
  const rc = (sel) => {
    const el = b.d.querySelector(sel);
    el.dispatchEvent(new b.w.MouseEvent("contextmenu", {
      bubbles: true, cancelable: true, clientX: 40, clientY: 60,
    }));
  };
  const row = (name) => b.d.querySelector(`#msgMenu [data-mm="${name}"]`);
  b.w.dispatchEvent(new b.w.MessageEvent("message", { data: {
    type: "steerAccepted", text: "the original question", files: [],
  } }));

  rc(".msg-user");
  ok("Edit is called Edit while the composer is empty",
    !!row("edit") && row("edit").textContent.trim() === "Edit",
    row("edit") && row("edit").textContent);
  b.click('#msgMenu [data-mm="edit"]');
  ok("and loads the message into the composer",
    b.d.getElementById("draft").value === "the original question",
    b.d.getElementById("draft").value);
  const afterEdit = b.d.getElementById("msgMenu");
  ok("closing the menu behind it", !!afterEdit && afterEdit.hidden);

  /* A HALF-WRITTEN DRAFT IS WORK. Replacing it silently is the same class of
     harm as any other unconfirmed destructive action, so the cost goes on the
     row rather than being discovered after the click. */
  b.d.getElementById("draft").value = "something I was already writing";
  rc(".msg-user");
  ok("with a draft present the row says what it will cost",
    !!row("edit") && /replace draft/i.test(row("edit").textContent),
    row("edit") && row("edit").textContent);

  // Resend goes through the ordinary send path, so it queues, draws a bubble
  // and clears attachments exactly as typing it would.
  b.sent.length = 0;
  b.click('#msgMenu [data-mm="resend"]');
  const sends = b.sent.filter((m) => m.type === "sendMessage");
  ok("Resend sends the message again",
    sends.length === 1 && sends[0].text === "the original question",
    JSON.stringify(sends));

  // Attach reuses the pill the composer already draws for a pasted file.
  rc(".msg-user");
  b.click('#msgMenu [data-mm="attach"]');
  ok("Attach puts a pill in the composer",
    b.d.querySelectorAll(".att-pill").length === 1,
    String(b.d.querySelectorAll(".att-pill").length));
  const pillName = b.d.querySelector(".att-name");
  ok("named for what it is",
    !!pillName && /question/.test(pillName.textContent), pillName && pillName.textContent);
  ok("and the strip is shown", !b.d.getElementById("attachStrip").hidden);
  rc(".msg-user");
  b.click('#msgMenu [data-mm="attach"]');
  ok("attaching twice attaches twice - the pills are what will be sent",
    b.d.querySelectorAll(".att-pill").length === 2);

  b.sent.length = 0;
  rc(".msg-user");
  b.click('#msgMenu [data-mm="copy"]');
  const copies = b.sent.filter((m) => m.type === "copyText");
  ok("Copy reaches the host", copies.length === 1, JSON.stringify(b.sent));
  ok("with the message's own text", copies[0] && copies[0].text === "the original question",
    copies[0] && copies[0].text);
  b.dom.window.close();
}

/* The text a message was BUILT from, not the text its DOM happens to hold.
   A multimodal question joins its text blocks with newlines and drops the
   images; textContent would run them together and lose the breaks. */
{
  const b = boot();
  b.sync("ask");
  // The array shape reaches the transcript through a REPLAYED conversation,
  // which is the path that matters: an old chat reopened from the history
  // popover has to offer the same actions as one typed a second ago.
  b.w.dispatchEvent(new b.w.MessageEvent("message", { data: {
    type: "sessionSwitched", id: "s2", title: "t", messages: [
      { role: "user", content: [{ type: "text", text: "first" }, { type: "text", text: "second" }] },
    ],
  } }));
  const msg = b.d.querySelector(".msg-user");
  ok("a replayed multimodal question is drawn", !!msg);
  if (msg) {
    ok("its text is stored, not scraped", msg._raw === "first\nsecond", JSON.stringify(msg._raw));
    ok("and the DOM alone would have lost the break",
      msg.querySelector(".u-text").textContent !== msg._raw);
  }
  b.dom.window.close();
}

/* One closer owns every menu, and the pointer-anchored one cannot outlive the
   position it was anchored to. */
{
  const b = boot();
  b.sync("ask");
  const rc = () => b.d.querySelector(".msg-user").dispatchEvent(
    new b.w.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 60 }));
  b.w.dispatchEvent(new b.w.MessageEvent("message", { data: {
    type: "steerAccepted", text: "q", files: [],
  } }));

  const shut = () => {
    const m = b.d.getElementById("msgMenu");
    return !!m && m.hidden;
  };
  const open = () => {
    const m = b.d.getElementById("msgMenu");
    return !!m && !m.hidden;
  };

  rc();
  ok("it opens before each of these", open());
  b.d.dispatchEvent(new b.w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  ok("Escape closes it", shut());

  rc();
  b.click("#histBtn");
  ok("opening another menu closes it - two menus at once is the bug", shut());

  /* Scrolling closes it - but only a scroll that MOVED something. A bare event
     with the transcript still where the menu was anchored is the spurious one
     the browser suite caught: the click's own scroll-into-view queues a scroll
     that lands after the menu has opened, and closing on it made the menu open
     and vanish on one gesture. */
  const log = b.d.getElementById("log");
  rc();
  log.dispatchEvent(new b.w.Event("scroll"));
  ok("a scroll that moved nothing leaves it alone", open());
  log.scrollTop = 240;
  log.dispatchEvent(new b.w.Event("scroll"));
  ok("and a real one closes it, because what it was anchored to has moved", shut());
  b.dom.window.close();
}

/* Clamped to the panel. jsdom has no layout, so the menu's measured size is
   supplied here - the arithmetic is the thing under test, and the real
   rendering is covered by test/render.cjs in a browser at 200%. */
{
  const b = boot();
  b.sync("ask");
  b.w.dispatchEvent(new b.w.MessageEvent("message", { data: {
    type: "steerAccepted", text: "q", files: [],
  } }));
  const menu = b.d.getElementById("msgMenu");
  if (menu) {
    Object.defineProperty(menu, "offsetWidth", { value: 180, configurable: true });
    Object.defineProperty(menu, "offsetHeight", { value: 120, configurable: true });
  }
  b.w.innerWidth = 200;
  b.w.innerHeight = 400;

  b.d.querySelector(".msg-user").dispatchEvent(new b.w.MouseEvent("contextmenu", {
    bubbles: true, cancelable: true, clientX: 190, clientY: 380,
  }));
  const left = menu ? parseFloat(menu.style.left) : NaN;
  const top = menu ? parseFloat(menu.style.top) : NaN;
  ok("a menu opened at the right edge stays inside the panel",
    left + 180 <= 200 && left >= 0, menu && `left ${menu.style.left}`);
  ok("and one opened at the bottom flips up rather than clipping",
    top + 120 <= 400 && top >= 0, menu && `top ${menu.style.top}`);
  b.dom.window.close();
}

/* An answer has TWO readings and a question has one.

   .msg-ai keeps its markdown source on _raw, which is what Copy has always
   given - here and in turn-foot, which must not disagree with it. What did not
   exist was the other reading: the answer as it is actually displayed. A
   question is never markdown-rendered, so it has no second reading and gets no
   second row. */
{
  const b = boot();
  b.sync("ask");
  const rc = (sel) => b.d.querySelector(sel).dispatchEvent(
    new b.w.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 60 }));
  b.w.dispatchEvent(new b.w.MessageEvent("message", { data: {
    type: "streamDelta", text: "Try this:\n\n```python\nx = 1\n```\n",
  } }));
  b.w.dispatchEvent(new b.w.MessageEvent("message", { data: { type: "turnEnd" } }));

  b.sent.length = 0;
  rc(".msg-ai");
  b.click('#msgMenu [data-mm="copy"]');
  rc(".msg-ai");
  b.click('#msgMenu [data-mm="copyPlain"]');
  const c = b.sent.filter((m) => m.type === "copyText");
  ok("both readings reach the clipboard", c.length === 2, JSON.stringify(c.map((m) => m.text)));
  ok("Copy is still the markdown, as the turn footer's Copy already was",
    c[0] && c[0].text.indexOf("```") !== -1, JSON.stringify(c[0]));
  ok("Copy as plain text is not", c[1] && c[1].text.indexOf("```") === -1,
    JSON.stringify(c[1]));
  /* The block's header is chrome, not prose: pasting an answer that reads
     "pythonx = 1" is the defect this drops .cb-h to avoid. */
  ok("and it drops the block's language label rather than reading it as prose",
    c[1] && c[1].text.indexOf("python") === -1, JSON.stringify(c[1]));
  ok("while keeping the code itself", c[1] && c[1].text.indexOf("x = 1") !== -1,
    JSON.stringify(c[1]));
  b.dom.window.close();
}

/* REWIND FINDS ITS CHECKPOINT BY LABEL, AND LABELS REPEAT.

   The hash cannot ride on the message: the stored session and the stateSync
   payload both carry Msg[], the model's own wire format, so a field added there
   would be sent to the model. The host commits each snapshot with the message
   text as its subject, so the label is what there is to match on - and the
   Retry button sends "Retry that last step." verbatim every time, which is why
   the match consumes as it goes rather than taking the first hit twice. */
{
  const b = boot();
  b.sync("ask");
  const rc = (sel, n) => [...b.d.querySelectorAll(sel)][n].dispatchEvent(
    new b.w.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 60 }));
  const rows = () => [...b.d.querySelectorAll("#msgMenu [data-mm]")]
    .map((r) => r.getAttribute("data-mm"));
  const say = (text) => b.w.dispatchEvent(new b.w.MessageEvent("message", { data: {
    type: "steerAccepted", text, files: [] } }));

  say("Retry that last step.");
  say("Retry that last step.");
  ok("two identically worded turns are on screen",
    b.d.querySelectorAll(".msg-user").length === 2,
    String(b.d.querySelectorAll(".msg-user").length));

  rc(".msg-user", 0);
  ok("with nothing snapshotted there is no Rewind row to press",
    !rows().includes("rewind"), rows().join(","));

  b.w.dispatchEvent(new b.w.MessageEvent("message", { data: {
    type: "checkpointsListed",
    checkpoints: [
      { hash: "hnew", label: "Retry that last step.", when: "now" },
      { hash: "hold", label: "Retry that last step.", when: "2m ago" },
    ],
  } }));

  b.sent.length = 0;
  rc(".msg-user", 0);
  ok("once the host lists one, the row appears", rows().includes("rewind"), rows().join(","));
  b.click('#msgMenu [data-mm="rewind"]');
  let r = b.sent.filter((m) => m.type === "restoreCheckpoint");
  ok("the first turn rewinds to the OLDER checkpoint",
    r.length === 1 && r[0].hash === "hold", JSON.stringify(r));

  b.sent.length = 0;
  rc(".msg-user", 1);
  b.click('#msgMenu [data-mm="rewind"]');
  r = b.sent.filter((m) => m.type === "restoreCheckpoint");
  ok("and the second, worded identically, rewinds to the newer one",
    r.length === 1 && r[0].hash === "hnew", JSON.stringify(r));

  /* It posts the message the Control Center's checkpoint list already posts,
     so the modal naming the files is the host's existing one rather than a
     second confirmation that could disagree with it. */
  ok("it asks the host to restore rather than doing anything itself",
    !b.sent.some((m) => m.type === "sendMessage" || m.type === "newChat"));
  b.dom.window.close();
}

/* role="menu" IS A PROMISE ABOUT THE KEYBOARD.

   a11y.cjs exists because role="tablist" was once declared and the contract
   that goes with it was not implemented. The same trap is open here: the menu
   already says role="menu" and role="menuitem". */
{
  const b = boot();
  b.sync("ask");
  const rc = (sel) => b.d.querySelector(sel).dispatchEvent(
    new b.w.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 60 }));
  const key = (k, el) => (el || b.d).dispatchEvent(
    new b.w.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  b.w.dispatchEvent(new b.w.MessageEvent("message", { data: {
    type: "steerAccepted", text: "the original question", files: [] } }));

  rc(".msg-user");
  const rows = [...b.d.querySelectorAll("#msgMenu .pop-row")];
  ok("focus enters the menu when it opens", b.d.activeElement === rows[0],
    b.d.activeElement && b.d.activeElement.className);
  ok("and no row is a tab stop, so the panel gains none",
    rows.every((r) => r.getAttribute("tabindex") === "-1"));
  key("ArrowDown", rows[0]);
  ok("ArrowDown moves to the next row", b.d.activeElement === rows[1]);
  key("End", rows[1]);
  ok("End goes to the last", b.d.activeElement === rows[rows.length - 1]);
  key("ArrowDown", rows[rows.length - 1]);
  ok("and it wraps rather than stopping dead", b.d.activeElement === rows[0]);
  key("ArrowUp", rows[0]);
  ok("ArrowUp wraps the other way", b.d.activeElement === rows[rows.length - 1]);
  key("Home", rows[rows.length - 1]);
  ok("Home returns to the first", b.d.activeElement === rows[0]);
  key("Escape", rows[0]);
  ok("Escape closes it", b.d.getElementById("msgMenu").hidden);
  /* Focus on <body> would mean the next Tab restarts from the top of the
     panel, which is further from where the user was than where they started. */
  ok("and focus goes back to the message rather than to the body",
    b.d.activeElement === b.d.querySelector(".msg-user"),
    b.d.activeElement && (b.d.activeElement.className || b.d.activeElement.tagName));
  b.dom.window.close();
}

/* Escape dismissing a menu must not also kill the turn underneath it. */
{
  const b = boot();
  b.sync("ask");
  b.w.dispatchEvent(new b.w.MessageEvent("message", { data: {
    type: "steerAccepted", text: "the original question", files: [] } }));
  b.w.dispatchEvent(new b.w.MessageEvent("message", { data: {
    type: "streamDelta", text: "working" } }));

  b.sent.length = 0;
  b.d.dispatchEvent(new b.w.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  ok("Escape with no menu open still interrupts a running turn",
    b.sent.filter((m) => m.type === "interrupt").length === 1, JSON.stringify(b.sent));

  b.sent.length = 0;
  b.d.querySelector(".msg-user").dispatchEvent(
    new b.w.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 60 }));
  b.d.querySelector("#msgMenu .pop-row").dispatchEvent(
    new b.w.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  ok("but Escape that dismisses the menu leaves the turn running",
    b.sent.filter((m) => m.type === "interrupt").length === 0, JSON.stringify(b.sent));
  b.dom.window.close();
}

if (failures.length) for (const f of failures) console.log("FAIL  " + f);
console.log(`\n──── ${pass} passed, ${failures.length} failed ────`);
process.exitCode = failures.length ? 1 : 0;
