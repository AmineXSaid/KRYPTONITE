/**
 * Searching the web without driving a browser at a search page.
 *
 * The reason this file exists is a question worth writing down: why does web
 * search work in Claude and Copilot and not here?
 *
 * Not because they defeat the CAPTCHA. Because they never meet one. Their
 * search is a server-side call to a search endpoint - no browser, no page, no
 * bot check. Driving a headless Chromium at google.com/search is a different
 * activity that happens to have the same goal, and it fails for reasons that
 * have nothing to do with the query:
 *
 *   - the profile is minted fresh in a temp directory on every launch, so the
 *     browser has no cookies, no history and no age;
 *   - it is headless, which Chrome announces in its own user agent;
 *   - it arrives at a search results URL directly, having visited nothing.
 *
 * Any one of those is survivable. Together they describe a bot exactly, and
 * Google answers with /sorry/index. The fix is not to look less like a bot. It
 * is to stop using a browser for the one job a browser is worst at.
 *
 * So: an HTTP search, through the active profile's dispatcher - which means it
 * reaches whatever the model's own endpoint reaches, including through a
 * corporate proxy and a private CA. That is the part a hosted search API
 * cannot do, and the reason this is worth having rather than a key to someone
 * else's service.
 */

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/**
 * DuckDuckGo's HTML endpoint.
 *
 * Chosen because it answers a plain GET with plain HTML and no key, which is
 * the only option that works in an air-gapped-ish deployment where nobody is
 * going to be issued an API key for anything. The lite host is markup a parser
 * can rely on rather than an application.
 */
export const SEARCH_URL = "https://html.duckduckgo.com/html/";

export function searchUrl(query: string): string {
  return `${SEARCH_URL}?q=${encodeURIComponent(query)}`;
}

/** Strip tags and decode the handful of entities that actually appear. */
function plain(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&(amp|lt|gt|quot|#39|nbsp|hellip|mdash|ndash);/g, (_m, e) =>
      ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " ", hellip: "…", mdash: "-", ndash: "-" } as any)[e] ?? " "
    )
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Pull the real destination out of a result link.
 *
 * Results are wrapped in a redirector - `//duckduckgo.com/l/?uddg=<encoded>` -
 * and handing the model that instead of the destination means it cannot tell
 * two results apart, cannot judge a source, and follows a link it cannot read.
 */
export function unwrapUrl(href: string): string {
  const m = /[?&]uddg=([^&]+)/.exec(href);
  if (m) {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      /* fall through to the raw href */
    }
  }
  return href.startsWith("//") ? "https:" + href : href;
}

/**
 * Results out of the HTML.
 *
 * Written against the shape of the page rather than with a DOM, because this
 * runs in the extension host where there is no DOM, and pulling one in for
 * three fields would be the largest dependency in the project.
 */
export function parseResults(html: string, limit = 10): SearchResult[] {
  const out: SearchResult[] = [];
  // Each result is an anchor carrying result__a, then a snippet anchor or div
  // carrying result__snippet. Attribute order varies, so both are matched by
  // class rather than by position.
  const re = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippets: string[] = [];
  const sre = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|td)>/gi;
  for (let m = sre.exec(html); m; m = sre.exec(html)) snippets.push(plain(m[1]));

  let i = 0;
  for (let m = re.exec(html); m && out.length < limit; m = re.exec(html)) {
    const url = unwrapUrl(m[1]);
    const title = plain(m[2]);
    // An advert or a malformed row has no title worth showing, and a result
    // with no destination is not a result.
    if (!title || !/^https?:\/\//i.test(url)) {
      i++;
      continue;
    }
    out.push({ title, url, snippet: snippets[i] ?? "" });
    i++;
  }
  return out;
}

/** Rendered for the model: numbered, with the destination on its own line. */
export function renderResults(query: string, results: SearchResult[]): string {
  if (!results.length) {
    return `No results for ${JSON.stringify(query)}. Try different words, or use browser open if you already know the address.`;
  }
  return (
    `${results.length} result${results.length === 1 ? "" : "s"} for ${JSON.stringify(query)}:\n\n` +
    results
      .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`)
      .join("\n\n") +
    `\n\nUse browser open or fetch_url on one of these addresses to read it.`
  );
}

/**
 * Is this page a bot check rather than the thing that was asked for?
 *
 * Worth detecting precisely because of how it fails otherwise. The model asks
 * for a search, receives twenty lines of "Our systems have detected unusual
 * traffic from your computer network", and has no way to tell that from a page
 * that genuinely says that. What it did next, in the transcript that prompted
 * this work, was apologise and give up - which is the correct response to the
 * text it was given and the wrong response to the situation.
 */
export function looksLikeBotWall(url: string, text: string): string | undefined {
  const u = url.toLowerCase();
  const t = text.toLowerCase();

  // The URL is the strongest signal: these paths exist only for this purpose.
  if (/google\.[^/]+\/sorry\//.test(u)) return "Google's bot check";
  // A path *segment*, not the substring. `captcha` anywhere in the URL also
  // matches an article at /how-captchas-work, and a false positive here is
  // much worse than a miss: it makes the browser refuse to read ordinary
  // pages that merely discuss the subject.
  if (/\/recaptcha(?:[/?]|$)/.test(u) || /\/captcha(?:[/?]|$)/.test(u)) return "a CAPTCHA page";
  if (/bing\.com\/turing/.test(u)) return "Bing's bot check";

  // Then the wording, which is stable across these services because it is
  // written for humans who need to understand what happened.
  if (/unusual traffic from your computer network/.test(t)) return "a bot check";
  if (/verify (?:you are|you're) (?:a )?human/.test(t)) return "a human-verification page";
  if (/enable javascript and cookies to continue/.test(t)) return "a bot check";
  if (/checking your browser before accessing/.test(t)) return "an interstitial bot check";
  if (/^\s*just a moment\.\.\./.test(t)) return "an interstitial bot check";

  return undefined;
}

/**
 * What to tell the model instead of the wall of text.
 *
 * Names what happened, says it is not a failure it can retry its way out of,
 * and points at the thing that does work. Without the last part a model
 * reasonably concludes the web is unavailable.
 */
export function botWallAdvice(what: string, url: string): string {
  return (
    `${url}\n\nThis is ${what}, not the page that was asked for. ` +
    `The site refused the request because it is coming from an automated browser.\n\n` +
    `Do not try to get past it - retrying, waiting or changing the wording will not help, ` +
    `and defeating it is not something to attempt.\n\n` +
    `Use the web_search tool instead: it queries a search service over HTTP rather than ` +
    `driving a browser at a search page, so it is not subject to this check. ` +
    `Then use browser open or fetch_url on one of the addresses it returns.`
  );
}
