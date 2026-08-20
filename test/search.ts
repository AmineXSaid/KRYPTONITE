/**
 * Web search, and the bot walls it exists to avoid.
 *
 * The question behind this file: why does search work in Claude and Copilot
 * and not here? Not because they defeat the CAPTCHA - because they never meet
 * one. Their search is a server-side call to a search endpoint. Driving a
 * headless Chromium at google.com/search is a different activity with the same
 * goal, and it fails for reasons unrelated to the query.
 *
 * So the assertions are about two things: getting real results out of real
 * search HTML, and recognising a bot wall precisely enough to tell the model
 * something it can act on instead of twenty lines of "unusual traffic".
 *
 * Run: npx esbuild test/search.ts --bundle --outfile=dist/search.cjs \
 *        --format=cjs --platform=node --target=node20 && node dist/search.cjs
 */
import {
  searchUrl, parseResults, renderResults, unwrapUrl,
  looksLikeBotWall, botWallAdvice, SEARCH_URL,
  buildSearch, parseProvider,
} from "../src/browser/search";

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = ""): void {
  if (cond) pass++;
  else failures.push(name + (detail ? "  — " + detail : ""));
}
function eq(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a === b) pass++;
  else failures.push(`${name}\n      expected ${b}\n      actual   ${a}`);
}

/* ── the query URL ──────────────────────────────────────────────────────── */
{
  ok("the query is escaped", searchUrl("a b&c").includes("a%20b%26c"));
  ok("and hits the HTML endpoint", searchUrl("x").startsWith(SEARCH_URL));
  ok("a quoted phrase survives", searchUrl('"exact phrase"').includes("%22exact%20phrase%22"));
}

/* ── unwrapping the redirector ──────────────────────────────────────────── */
{
  // Results are wrapped. Handing the model the redirector means it cannot
  // judge a source or tell two results apart.
  eq("the redirect is unwrapped",
    unwrapUrl("//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&rut=x"),
    "https://example.com/a");
  eq("a plain absolute url is left alone",
    unwrapUrl("https://example.com/b"), "https://example.com/b");
  eq("a protocol-relative url gets a scheme",
    unwrapUrl("//example.com/c"), "https://example.com/c");
  // A malformed encoding must not throw in the middle of a search.
  ok("a broken encoding does not throw", typeof unwrapUrl("//duckduckgo.com/l/?uddg=%E0%A4%A") === "string");
}

/* ── parsing ────────────────────────────────────────────────────────────── */
{
  const HTML = `
<div class="result results_links">
  <h2 class="result__title">
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fone">First &amp; best result</a>
  </h2>
  <a class="result__snippet" href="#">A snippet describing the <b>first</b> result.</a>
</div>
<div class="result results_links">
  <h2 class="result__title">
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Ftwo">Second result</a>
  </h2>
  <a class="result__snippet" href="#">Another snippet &hellip; with an entity.</a>
</div>`;

  const r = parseResults(HTML);
  eq("both results are found", r.length, 2);
  eq("the title is decoded", r[0].title, "First & best result");
  eq("the destination is the real address", r[0].url, "https://example.com/one");
  eq("the snippet loses its markup", r[0].snippet, "A snippet describing the first result.");
  eq("entities in snippets are decoded", r[1].snippet, "Another snippet … with an entity.");
  eq("the second destination too", r[1].url, "https://example.org/two");

  eq("the limit is honoured", parseResults(HTML, 1).length, 1);
  eq("an empty page yields nothing", parseResults(""), []);
  // A results page that is really a bot check has no results in it, and must
  // not produce garbage ones.
  eq("a page with no results yields nothing", parseResults("<html><body>nope</body></html>"), []);

  // A row whose href is not a real destination is not a result.
  const bad = `<a class="result__a" href="javascript:void(0)">Sponsored</a>`;
  eq("a non-http destination is dropped", parseResults(bad), []);
}

/* ── rendering ──────────────────────────────────────────────────────────── */
{
  const out = renderResults("kryptonite", [
    { title: "One", url: "https://a.example/1", snippet: "first" },
    { title: "Two", url: "https://b.example/2", snippet: "" },
  ]);
  ok("results are numbered", /1\. One/.test(out) && /2\. Two/.test(out), out);
  ok("each carries its address", out.includes("https://a.example/1"), out);
  ok("a missing snippet is not a blank line", !/\n\s*\n\s*\n/.test(out), JSON.stringify(out));
  // Without this the model has results and no idea what to do with them.
  ok("it says what to do next", /browser open or fetch_url/.test(out), out);

  const none = renderResults("nothing at all", []);
  ok("no results is not an error", /no results/i.test(none), none);
  ok("and suggests a way forward", /different words|browser open/i.test(none), none);
}

