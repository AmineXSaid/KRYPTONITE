/**
 * The browser as the model reaches it: one action name, a bag of arguments,
 * one string back.
 *
 * The page helpers underneath were already well covered. This layer was not,
 * and it is the one every capability actually arrives through - so a helper
 * that works perfectly is worth nothing if the action calling it reads
 * `a.value` where the schema promised `a.text`. Nothing catches that but a
 * test that calls the action the way a model does.
 *
 * Driven against a real Chromium and a real page, because the whole question
 * is whether the reply is something a model could act on next.
 *
 * Three properties are asserted for every action, since together they are what
 * "the model can use this" means:
 *
 *   It answers.        Never empty, never a bare "ok".
 *   It says what it did and what the page looks like now, for anything that
 *                      changed the page - otherwise a second call is needed
 *                      just to find out whether the first one worked.
 *   It fails usefully. A missing argument is answered with the name of the
 *                      argument, not a CDP stack trace.
 *
 * Skips itself, loudly, when no browser is installed.
 *
 * Run: npx esbuild test/browser-agent.ts --bundle --outfile=dist/browser-agent.cjs \
 *        --format=cjs --platform=node --target=node20 && node dist/browser-agent.cjs
 */
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { CdpBrowser, listBrowsers } from "../src/browser/cdp";
import {
  runBrowserAction,
  BROWSER_ACTIONS,
  MUTATING,
  BrowserDeps,
  BrowserResult,
} from "../src/browser/actions";

let pass = 0;
const failures: string[] = [];
function ok(label: string, cond: boolean, detail = ""): void {
  if (cond) { pass++; return; }
  failures.push(label + (detail ? "  — " + detail : ""));
}

const PAGE = `<!doctype html><html><head>
<title>Fixture</title><meta name="viewport" content="width=device-width">
</head><body>
  <h1>Kryptonite fixture</h1>
  <p>A paragraph of prose long enough to be recognisable as article text when
     the reader extracts it, rather than being mistaken for chrome.</p>
  <a id="go" href="/second">Go to the second page</a>
  <button id="btn" onclick="document.getElementById('out').textContent='clicked'">Press me</button>
  <input id="field" type="text" placeholder="Type here">
  <select id="pick"><option value="a">Apple</option><option value="b">Banana</option></select>
  <input id="check" type="checkbox">
  <div id="out">idle</div>
  <div id="hovertarget" onmouseover="document.getElementById('out').textContent='hovered'">Hover me</div>
  <img src="/pic.png" width="200" height="200" alt="A red square used to check that alt text reaches the model">
  <div style="height:3000px"></div>
  <button id="deep" onclick="document.getElementById('out').textContent='deep clicked'">Far below the fold</button>
  <script>
    console.log("fixture ready");
    console.error("a deliberate error");
    fetch("/api/ok").catch(function () {});
    fetch("/api/missing").catch(function () {});
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") document.getElementById("out").textContent = "escaped";
    });
    setTimeout(function () {
      var d = document.createElement("div");
      d.id = "late";
      d.textContent = "arrived late";
      document.body.appendChild(d);
    }, 300);
  </script>
</body></html>`;

const SECOND = `<!doctype html><html><head><title>Second</title></head>
<body><h1>The second page</h1><p>You navigated here.</p></body></html>`;

// A 1x1 red PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

function serve() {
  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    if (url.startsWith("/second")) {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(SECOND);
    } else if (url.startsWith("/pic.png")) {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(PNG);
    } else if (url.startsWith("/api/ok")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    } else if (url.startsWith("/huge")) {
      // 800 links, only the first handful in the viewport. The shape of a
      // navigation-heavy page, which is what the element cap exists for.
      const links = Array.from(
        { length: 800 },
        (_, i) => `<div><a href="/second?i=${i}">Link number ${i}</a></div>`
      ).join("");
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><html><head><title>Huge</title></head><body>${links}</body></html>`);
    } else if (url.startsWith("/sorry/")) {
      // Google's bot wall, near enough. This is the page that came back in the
      // transcript that prompted the work: the model received twenty lines of
      // it, could not tell it from a page that genuinely says that, and
      // apologised and gave up.
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><html><head><title>Error 429</title></head><body>
        <h1>About this page</h1>
        <p>Our systems have detected unusual traffic from your computer network.
        This page checks to see if it is really you sending the requests.</p>
        <a href="#">Why did this happen?</a></body></html>`);
    } else if (url.startsWith("/api/missing")) {
      res.writeHead(404);
      res.end("no");
    } else {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(PAGE);
    }
  });
  return {
    server,
    listen: () =>
      new Promise<number>((r) => server.listen(0, "127.0.0.1", () => r((server.address() as any).port))),
  };
}

