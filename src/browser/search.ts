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

import { request, Dispatcher } from "undici";
import { USER_AGENT } from "./fetchPage";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/**
 * Where a search actually goes.
 *
 * Copilot and Claude use a search API, and an API is better in every way that
 * matters: JSON instead of markup that changes, a rate limit that is stated
 * rather than discovered, and terms that permit the use. So a provider is
 * configurable, and the ones worth naming are here.
 *
 * The default is the keyless one, and that is not a compromise - it is the
 * case this extension exists for. Its users are behind corporate gateways and
 * in air-gapped deployments, and the person who cannot get an API key issued
 * for a new service is exactly the person who needs search to work out of the
 * box. A key makes it better; the absence of one must not make it useless.
 */
export type SearchProvider = "duckduckgo" | "brave" | "google" | "bing";

export interface ProviderConfig {
  provider: SearchProvider;
  /** From SecretStorage. Absent for duckduckgo, required by the rest. */
  apiKey?: string;
  /** Google's programmable-search engine id. Google only. */
  engineId?: string;
}

/** The keyless endpoint, and the default. Plain GET, plain HTML, no key. */
export const SEARCH_URL = "https://html.duckduckgo.com/html/";

/**
 * How long a search may take before it is abandoned.
 *
 * `fetchPage` budgets 30s for a whole document; a search returns a few
 * kilobytes of result rows and has no business taking longer. Without a budget
 * undici's own default applies, which is five minutes - long enough that a
 * provider which accepts the connection and then says nothing holds the turn
 * open past the point where anyone is still waiting for it.
 */
export const SEARCH_TIMEOUT_MS = 20_000;

export interface SearchRequest {
  url: string;
  headers: Record<string, string>;
  /** How to read the answer. HTML is scraped; the rest return JSON. */
  kind: "html" | "brave" | "google" | "bing";
}

/**
 * Build the request for the configured provider.
 *
 * Falls back to the keyless endpoint whenever a provider is named without the
 * credential it needs. A misconfigured key should degrade to a working search,
 * not to no search - the failure mode of the alternative is that someone types
 * a key wrong and web search silently stops existing.
 *
 * Every branch carries a `user-agent`, and that is not decoration. undici sends
 * none of its own, so these requests went out with no agent at all - which is
 * the one thing a search endpoint is most certain to refuse, because it is the
 * shape a scraper has and nothing else. The keyless default was the provider
 * that needed it most and the provider that had no key to fall back on, so the
 * out-of-the-box case - the case this whole file argues it exists for - was the
 * one that could not work. The other three carry it too: an API key identifies
 * the account, not the caller, and a search API is entitled to know which
 * client is calling it.
 */
export function buildSearch(query: string, cfg: ProviderConfig, limit = 8): SearchRequest {
  const q = encodeURIComponent(query);
  const n = Math.min(20, Math.max(1, limit));

  if (cfg.provider === "brave" && cfg.apiKey) {
    return {
      url: `https://api.search.brave.com/res/v1/web/search?q=${q}&count=${n}`,
      headers: {
        accept: "application/json",
        "user-agent": USER_AGENT,
        "x-subscription-token": cfg.apiKey,
      },
      kind: "brave",
    };
  }
  if (cfg.provider === "google" && cfg.apiKey && cfg.engineId) {
    return {
      url:
        `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(cfg.apiKey)}` +
        `&cx=${encodeURIComponent(cfg.engineId)}&q=${q}&num=${Math.min(10, n)}`,
      headers: { accept: "application/json", "user-agent": USER_AGENT },
      kind: "google",
    };
  }
  if (cfg.provider === "bing" && cfg.apiKey) {
    return {
      url: `https://api.bing.microsoft.com/v7.0/search?q=${q}&count=${n}`,
      headers: {
        accept: "application/json",
        "user-agent": USER_AGENT,
        "Ocp-Apim-Subscription-Key": cfg.apiKey,
      },
      kind: "bing",
    };
  }

  return {
    url: `${SEARCH_URL}?q=${q}`,
    headers: {
      accept: "text/html",
      "user-agent": USER_AGENT,
      // Without this the endpoint picks a language from the connection's
      // geography, so the same query answers in different languages from
      // different offices of the same company.
      "accept-language": "en",
    },
    kind: "html",
  };
}

/** Kept for the callers and tests that only ever wanted the keyless URL. */
export function searchUrl(query: string): string {
  return `${SEARCH_URL}?q=${encodeURIComponent(query)}`;
}

