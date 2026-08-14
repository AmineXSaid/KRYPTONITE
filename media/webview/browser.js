/* KRYPTONITE browser surface. Plain DOM, zero dependencies.
 *
 * Two views of one address:
 *
 *   Live    an <iframe>. Interactive, current, and unreadable - a
 *           cross-origin frame exposes nothing to this document. Plenty of
 *           sites also refuse to be framed, and a refusal looks exactly like
 *           a slow load, so there is a timer that gives up and says so.
 *
 *   Reader  the same page fetched by the host on the active profile's
 *           transport and reduced to text. Always readable, and reachable
 *           anywhere the model's own endpoint is reachable.
 *
 * History is this panel's own, not the frame's: `history.back()` on a
 * cross-origin frame is blocked, so a back button driven by it would work on
 * some sites and silently do nothing on others.
 */
(function () {
  var api = window.__kx.api;
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
  function $(id) { return document.getElementById(id); }

  var S = {
    url: "",
    view: "live",          // live | reader
    page: null,
    loading: false,
    error: "",
    history: [],
    at: -1,
    /* Set when the frame has not reported a load in time. Sites that refuse
       framing produce no error event of any kind, so silence is the signal. */
    frameBlocked: false,
    /* The agent's own browser: whether one is up, where it is, and the most
       recent frame of it. `frame` is a base64 jpeg, replaced in place - the
       previous one is never worth keeping. */
    agent: { running: false, url: "", title: "", frame: null, error: "", live: false },
  };
  var frameTimer = null;

  var ICONS =
    '<symbol id="b-back" viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" ' +
      'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></symbol>' +
    '<symbol id="b-fwd" viewBox="0 0 24 24"><path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" ' +
      'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></symbol>' +
    '<symbol id="b-reload" viewBox="0 0 24 24"><path d="M20 12a8 8 0 11-2.4-5.7M20 3.5V9h-5.5" fill="none" ' +
      'stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></symbol>' +
    '<symbol id="b-stop" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round"/></symbol>' +
    '<symbol id="b-ext" viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5" ' +
      'fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></symbol>' +
    '<symbol id="b-agent" viewBox="0 0 24 24"><path d="M4 12h11M11 7l5 5-5 5M18 4v16" fill="none" stroke="currentColor" ' +
      'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></symbol>';

  function icon(id, cls) {
    return '<svg class="' + (cls || "ic") + '" aria-hidden="true"><use href="#' + id + '"/></svg>';
  }

  /** Three arcs on their own periods, matching the rest of the extension. */
  function spinner(size) {
    var s = size || 13;
    return '<svg class="kx-spin" width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
      '<circle class="a1" cx="12" cy="12" r="10" stroke="var(--kx-accent)" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="16 47"/>' +
      '<circle class="a2" cx="12" cy="12" r="6.5" stroke="var(--kx-mcp)" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="10 31"/>' +
      '<circle class="a3" cx="12" cy="12" r="3" stroke="var(--kx-active)" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="5 14"/>' +
      "</svg>";
  }

  /**
   * The mark on the launcher card.
   *
   * Defined here rather than pulled from crystal.js, because this panel does
   * not load that script and adding one for a single decorative glyph would
   * be a script tag per ornament. It borrows the language - a faceted stone
   * inside a ring - without borrowing the file.
   */
  function orb() {
    return '<svg width="54" height="54" viewBox="0 0 54 54" fill="none" aria-hidden="true">' +
      '<circle cx="27" cy="27" r="24" stroke="var(--kx-line-2)" stroke-width="1"/>' +
      '<circle cx="27" cy="27" r="18" stroke="var(--kx-accent)" stroke-width="1" opacity=".45"/>' +
      '<path d="M27 15 L37 27 L27 39 L17 27 Z" stroke="var(--kx-accent)" stroke-width="1.2" ' +
        'stroke-linejoin="round" fill="var(--kx-accent)" fill-opacity=".10"/>' +
      '<path d="M17 27 H37" stroke="var(--kx-accent)" stroke-width=".8" opacity=".6"/>' +
      '<path d="M22 27 L27 15 L32 27" stroke="var(--kx-accent)" stroke-width=".8" opacity=".6" ' +
        'stroke-linejoin="round"/>' +
      "</svg>";
  }

  function mount() {
    $("root").innerHTML =
      '<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>' + ICONS + "</defs></svg>" +
      '<div class="bw">' +
        '<div class="bar">' +
          '<button class="nav" id="bBack" title="Back" aria-label="Back" disabled>' + icon("b-back", "ic-15") + "</button>" +
          '<button class="nav" id="bFwd" title="Forward" aria-label="Forward" disabled>' + icon("b-fwd", "ic-15") + "</button>" +
          '<button class="nav" id="bGo" title="Reload" aria-label="Reload">' + icon("b-reload", "ic-14") + "</button>" +
          '<div class="addr"><input id="bUrl" type="text" spellcheck="false" autocomplete="off" ' +
            'placeholder="Search or enter address" aria-label="Address"><span id="bBusy" class="busy"></span></div>' +
          '<div class="seg" role="group" aria-label="View">' +
            '<button class="seg-b" id="bLive" aria-pressed="true">Live</button>' +
            '<button class="seg-b" id="bRead" aria-pressed="false">Reader</button>' +
            '<button class="seg-b" id="bAgentView" aria-pressed="false" title="Watch the browser the agent drives">Agent</button>' +
          "</div>" +
          '<button class="nav" id="bAgent" title="Send this page to the chat" aria-label="Send to chat">' + icon("b-agent", "ic-15") + "</button>" +
          '<button class="nav" id="bExt" title="Open in your system browser" aria-label="Open externally">' + icon("b-ext", "ic-14") + "</button>" +
        "</div>" +
        '<div class="stage" id="bStage"></div>' +
        '<div class="foot" id="bFoot"></div>' +
      "</div>";
  }

  /**
   * The agent's browser: a launcher when none is running, live frames when one
   * is.
   *
   * Deliberately not an iframe. These are the actual pixels of the actual page
   * the model is driving - same cookies, same session, same scroll position -
   * and they arrive from sites that refuse framing outright, which is most of
   * the ones worth automating.
   */
  function renderAgent(stage) {
    var a = S.agent;

    if (a.error) {
      stage.innerHTML = '<div class="blank"><div class="blank-in err">' +
        "<h2>The browser could not start</h2><p>" + esc(a.error) + "</p></div></div>";
      return;
    }

    if (!a.live) {
      // The launcher. One button, and an honest account of what pressing it
      // does - a browser starting is a process appearing on someone's machine,
      // which is not a thing to do silently.
      stage.innerHTML =
        '<div class="launch">' +
          '<div class="launch-card">' +
            '<div class="launch-orb">' + orb() + "</div>" +
            "<h2>" + (a.running ? "A browser is already running" : "No browser running") + "</h2>" +
            "<p>" + (a.running
              ? "The agent has one open. Watch it live, or close it and free the process."
              : "Start a Chromium the agent drives. It opens headless by default, so nothing appears over your editor - this panel is where you see it.") +
            "</p>" +
            '<div class="launch-row">' +
              '<button class="btn primary" id="aStart">' +
                (a.running ? "Watch it" : "Launch browser") + "</button>" +
              (a.running ? '<button class="btn" id="aClose">Close browser</button>' : "") +
            "</div>" +
          "</div>" +
        "</div>";
      return;
    }

    // Live. The frame fills the stage and keeps its aspect; the strip under it
    // says where the page actually is, because a picture of a page does not.
    stage.innerHTML =
      '<div class="live">' +
        '<div class="live-frame">' +
          (a.frame
            ? '<img id="aFrame" alt="The page the agent is viewing" src="data:image/jpeg;base64,' + a.frame + '">'
            : '<div class="live-wait">' + spinner(18) + "<span>waiting for the first frame…</span></div>") +
        "</div>" +
        '<div class="live-bar">' +
          '<span class="live-dot"></span>' +
          '<span class="live-t ell" title="' + esc(a.url) + '">' +
            esc(a.title || a.url || "about:blank") + "</span>" +
          '<span class="sp"></span>' +
          '<button class="btn small" id="aStop">Stop watching</button>' +
        "</div>" +
      "</div>";
  }

  function renderStage() {
    var stage = $("bStage");

    // The agent view is its own thing: it has no address of its own and must
    // render before the checks below, which are all about the address bar.
    if (S.view === "agent") { renderAgent(stage); return; }

    // Before anything else: a rejected address is an error in both views, and
    // showing a blank frame instead would look like the site failed to load.
    if (S.error && !S.loading) {
      stage.innerHTML = '<div class="blank"><div class="blank-in err">' +
        "<h2>Could not load that page</h2><p>" + esc(S.error) + "</p></div></div>";
      return;
    }

    if (!S.url) {
      stage.innerHTML =
        '<div class="blank"><div class="blank-in">' +
          "<h2>Browser</h2>" +
          "<p>Pages open beside your editor. <strong>Live</strong> frames the site; " +
          "<strong>Reader</strong> fetches it over the active endpoint&rsquo;s connection " +
          "&mdash; the same CAs, proxy and client certificate &mdash; and reduces it to text " +
          "the model can read.</p>" +
        "</div></div>";
      return;
    }

    if (S.view === "live") {
      // Rebuilt only when the address changes: replacing the node on every
      // render would reload the site and lose whatever the user was doing.
      var f = stage.querySelector("iframe");
      if (!f || f.getAttribute("data-url") !== S.url) {
        stage.innerHTML =
          '<iframe data-url="' + esc(S.url) + '" src="' + esc(S.url) + '" ' +
          'sandbox="allow-scripts allow-same-origin allow-forms allow-popups" ' +
          'referrerpolicy="no-referrer" title="Page"></iframe>' +
          '<div class="frame-note" id="bFrameNote" hidden></div>';
        var el = stage.querySelector("iframe");
        clearTimeout(frameTimer);
        S.frameBlocked = false;
        el.addEventListener("load", function () {
          clearTimeout(frameTimer);
          S.frameBlocked = false;
          var n = $("bFrameNote");
          if (n) n.hidden = true;
        });
        // A site that refuses framing emits no error at all, so the only
        // available signal is that nothing happened.
        frameTimer = setTimeout(function () {
          S.frameBlocked = true;
          var n = $("bFrameNote");
          if (n) {
            n.hidden = false;
            n.innerHTML =
              "<span>This site refuses to be displayed in a frame. Reader mode fetches it " +
              "directly and still works.</span>" +
              '<button class="btn sm primary" id="bToReader">Open in Reader</button>';
            var b = $("bToReader");
            if (b) b.addEventListener("click", function () { setView("reader"); });
          }
        }, 3500);
      }
      return;
    }

    /* reader */
    if (S.loading && !S.page) {
      stage.innerHTML = '<div class="blank"><div class="blank-in load">' + spinner(20) +
        "<span>Fetching&hellip;</span></div></div>";
      return;
    }
    if (!S.page) {
      stage.innerHTML = '<div class="blank"><div class="blank-in"><p>Nothing fetched yet.</p></div></div>';
      return;
    }

    var p = S.page;
    var links = "";
    if (p.links && p.links.length) {
      links = '<details class="links"><summary>' + p.links.length + " link" +
        (p.links.length === 1 ? "" : "s") + "</summary><ul>";
      for (var i = 0; i < p.links.length; i++) {
        links += '<li><a href="#" data-go="' + esc(p.links[i].href) + '">' +
          esc(p.links[i].text || p.links[i].href) + "</a></li>";
      }
      links += "</ul></details>";
    }
    stage.innerHTML =
      '<article class="reader">' +
        (p.title ? "<h1>" + esc(p.title) + "</h1>" : "") +
        '<div class="src">' + esc(p.finalUrl) + "</div>" +
        (p.truncated ? '<div class="cut">Truncated for length.</div>' : "") +
        "<pre>" + esc(p.text || "(no text on this page)") + "</pre>" +
        links +
      "</article>";
  }

  function renderBar() {
    $("bBack").disabled = S.at <= 0;
    $("bFwd").disabled = S.at < 0 || S.at >= S.history.length - 1;
    $("bBusy").innerHTML = S.loading ? spinner(13) : "";
    $("bLive").setAttribute("aria-pressed", S.view === "live" ? "true" : "false");
    $("bRead").setAttribute("aria-pressed", S.view === "reader" ? "true" : "false");
    $("bAgentView").setAttribute("aria-pressed", S.view === "agent" ? "true" : "false");
    var agent = $("bAgent");
    agent.disabled = !(S.page && S.page.text);
    $("bExt").disabled = !S.url;
  }

  function renderFoot() {
    var f = $("bFoot");
    if (S.error) { f.innerHTML = '<span class="bad">' + esc(S.error) + "</span>"; return; }
    if (!S.page) { f.innerHTML = S.loading ? "<span>Loading&hellip;</span>" : ""; return; }
    var p = S.page;
    var kb = p.bytes < 1024 ? p.bytes + " B" : (p.bytes / 1024).toFixed(1) + " KB";
    f.innerHTML =
      '<span class="st" data-ok="' + (p.status < 400 ? "1" : "0") + '">' + p.status + "</span>" +
      "<span>" + esc(p.contentType.split(";")[0] || "unknown") + "</span>" +
      "<span>" + kb + "</span>" +
      "<span>" + p.ms + "ms</span>" +
      '<span class="sp"></span>' +
      '<span class="muted">Fetched on the active endpoint&rsquo;s connection</span>';
  }

  function render() { renderBar(); renderStage(); renderFoot(); }

  function setView(v) {
    S.view = v;
    // The reader needs a fetch; the frame does not. Asking for one only when
    // the reader is actually shown keeps Live as cheap as a plain iframe.
    if (v === "reader" && S.url && !S.page && !S.loading) post("browserOpen", { url: S.url });
    render();
  }

  /**
   * The same address rules the host applies, applied here too.
   *
   * The frame needs them more than the fetch does: `example.com` handed to an
   * <iframe> is a *relative* URL, so it resolves against this document's own
   * origin and loads nothing - which is how everybody types an address. The
   * host normalising it for the fetch never reached the frame.
   */
  function normalise(raw) {
    var s = String(raw || "").trim();
    if (!s) return "";
    var m = /^([a-z][a-z0-9+.-]*):(\/\/)?/i.exec(s);
    if (m) {
      var scheme = m[1].toLowerCase();
      // `localhost:3000` is a port, not a scheme.
      var isPort = !m[2] && /^\d/.test(s.slice(m[0].length));
      if (!isPort && scheme !== "http" && scheme !== "https") {
        S.error = "Only http and https are supported, not " + scheme + ":";
        return "";
      }
    }
    return /^https?:\/\//i.test(s) ? s : "https://" + s.replace(/^https?:/i, "");
  }

  function go(raw, fromHistory) {
    // An empty box is not a navigation. Clearing state first would discard a
    // visible error message and quietly return to the previous page, which
    // reads as the panel having done something.
    if (!fromHistory && !String(raw || "").trim()) return;

    S.error = "";
    var url = fromHistory ? raw : normalise(raw);
    if (!url) { render(); return; }
    S.url = url;
    S.page = null;
    S.error = "";
    $("bUrl").value = url;
    if (!fromHistory) {
      // Forward entries are discarded on a new navigation, as everywhere else.
      S.history = S.history.slice(0, S.at + 1);
      S.history.push(url);
      S.at = S.history.length - 1;
    }
    if (S.view === "reader") post("browserOpen", { url: url });
    render();
  }

  function wire() {
    var input = $("bUrl");
    input.addEventListener("keydown", function (e) {
      if (e.key !== "Enter") return;
      e.preventDefault();
      go(input.value.trim());
    });
    $("bGo").addEventListener("click", function () {
      if (S.loading) { post("browserStop"); S.loading = false; render(); return; }
      if (!S.url) return;
      S.page = null;
      if (S.view === "reader") post("browserOpen", { url: S.url });
      else {
        // Force the frame to rebuild: same address, so renderStage would
        // otherwise leave it exactly as it is.
        var f = $("bStage").querySelector("iframe");
        if (f) f.removeAttribute("data-url");
      }
      render();
    });
    $("bBack").addEventListener("click", function () {
      if (S.at <= 0) return;
      S.at--;
      go(S.history[S.at], true);
    });
    $("bFwd").addEventListener("click", function () {
      if (S.at >= S.history.length - 1) return;
      S.at++;
      go(S.history[S.at], true);
    });
    $("bLive").addEventListener("click", function () { setView("live"); });
    $("bRead").addEventListener("click", function () { setView("reader"); });
    $("bAgentView").addEventListener("click", function () { setView("agent"); });

    /* The launcher's controls are inside the stage and the stage is rebuilt on
       every frame, so binding them individually would attach a new listener
       sixty times a second. Delegated once instead. */
    $("bStage").addEventListener("click", function (e) {
      if (e.target.closest("#aStart")) {
        S.agent.error = "";
        S.agent.live = true;      // show the spinner while the browser starts
        render();
        post("agentStart");
        return;
      }
      if (e.target.closest("#aStop")) { post("agentStop"); return; }
      if (e.target.closest("#aClose")) { post("agentClose"); return; }
    });
    $("bExt").addEventListener("click", function () { post("browserExternal", { url: S.url }); });
    $("bAgent").addEventListener("click", function () {
      if (!S.page || !S.page.text) return;
      post("browserToAgent", { url: S.page.finalUrl, text: S.page.text });
    });
    $("bStage").addEventListener("click", function (e) {
      var a = e.target.closest("[data-go]");
      if (!a) return;
      e.preventDefault();
      go(a.getAttribute("data-go"));
    });
  }

  window.addEventListener("message", function (event) {
    var m = event.data;
    if (!m || !m.type) return;
    switch (m.type) {
      case "agentFrame":
        // Replaced in place: the previous frame is never worth keeping, and
        // holding them would be a memory leak measured in megabytes a minute.
        S.agent.frame = m.data;
        S.agent.live = true;
        if (S.view === "agent") renderStage();
        break;

      case "agentState":
        // Two independent facts: whether a browser exists, and whether frames
        // are flowing into this panel. Tracking only the first left a stopped
        // stream showing its last frame, which is the one thing a live view
        // must never do - a stale picture and a current one look identical.
        S.agent.running = Boolean(m.running);
        S.agent.live = Boolean(m.live);
        S.agent.url = m.url || "";
        S.agent.title = m.title || "";
        if (!S.agent.live) S.agent.frame = null;
        render();
        break;

      case "agentError":
        S.agent.error = String(m.message || "");
        S.agent.live = false;
        render();
        break;

      case "browserLoading":
        S.loading = true;
        S.error = "";
        render();
        break;
      case "browserPage":
        S.loading = false;
        S.page = m.page;
        S.error = "";
        if (m.page && m.page.finalUrl) $("bUrl").value = m.page.finalUrl;
        render();
        break;
      case "browserError":
        S.loading = false;
        S.error = m.message || "Unknown error";
        render();
        break;
    }
  });

  mount();
  wire();
  render();
})();