const textOf = (r: BrowserResult): string => (typeof r === "string" ? r : r.text);

void (async () => {
  /* ── parity, which needs no browser ───────────────────────────────────── */
  {
    // Every action the schema advertises must have a branch, and every branch
    // must be advertised. Both directions fail silently in production: an
    // unimplemented action throws at the model, and an unadvertised one is a
    // capability it is never told it has.
    const { TOOL_DEFS } = await import("../src/agent/tools");
    const browserTool = TOOL_DEFS.find((t) => t.name === "browser");
    ok("the browser tool is in the schema the model is sent", !!browserTool);
    if (browserTool) {
      const declared: string[] = (browserTool.parameters as any).properties.action.enum;
      ok("the schema advertises every implemented action",
        BROWSER_ACTIONS.every((x) => declared.includes(x)),
        JSON.stringify({ declared, impl: BROWSER_ACTIONS }));
      ok("and implements every advertised action",
        declared.every((x) => (BROWSER_ACTIONS as readonly string[]).includes(x)),
        JSON.stringify(declared));

      // Every argument the schema names must be one an action actually reads.
      // A promised argument nobody reads is a silent no-op: the model sets it,
      // the call succeeds, and nothing happens.
      const args = Object.keys((browserTool.parameters as any).properties).filter((k) => k !== "action");
      const src = fs.readFileSync(path.join(__dirname, "..", "src", "browser", "actions.ts"), "utf8");
      for (const k of args) {
        ok(`the schema's "${k}" is read by the implementation`,
          src.includes(`a.${k}`) || src.includes(`need(a, "${k}"`), k);
      }
    }

    // Every action that changes the page must re-check the origin first, or a
    // ref from before a navigation is applied to whatever is there now.
    for (const m of ["click", "type", "set", "key", "hover", "eval"]) {
      ok(`${m} is treated as mutating`, MUTATING.has(m));
    }
    for (const r of ["read", "text", "find", "console", "network", "screenshot"]) {
      ok(`${r} is not treated as mutating`, !MUTATING.has(r));
    }
  }

  const found = listBrowsers();
  if (!found.length) {
    console.log("──── skipped: no Chromium-family browser on this machine ────");
    console.log(`\n${pass} passed, ${failures.length} failed`);
    process.exit(failures.length ? 1 : 0);
  }

  const s = serve();
  const port = await s.listen();
  const base = `http://127.0.0.1:${port}/`;

  const cdp = new CdpBrowser(found[0].path);
  await cdp.launch({ viewport: { width: 1280, height: 800 } });

  let lastUrl = "";
  const shots: Array<{ bytes: Buffer; mediaType: string }> = [];
  const deps = (vision: boolean): BrowserDeps => ({
    onUrl: (u) => { lastUrl = u; },
    saveShot: (bytes, mediaType) => {
      shots.push({ bytes, mediaType });
      return ".agent/screenshots/test.png";
    },
    vision,
  });

  /** Call an action the way the model does. */
  const run = (action: string, a: Record<string, unknown> = {}, vision = false) =>
    runBrowserAction(cdp, action, a, deps(vision), lastUrl);

  try {
    /* ── open ─────────────────────────────────────────────────────────── */
    {
      const r = textOf(await run("open", { url: base }));
      ok("open returns the page", r.length > 0);
      ok("open names the title", /Fixture/.test(r), r.slice(0, 200));
      ok("open records the url for the fence", lastUrl.includes("127.0.0.1"), lastUrl);
    }

    /* ── read ─────────────────────────────────────────────────────────── */
    let btnRef = "";
    let fieldRef = "";
    {
      const r = textOf(await run("read"));
      ok("read returns the page", r.length > 0);
      ok("read shows the heading", /Kryptonite fixture/.test(r), r.slice(0, 300));
      // Refs are what everything else acts on. Without them read is useless.
      ok("read hands back refs", /\[?ref_?\d+\]?|\[e\d+\]/i.test(r), r.slice(0, 400));
      // alt text is the thing innerText cannot carry, and a gallery without it
      // reads as an empty page.
      ok("read carries the image's alt text", /red square/i.test(r), r.slice(0, 800));

      const refs = [...r.matchAll(/\[([a-z]*_?\d+)\]/gi)].map((m) => m[1]);
      ok("read produced usable ref tokens", refs.length > 0, r.slice(0, 300));

      const found2 = textOf(await run("find", { text: "Press me" }));
      const m = found2.match(/\[([a-z]*_?\d+)\]/i);
      btnRef = m ? m[1] : "";
      const ff = textOf(await run("find", { text: "Type here" }));
      const m2 = ff.match(/\[([a-z]*_?\d+)\]/i);
      fieldRef = m2 ? m2[1] : "";
    }

    /* ── text ─────────────────────────────────────────────────────────── */
    {
      const r = textOf(await run("text"));
      ok("text returns the prose", /paragraph of prose/.test(r), r.slice(0, 300));
      // The point of `text` over `read` is that it is cheaper to read.
      ok("text is shorter than read", r.length < textOf(await run("read")).length);
    }

    /* ── find ─────────────────────────────────────────────────────────── */
    {
      const hit = textOf(await run("find", { text: "Press me" }));
      ok("find locates a control", /press me/i.test(hit), hit.slice(0, 200));
      ok("find returns a ref to act on", /\[[a-z]*_?\d+\]/i.test(hit), hit.slice(0, 200));

      const miss = textOf(await run("find", { text: "nothing like this exists" }));
      // A miss must not read as a broken tool, and must say what to do next.
      ok("a find with no matches says so", /nothing on the page matches/i.test(miss), miss);
      ok("and suggests the recovery", /read the page/i.test(miss), miss);
    }

    /* ── click ────────────────────────────────────────────────────────── */
    {
      ok("a ref was found to click", btnRef !== "");
      const r = textOf(await run("click", { ref: btnRef }));
      ok("click says what it clicked", r.includes(btnRef), r.slice(0, 120));
      // The page after the action, in the same reply. Without it the model has
      // to spend another call finding out whether anything happened.
      ok("click returns the page afterwards", /Kryptonite fixture/.test(r), r.slice(0, 300));
      ok("click actually fired the handler", /clicked/.test(r), r.slice(0, 600));
    }

    /* ── type ─────────────────────────────────────────────────────────── */
    {
      ok("a field ref was found", fieldRef !== "");
      const r = textOf(await run("type", { ref: fieldRef, text: "hello world" }));
      ok("type says where it typed", r.includes(fieldRef), r.slice(0, 120));
      const v = textOf(await run("eval", { expression: "document.getElementById('field').value" }));
      ok("type put the text in the field", /hello world/.test(v), v);

      await run("type", { ref: fieldRef, text: "replaced", clear: true });
      const v2 = textOf(await run("eval", { expression: "document.getElementById('field').value" }));
      ok("clear empties the field first", v2.includes("replaced") && !v2.includes("hello"), v2);
    }

    /* ── set ──────────────────────────────────────────────────────────── */
    {
      const sel = textOf(await run("find", { text: "Apple" }));
      const ref = (sel.match(/\[([a-z]*_?\d+)\]/i) ?? [])[1] ?? "";
      if (ref) {
        const r = textOf(await run("set", { ref, text: "b" }));
        ok("set reports the value it landed on", /set /i.test(r), r.slice(0, 120));
        const v = textOf(await run("eval", { expression: "document.getElementById('pick').value" }));
        ok("set changed the select", /b/.test(v), v);
      } else {
        ok("a select ref was findable", false, sel.slice(0, 200));
      }
    }

    /* ── key ──────────────────────────────────────────────────────────── */
    {
      const r = textOf(await run("key", { key: "Escape" }));
      ok("key says which key", /escape/i.test(r), r.slice(0, 120));
      ok("key returns the page afterwards", r.length > 40);
    }

    /* ── hover ────────────────────────────────────────────────────────── */
    {
      // Hovering needs a ref, so the target has to be something the tree
      // exposes. A bare div with an onmouseover is not, which is the case the
      // find message below exists for.
      const r = textOf(await run("hover", { ref: btnRef }));
      ok("hover says what it hovered", r.includes(btnRef), r.slice(0, 120));
      ok("hover returns the page afterwards", r.length > 40);
    }

    /* ── clicking something below the fold ────────────────────────────── */
    {
      // The most common real interaction there is, and the one that breaks if
      // coordinates are taken without scrolling first: the element is at y=3200
      // in a viewport 800 tall, so the click lands on nothing.
      await run("open", { url: base });
      const page = textOf(await run("read"));
      // The read has to say the control exists at all. Without this a model
      // could only find it by scrolling a guessed number of pixels and reading
      // again, with no way to know when to stop.
      ok("a read reaches controls below the fold",
        /Far below the fold/.test(page), page.slice(0, 900));
      ok("and separates them from what is on screen",
        /Further down the page/.test(page), page.slice(0, 900));
      ok("and says clicking one scrolls to it",
        /clicking one scrolls to it/.test(page), page.slice(0, 900));
      // The visible controls must still come first: the cap is 300, and a page
      // with thousands of links must not spend it on things nobody can see.
      ok("what is on screen is listed first",
        page.indexOf("Press me") < page.indexOf("Far below the fold"), "");

      const f = textOf(await run("find", { text: "Far below the fold" }));
      const ref = (f.match(/\[([a-z]*_?\d+)\]/i) ?? [])[1] ?? "";
      ok("an off-screen control is findable", ref !== "", f.slice(0, 300));
      if (ref) {
        const r = textOf(await run("click", { ref }));
        ok("clicking it works without scrolling there first",
          /deep clicked/.test(r), r.slice(0, 600));
      }
    }

    /* ── text that is on the page but not clickable ───────────────────── */
    {
      // The worst answer here is "nothing matches". The model read the page,
      // saw those exact words, asked where they were, and was told they do not
      // exist - so it concludes the read was wrong and starts over.
      const r = textOf(await run("find", { text: "Hover me" }));
      ok("find admits the text is there", /is on the page/i.test(r), r);
      ok("and explains why it has no ref", /not as anything clickable|text rather than/i.test(r), r);
      ok("and names a way forward", /eval|control near it/i.test(r), r);
      ok("this is different from the not-found answer", !/nothing on the page matches/i.test(r), r);
    }

    /* ── eval ─────────────────────────────────────────────────────────── */
    {
      const r = textOf(await run("eval", { expression: "1 + 1" }));
      ok("eval returns the value", /2/.test(r), r);
      // A statement evaluates to undefined, and answering with nothing at all
      // reads as a failure rather than as a result.
      const u = textOf(await run("eval", { expression: "void 0" }));
      ok("eval names an undefined result rather than answering empty",
        u.trim().length > 0, JSON.stringify(u));
    }

    /* ── console ──────────────────────────────────────────────────────── */
    {
      const r = textOf(await run("console"));
      ok("console returns what the page logged", /fixture ready/.test(r), r.slice(0, 400));
      const e = textOf(await run("console", { errorsOnly: true }));
      ok("errorsOnly keeps the errors", /deliberate error/.test(e), e.slice(0, 400));
      ok("and drops the rest", !/fixture ready/.test(e), e.slice(0, 400));
    }

    /* ── network ──────────────────────────────────────────────────────── */
    {
      const r = textOf(await run("network"));
      ok("network lists the requests", /api\/ok/.test(r), r.slice(0, 600));
      ok("network reports statuses", /200|404/.test(r), r.slice(0, 600));
      const e = textOf(await run("network", { errorsOnly: true }));
      ok("errorsOnly keeps the failures", /api\/missing/.test(e), e.slice(0, 400));
      ok("and drops the successes", !/api\/ok/.test(e), e.slice(0, 400));
    }

    /* ── wait ─────────────────────────────────────────────────────────── */
    {
      await run("open", { url: base });
      const r = textOf(await run("wait", { text: "arrived late" }));
      ok("wait blocks until the text appears", /arrived late/.test(r), r.slice(0, 400));

      const sel = textOf(await run("wait", { selector: "#late" }));
      ok("wait also takes a selector", sel.length > 0, sel.slice(0, 200));

      // The schema promises a third mode, and an unimplemented promise is
      // worse than no promise: the model uses it and gets nothing.
      const idle = textOf(await run("wait", {}));
      ok("wait with no argument waits for the network", /network|quiet/i.test(idle), idle.slice(0, 200));
      ok("and still returns the page", /Kryptonite fixture/.test(idle), idle.slice(0, 300));
    }

    /* ── eval before any read does not trip the origin guard ──────────── */
    {
      // `eval` is treated as mutating, so it re-checks the origin. With no read
      // yet there is no origin to compare against, and refusing there would
      // make the first eval of every session fail.
      lastUrl = "";
      const r = textOf(await run("eval", { expression: "document.title" }));
      ok("the first eval of a session is not refused", /Fixture/.test(r), r.slice(0, 200));
      await run("open", { url: base });
    }

    /* ── resize ───────────────────────────────────────────────────────── */
    {
      const r = textOf(await run("resize", { width: 390, height: 844 }));
      ok("resize reports the new viewport", /390/.test(r), r.slice(0, 200));
      ok("resize says when it is emulating a phone", /phone/i.test(r), r.slice(0, 200));
      const d = textOf(await run("resize", { width: 1280, height: 800, scheme: "dark" }));
      ok("resize reports the colour scheme it asked for", /dark/i.test(d), d.slice(0, 200));
      ok("resize returns the page afterwards", /Kryptonite fixture/.test(d), d.slice(0, 400));
    }

    /* ── scroll, back, forward ────────────────────────────────────────── */
    {
      const r = textOf(await run("scroll", { dy: 300 }));
      ok("scroll returns the page", r.length > 0);

      const link = textOf(await run("find", { text: "second page" }));
      const ref = (link.match(/\[([a-z]*_?\d+)\]/i) ?? [])[1] ?? "";
      if (ref) {
        const nav = textOf(await run("click", { ref }));
        ok("following a link lands on the new page", /second page/i.test(nav), nav.slice(0, 300));
        const back = textOf(await run("back"));
        ok("back returns to the previous page", /Kryptonite fixture/.test(back), back.slice(0, 300));
        const fwd = textOf(await run("forward"));
        ok("forward goes again", /second page/i.test(fwd), fwd.slice(0, 300));
        await run("back");
      } else {
        ok("the link was findable", false, link.slice(0, 200));
      }
    }

    /* ── screenshot ───────────────────────────────────────────────────── */
    {
      shots.length = 0;
      const blind = await run("screenshot", {}, false);
      const bt = textOf(blind);
      ok("screenshot saves a file", shots.length === 1);
      ok("screenshot names the path", /\.agent\/screenshots/.test(bt), bt.slice(0, 200));
      ok("screenshot says what it is of", /it is of/i.test(bt), bt.slice(0, 300));
      // Without vision the pixels are withheld, and the reply has to say why
      // and what to do instead - not silently return a picture-less picture.
      ok("without vision the pixels are withheld",
        typeof blind === "string" || !blind.images, bt.slice(0, 200));
      ok("and the reply explains why", /does not declare vision/.test(bt), bt.slice(0, 400));
      ok("and points at the alternative", /browser read/.test(bt), bt.slice(0, 400));

      const seeing = await run("screenshot", {}, true);
      ok("with vision the image is attached",
        typeof seeing !== "string" && !!seeing.images?.length);
      if (typeof seeing !== "string" && seeing.images?.length) {
        ok("the image carries a media type", /^image\//.test(seeing.images[0].mediaType),
          seeing.images[0].mediaType);
        ok("and real bytes", seeing.images[0].data.length > 100);
      }
    }

    /* ── failing usefully ─────────────────────────────────────────────── */
    {
      // A model can recover from "ref is required for hover". It cannot
      // recover from a CDP stack trace, and it will usually just retry the
      // same broken call.
      const cases: Array<[string, Record<string, unknown>, RegExp]> = [
        ["click", {}, /ref is required/i],
        ["type", {}, /ref is required/i],
        ["hover", {}, /ref is required/i],
        ["set", {}, /ref is required/i],
        ["key", {}, /required/i],
        ["eval", {}, /required/i],
        ["find", {}, /text is required/i],
        ["open", {}, /url is required/i],
      ];
      for (const [action, args, want] of cases) {
        let msg = "";
        try {
          await run(action, args);
        } catch (e: any) {
          msg = String(e?.message ?? e);
        }
        ok(`${action} with no argument names the argument`, want.test(msg), JSON.stringify(msg));
      }

      let unknown = "";
      try {
        await run("navigate", { url: base });
      } catch (e: any) {
        unknown = String(e?.message ?? e);
      }
      // A model that guessed a plausible name can correct itself from a list.
      ok("an unknown action is rejected", /unknown browser action/i.test(unknown), unknown);
      ok("and the valid ones are listed", /open, read, text/.test(unknown), unknown);
    }

    /* ── close ────────────────────────────────────────────────────────── */
    {
      // `close` is handled by the session before dispatch, so what matters
      // here is only that it is advertised - the session test covers the rest.
      ok("close is one of the advertised actions",
        (BROWSER_ACTIONS as readonly string[]).includes("close"));
    }

    /* ── a read stays affordable on a navigation-heavy page ───────────── */
    {
      // Listing off-screen controls removed the filter that used to bound this,
      // so the cap is now the only thing standing between a model and a page
      // that costs more to read than it is worth.
      const r = textOf(await run("open", { url: base + "huge" }));
      const refs = [...r.matchAll(/\[ref_\d+\]/g)].length;
      ok("the ref list is capped", refs <= 300, String(refs));
      ok("but it is not crippled - most of the cap is used", refs >= 250, String(refs));
      // The visible ones are the ones a screenshot would show, and losing them
      // to the cap would be the worst possible trade.
      ok("the controls in view survived the cap", /Link number 0"/.test(r), r.slice(0, 400));
      ok("and the page below is represented too", /Further down the page/.test(r), r.slice(0, 600));

      // The size the model actually pays for. A read of a big page should be
      // measured in tens of thousands of characters, not hundreds.
      ok("a read of an 800-link page stays under 40k characters", r.length < 40_000, String(r.length));
      // Printed because it is the number that decides whether this feature is
      // affordable, and it should be watched rather than merely bounded.
      console.log(`      an 800-link page reads as ${r.length} characters across ${refs} refs`);
      await run("open", { url: base });
    }

    /* ── a bot wall is named, not pasted ──────────────────────────────── */
    {
      const r = textOf(await run("open", { url: base + "sorry/index?continue=x" }));
      // The raw page must not come back. Handing the model the wall verbatim
      // is what made it apologise and stop, which is the right answer to that
      // text and the wrong answer to the situation.
      ok("the wall is not pasted into the reply",
        !/Why did this happen/.test(r), r.slice(0, 300));
      ok("it is named as a bot check", /bot check/i.test(r), r.slice(0, 300));
      ok("and said not to be the page asked for",
        /not the page that was asked for/.test(r), r.slice(0, 300));
      ok("retrying is ruled out", /will not help/.test(r), r.slice(0, 400));
      // Without this the model concludes the web is unavailable.
      ok("the tool that does work is named", /web_search/.test(r), r.slice(0, 400));
      // And a read of the same page must say the same thing, not fall back to
      // the raw snapshot.
      const again = textOf(await run("read"));
      ok("a read of the same page agrees", /bot check/i.test(again), again.slice(0, 200));

      await run("open", { url: base });
      ok("an ordinary page is unaffected",
        /Kryptonite fixture/.test(textOf(await run("read"))));
    }

    /* ── nothing answers empty ────────────────────────────────────────── */
    {
      await run("open", { url: base });
      const readOnly = ["read", "text", "console", "network", "screenshot"];
      for (const action of readOnly) {
        const r = textOf(await run(action));
        ok(`${action} never answers with an empty string`, r.trim().length > 0);
      }
    }
  } finally {
    await cdp.close();
    s.server.close();
  }

  if (failures.length) for (const f of failures) console.log("FAIL  " + f);
  console.log(`\n${pass} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();