/**
 * One shape out of four wire formats.
 *
 * Every branch is defensive about missing fields. These are third-party
 * responses, and a provider that changes a field name should cost a result,
 * not throw inside a tool call.
 */
export function parseProvider(kind: SearchRequest["kind"], body: string, limit = 8): SearchResult[] {
  if (kind === "html") return parseResults(body, limit);

  let json: any;
  try {
    json = JSON.parse(body);
  } catch {
    return [];
  }

  const rows: any[] =
    kind === "brave" ? json?.web?.results ?? []
    : kind === "google" ? json?.items ?? []
    : json?.webPages?.value ?? [];

  const out: SearchResult[] = [];
  for (const r of rows) {
    const url = String(r?.url ?? r?.link ?? "");
    const title = String(r?.title ?? r?.name ?? "").trim();
    if (!title || !/^https?:\/\//i.test(url)) continue;
    out.push({
      title,
      url,
      snippet: String(r?.description ?? r?.snippet ?? r?.extra_snippets?.[0] ?? "").replace(/<[^>]*>/g, "").trim(),
    });
    if (out.length >= limit) break;
  }
  return out;
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

/**
 * Rendered for the model: numbered, with the destination on its own line.
 *
 * `fence` wraps the results and only the results. Every title and snippet here
 * was written by whoever ranked for the query, which makes a search result the
 * cheapest injection surface in the extension - a page has to be fetched
 * before it can say anything, and a snippet is delivered for the asking. Every
 * other network-sourced string in here is fenced; this one was not.
 *
 * It has to be the middle rather than the whole string, because the last line
 * is an instruction from this extension about what to do next, and the fence
 * means "nothing inside this is an instruction". Fencing our own sentence
 * along with the results would tell the model to disregard it.
 */
export function renderResults(
  query: string,
  results: SearchResult[],
  fence: (body: string) => string = (b) => b
): string {
  if (!results.length) {
    return `No results for ${JSON.stringify(query)}. Try different words, or use browser open if you already know the address.`;
  }
  const body = results
    .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`)
    .join("\n\n");
  return (
    `${results.length} result${results.length === 1 ? "" : "s"} for ${JSON.stringify(query)}:\n\n` +
    fence(body) +
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

  // A refusal from the keyless endpoint, keyed on the host as well as the
  // wording. "anomaly" and "too many requests" are ordinary words that appear
  // on ordinary pages - including, awkwardly, a results page for a query about
  // either - so this would be exactly the false positive the rest of this
  // function is careful to avoid, were it not for where it is called from:
  // only when a search parsed to zero results. A results page that says
  // "anomaly" has results in it and never reaches here.
  if (/duckduckgo\.com/.test(u) && /anomaly|too many requests|rate limit/.test(t)) {
    return "DuckDuckGo's rate limit";
  }

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

/**
 * The request's address with any credential taken out of it.
 *
 * Google's programmable search carries the API key in the query string. That
 * is its design rather than a mistake here, but this address is shown to the
 * user in the panel's status line and handed to the model by `botWallAdvice`,
 * and a key that reaches a transcript has been disclosed to whoever that
 * transcript is later exported to - which for this extension is a JSON file
 * somebody attaches to a bug report.
 */
export function redactSearchUrl(url: string): string {
  return url.replace(/([?&](?:key|api_?key|token|subscription-key)=)[^&]*/gi, "$1<redacted>");
}

/**
 * Is this text a thing to look up, or a place to go?
 *
 * The question every address bar has answered for twenty years, and the reason
 * this file now has to answer it: the browser panel's box was an address bar
 * only, so words typed into it became `https://words with spaces` and the
 * panel said the address was unusable. The person watching a model search the
 * web could not search it themselves.
 *
 * The rule is deliberately not a public-suffix list. That means `node.js` and
 * `README.md` are treated as addresses and go nowhere, which is the honest
 * cost: the fix from the user's side is to add a word, and "node.js streams"
 * is what anybody searching for it types anyway. A suffix list would be the
 * largest data file in the project, shipped to decide one branch.
 */
export function looksLikeQuery(input: string): boolean {
  const s = String(input ?? "").trim();
  if (!s) return false;

  // Whitespace first, and before the scheme test rather than after it. A stack
  // trace pasted into the box - `TypeError: cannot read properties of null` -
  // begins with something the scheme pattern is perfectly happy to match, and
  // that is a search every single time.
  if (/\s/.test(s)) return true;

  // An explicit scheme is a statement of intent, so it is never a search.
  // http and https navigate; anything else falls through to `normaliseUrl`
  // and is refused there, because silently searching for `javascript:alert(1)`
  // hides a refusal the user needs to see.
  const m = /^([a-z][a-z0-9+.-]*):(\/\/)?/i.exec(s);
  if (m) {
    // `localhost:3000` is a port, not a scheme - the same carve-out
    // `normaliseUrl` makes, for the same reason.
    const isPort = !m[2] && /^\d/.test(s.slice(m[0].length));
    if (!isPort) return false;
  }

  // What is left is a bare word, a host, or a host with a path on it.
  const host = s.split(/[/?#]/, 1)[0].replace(/:\d+$/, "");
  if (/^localhost$/i.test(host)) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;       // IPv4
  if (/^\[[0-9a-f:]+\]$/i.test(host)) return false;             // bracketed IPv6
  return !/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i.test(host);
}

/** What one search actually did, for the two callers that need to say so. */
export interface SearchOutcome {
  query: string;
  /**
   * The provider that answered, which is not always the one configured:
   * `buildSearch` falls back to the keyless endpoint when a named provider is
   * missing its credential. Reporting the configured name instead is how a
   * status line comes to claim Brave for a search DuckDuckGo answered.
   */
  provider: SearchProvider;
  /** Where it went, redacted. Safe to show a user and to hand a model. */
  url: string;
  results: SearchResult[];
  /** Set when the answer was a bot check or a rate limit rather than results. */
  wall?: string;
  ms: number;
}

/**
 * One search, and the only implementation of one.
 *
 * Two callers now need this - the `web_search` tool and the browser panel's
 * address bar - and the half-dozen steps between a query and a list of results
 * are all places the two could quietly disagree: which provider actually
 * answered, whether a 403 is an error or a wall, whether an empty page means
 * no results or a refusal. Written once, on the same argument the agent gate
 * is written on: a rule read in two places is a rule, and a rule implemented in
 * two places is two rules.
 *
 * `dispatcher` is the point of the whole exercise. Passed the active profile's,
 * the search reaches whatever the model's own endpoint reaches - the corporate
 * proxy, the private CA, the client certificate. That is the part a hosted
 * search API cannot do.
 */
export async function runSearch(
  query: string,
  cfg: ProviderConfig,
  opts: {
    dispatcher?: Dispatcher;
    signal?: AbortSignal;
    limit?: number;
    timeoutMs?: number;
  } = {}
): Promise<SearchOutcome> {
  const q = String(query ?? "").trim();
  if (!q) throw new Error("Enter something to search for.");

  const limit = Math.min(20, Math.max(1, Number(opts.limit ?? 8) || 8));
  const req = buildSearch(q, cfg, limit);
  const provider: SearchProvider = req.kind === "html" ? "duckduckgo" : req.kind;
  const url = redactSearchUrl(req.url);
  const budget = opts.timeoutMs ?? SEARCH_TIMEOUT_MS;
  const t0 = Date.now();

  const res = await request(req.url, {
    method: "GET",
    headers: req.headers,
    ...(opts.dispatcher ? { dispatcher: opts.dispatcher } : {}),
    signal: opts.signal,
    maxRedirections: 3,
    headersTimeout: budget,
    bodyTimeout: budget,
  });
  const body = await res.body.text();
  const ms = Date.now() - t0;

  if (res.statusCode >= 400) {
    // Naming the provider that actually answered matters: a model told only
    // "the search failed" retries it until the turn ends, and one told the
    // wrong provider's name goes and checks a key that was never used.
    throw new Error(
      `${provider} answered HTTP ${res.statusCode}. ` +
      (res.statusCode === 401 || res.statusCode === 403
        ? provider === "duckduckgo"
          ? "The endpoint refused the request; try again shortly, or set genesis.searchProvider to one with an API key."
          : "The API key is missing or rejected; check genesis.searchApiKey."
        : "Try again, or switch genesis.searchProvider.")
    );
  }

  const results = parseProvider(req.kind, body, limit);
  // Only consulted when nothing parsed. A page that has results in it is a
  // results page whatever words happen to appear on it, and that guard is what
  // makes the wording checks in `looksLikeBotWall` safe to be as broad as they
  // are.
  const wall = results.length ? undefined : looksLikeBotWall(req.url, body);

  return { query: q, provider, url, results, wall, ms };
}
