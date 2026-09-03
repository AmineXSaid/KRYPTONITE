import { request, Dispatcher } from "undici";

/**
 * Fetch a page and reduce it to something readable.
 *
 * An `<iframe>` can show a site but nothing can be read back out of it: it is
 * a different origin, so the panel cannot see the title, the text or the
 * links, and neither can the agent. Many sites also refuse to load in a frame
 * at all - `X-Frame-Options: DENY` and CSP `frame-ancestors` are the norm on
 * anything with a login. So the panel fetches as well as frames, and this is
 * the half that produces text.
 *
 * Fetching happens on the active profile's undici dispatcher when one exists,
 * which is the whole reason this is worth building rather than opening the
 * system browser: inside a corporate network the model's endpoint is already
 * reachable through custom CAs, a CONNECT proxy and sometimes a client
 * certificate. A page fetched on that same transport is reachable on exactly
 * the same terms.
 *
 * Deliberately not a renderer. Tags are stripped, not interpreted; script and
 * style contents are dropped rather than escaped, because the output is read
 * by a person in a panel and by a model in a tool result, and neither wants
 * markup.
 */

export interface FetchedPage {
  url: string;
  /** After redirects. */
  finalUrl: string;
  status: number;
  title: string;
  text: string;
  links: Array<{ href: string; text: string }>;
  contentType: string;
  bytes: number;
  ms: number;
  /** True when the body was cut at the cap. */
  truncated: boolean;
}

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_TEXT = 200_000;
const MAX_LINKS = 200;

/**
 * One identity for everything this extension sends.
 *
 * Identifying honestly. A blank or forged agent gets a different page from
 * many sites, and then the panel, the reader and the agent disagree about what
 * an address contains.
 *
 * Exported because the search request needs the same string and used to send
 * none at all: undici adds no `User-Agent` of its own, and a request with no
 * agent is the shape a bot has. It lives here rather than in `search.ts`
 * because a site that allows one of these calls should see the same caller in
 * the other - two identities from one extension is how you get a search that
 * works and a page fetch that does not.
 */
export const USER_AGENT =
  "Genesis/0.8 (VS Code extension; +https://github.com/AmineXSaid/KRYPTONITE)";

/** Normalise what a person types into an address bar. */
export function normaliseUrl(input: string): string {
  const raw = String(input ?? "").trim();
  if (!raw) throw new Error("Enter an address.");

  /* A scheme has to be recognised even without `//`, or the check below can be
     walked straight past: `javascript:alert(1)` has no slashes, so treating
     only `scheme://` as a scheme turned it into `https://javascript:alert(1)`
     and let a scheme that must never be accepted through the front door.
     `localhost:3000` is the case that stops this being a one-liner - that
     colon introduces a port, not a scheme, which is why digits are excluded. */
  const m = /^([a-z][a-z0-9+.-]*):(\/\/)?/i.exec(raw);
  if (m) {
    const scheme = m[1].toLowerCase();
    const rest = raw.slice(m[0].length);
    const isPort = !m[2] && /^\d/.test(rest);
    if (!isPort && scheme !== "http" && scheme !== "https") {
      throw new Error(`Only http and https are supported, not ${scheme}:`);
    }
  }

  // A bare host or path gets https, not http: defaulting to cleartext in 2026
  // is a downgrade nobody asked for.
  const withScheme = /^https?:\/\//i.test(raw) ? raw : "https://" + raw.replace(/^https?:/i, "");
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    throw new Error(`Not a usable address: ${raw.slice(0, 120)}`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new Error(`Only http and https are supported, not ${u.protocol}`);
  }
  return u.toString();
}

/** Strip a document to its readable text. */
export function extractText(html: string): { title: string; text: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1]).trim().slice(0, 300) : "";

  const text = decodeEntities(
    html
      // Whole elements whose contents are not prose.
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      // Block boundaries become line breaks so paragraphs survive.
      .replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre)\s*>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/[ \t ]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
    .trim();

  return { title, text };
}

export function extractLinks(html: string, base: string): Array<{ href: string; text: string }> {
  const out: Array<{ href: string; text: string }> = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    if (out.length >= MAX_LINKS) break;
    let href: string;
    try {
      href = new URL(decodeEntities(m[1]).trim(), base).toString();
    } catch {
      continue;
    }
    if (!/^https?:/i.test(href)) continue;       // mailto:, javascript:, tel:
    if (seen.has(href)) continue;
    seen.add(href);
    const text = decodeEntities(m[2].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    out.push({ href, text: text.slice(0, 160) });
  }
  return out;
}

/** The handful that matter for readable text; numeric forms are general. */
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d) => safeChar(parseInt(d, 10)))
    .replace(/&(nbsp|amp|lt|gt|quot|apos|#39);/gi, (_m, name) => {
      const k = String(name).toLowerCase();
      return k === "nbsp" ? " "
        : k === "amp" ? "&"
        : k === "lt" ? "<"
        : k === "gt" ? ">"
        : k === "quot" ? '"'
        : "'";
    });
}
function safeChar(code: number): string {
  return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
}

export async function fetchPage(
  url: string,
  opts: { dispatcher?: Dispatcher; signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<FetchedPage> {
  const target = normaliseUrl(url);
  const t0 = Date.now();
  const budget = opts.timeoutMs ?? 30_000;

  const res = await request(target, {
    method: "GET",
    ...(opts.dispatcher ? { dispatcher: opts.dispatcher } : {}),
    signal: opts.signal,
    maxRedirections: 5,
    headers: {
      "user-agent": USER_AGENT,
      accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
      "accept-language": "en",
    },
    headersTimeout: budget,
    bodyTimeout: budget,
  });

  const contentType = String(res.headers["content-type"] ?? "");
  const chunks: Buffer[] = [];
  let bytes = 0;
  let truncated = false;
  for await (const c of res.body) {
    const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
    if (bytes + buf.length > MAX_BYTES) {
      chunks.push(buf.subarray(0, MAX_BYTES - bytes));
      bytes = MAX_BYTES;
      truncated = true;
      break;
    }
    chunks.push(buf);
    bytes += buf.length;
  }
  const body = Buffer.concat(chunks).toString("utf8");
  const finalUrl = (res as any).context?.history?.slice(-1)[0]?.toString?.() ?? target;

  const isHtml = /html|xml/i.test(contentType) || /^\s*<(!doctype|html)/i.test(body);
  const { title, text } = isHtml
    ? extractText(body)
    : { title: "", text: body };

  return {
    url: target,
    finalUrl,
    status: res.statusCode,
    title,
    text: text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text,
    links: isHtml ? extractLinks(body, finalUrl) : [],
    contentType,
    bytes,
    ms: Date.now() - t0,
    truncated: truncated || text.length > MAX_TEXT,
  };
}