/* ── choosing a provider ────────────────────────────────────────────────── */
{
  const dd = buildSearch("cats", { provider: "duckduckgo" });
  eq("the default needs no key", dd.kind, "html");
  ok("and hits the keyless endpoint", dd.url.startsWith(SEARCH_URL), dd.url);

  const brave = buildSearch("cats", { provider: "brave", apiKey: "K" }, 5);
  eq("brave is a json api", brave.kind, "brave");
  ok("carrying the key in a header", brave.headers["x-subscription-token"] === "K");
  ok("and the count", brave.url.includes("count=5"), brave.url);
  ok("the key never reaches the url", !brave.url.includes("K"), brave.url);

  const g = buildSearch("cats", { provider: "google", apiKey: "K", engineId: "E" });
  eq("google is a json api", g.kind, "google");
  ok("with the engine id", g.url.includes("cx=E"), g.url);

  const bing = buildSearch("cats", { provider: "bing", apiKey: "K" });
  eq("bing is a json api", bing.kind, "bing");
  ok("carrying the key in a header", bing.headers["Ocp-Apim-Subscription-Key"] === "K");

  // A provider named without its credential must degrade to a working search.
  // The alternative is that one mistyped setting silently removes web search.
  eq("brave without a key falls back", buildSearch("x", { provider: "brave" }).kind, "html");
  eq("google without an engine id falls back",
    buildSearch("x", { provider: "google", apiKey: "K" }).kind, "html");
  eq("bing without a key falls back", buildSearch("x", { provider: "bing" }).kind, "html");

  ok("the limit is clamped", buildSearch("x", { provider: "brave", apiKey: "K" }, 999).url.includes("count=20"));
}

/* ── reading four wire formats ──────────────────────────────────────────── */
{
  eq("brave results are read",
    parseProvider("brave", JSON.stringify({
      web: { results: [{ title: "T", url: "https://a.example", description: "D" }] },
    })),
    [{ title: "T", url: "https://a.example", snippet: "D" }]);

  eq("google results are read",
    parseProvider("google", JSON.stringify({
      items: [{ title: "T", link: "https://b.example", snippet: "D" }],
    })),
    [{ title: "T", url: "https://b.example", snippet: "D" }]);

  eq("bing results are read",
    parseProvider("bing", JSON.stringify({
      webPages: { value: [{ name: "T", url: "https://c.example", snippet: "D" }] },
    })),
    [{ title: "T", url: "https://c.example", snippet: "D" }]);

  // These are third-party responses. A changed field name should cost a
  // result, not throw inside a tool call.
  eq("malformed json yields nothing", parseProvider("brave", "not json"), []);
  eq("a missing results array yields nothing", parseProvider("brave", "{}"), []);
  eq("a row with no url is dropped",
    parseProvider("brave", JSON.stringify({ web: { results: [{ title: "T" }] } })), []);
  eq("a row with no title is dropped",
    parseProvider("google", JSON.stringify({ items: [{ link: "https://x.example" }] })), []);
  eq("html goes through the scraper", parseProvider("html", ""), []);
}

/* ── recognising a bot wall ─────────────────────────────────────────────── */
{
  // The exact page from the transcript that prompted this work.
  ok("Google's sorry page is recognised by url",
    !!looksLikeBotWall("https://www.google.com/sorry/index?continue=https://www.google.com/search", ""));
  ok("and by its wording",
    !!looksLikeBotWall("https://example.com/", "Our systems have detected unusual traffic from your computer network."));
  ok("a recaptcha page is recognised", !!looksLikeBotWall("https://x.com/recaptcha/api2/demo", ""));
  ok("Bing's check is recognised", !!looksLikeBotWall("https://www.bing.com/turing/captcha/challenge", ""));
  ok("an interstitial is recognised",
    !!looksLikeBotWall("https://x.example/", "Checking your browser before accessing x.example."));
  ok("a human-verification page is recognised",
    !!looksLikeBotWall("https://x.example/", "Please verify you are human to continue."));

  // The far more important half: an ordinary page must not be mistaken for
  // one, or the browser starts refusing to read the web.
  ok("an ordinary page is not a wall",
    !looksLikeBotWall("https://example.com/", "This domain is for use in illustrative examples."));
  ok("a news article about CAPTCHAs is not a wall",
    !looksLikeBotWall("https://news.example/article/how-captchas-work",
      "CAPTCHAs are used by websites to tell humans and bots apart."));
  ok("a search result page is not a wall",
    !looksLikeBotWall("https://html.duckduckgo.com/html/?q=x", "10 results for x"));
}

/* ── what the model is told instead ─────────────────────────────────────── */
{
  const a = botWallAdvice("Google's bot check", "https://www.google.com/sorry/index");
  ok("it names what happened", /Google's bot check/.test(a), a);
  ok("and says it is not the page asked for", /not the page that was asked for/.test(a), a);
  // Without this the model retries the same call until the turn ends.
  ok("it says retrying will not help", /retrying, waiting or changing the wording will not help/.test(a), a);
  // And without this it concludes the web is simply unavailable and gives up,
  // which is exactly what happened before this existed.
  ok("it names the tool that does work", /web_search/.test(a), a);
  ok("and what to do with the results", /browser open or fetch_url/.test(a), a);
  // It must not read as an instruction to defeat the check.
  ok("it does not suggest getting past it", /Do not try to get past it/.test(a), a);
}

console.log(`\n${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log("  FAIL  " + f);
process.exit(failures.length ? 1 : 0);
