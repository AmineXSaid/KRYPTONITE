/**
 * The browser as the model sees it.
 *
 * One action name and a bag of arguments in, one string out. This is the layer
 * every browser capability actually reaches the model through, and it used to
 * live inside `SessionController` where nothing could drive it without an
 * extension host, a profile and a running turn. The page functions underneath
 * were well tested and this was not, which is the wrong way round: a page
 * helper that works is no use if the action that calls it reads the wrong
 * argument name.
 *
 * Three rules hold for every branch, because they are what "the model can
 * actually use this" means:
 *
 *   Say what happened.   An action that mutates the page answers with what it
 *                        did *and* the page afterwards. A bare "ok" forces a
 *                        second call to find out whether it worked.
 *
 *   Name the argument.   A missing or wrong argument is answered with the name
 *                        of the one that was needed. A model can recover from
 *                        "ref is required for hover"; it cannot recover from a
 *                        CDP stack trace.
 *
 *   Never answer empty.  An empty string reads as a broken tool. "The page has
 *                        logged nothing" is a finding; "" is a bug report.
 */

import type { CdpBrowser } from "./cdp";
import {
  navigate, snapshot, screenshot, click, type, scroll, goBack, goForward,
  hover, pressKey, setValue, runJs, waitFor, resize, findRefs, renderSnapshot,
  assertSameOrigin, pageText,
} from "./page";
import { normaliseUrl } from "./fetchPage";
import { looksLikeBotWall, botWallAdvice } from "./search";

/**
 * Every action the model may ask for.
 *
 * Exported so the tool schema is generated from it rather than repeating it.
 * The two lists drifting apart is the failure this prevents, and it is silent
 * in both directions: an action in the schema with no branch here throws at
 * the model, and a branch with no schema entry is a capability the model is
 * never told about and will therefore never use.
 */
export const BROWSER_ACTIONS = [
  "open", "read", "text", "find", "click", "hover", "type", "set", "key", "scroll",
  "screenshot", "eval", "console", "network", "wait", "resize",
  "back", "forward", "close",
] as const;

export type BrowserAction = (typeof BROWSER_ACTIONS)[number];

/**
 * Actions that change the page rather than merely look at it.
 *
 * Each one re-checks that the page is still where it was when it was read,
 * because a ref points at a tree that a navigation invalidates. `eval` is here
 * despite being the model's own code: "run this script" is the most powerful
 * mutation available, and exempting it would mean the one action that can do
 * anything is the one action that checks nothing.
 */
export const MUTATING = new Set<string>(["click", "type", "set", "key", "hover", "eval"]);

export interface BrowserDeps {
  /** Where the content came from, recorded for the untrusted-content fence. */
  onUrl(url: string): void;
  /**
   * Persist a screenshot and show it to the user. Returns the workspace
   * relative path so the reply can name it.
   */
  saveShot(bytes: Buffer, mediaType: string): string;
  /** Whether the endpoint can be sent the pixels at all. */
  vision: boolean;
}

export interface BrowserImage {
  mediaType: string;
  data: string;
}

export type BrowserResult = string | { text: string; images?: BrowserImage[] };

/** Read a required string argument, or say which one was missing. */
function need(a: Record<string, unknown>, key: string, why: string): string {
  const v = a[key];
  const s = v === undefined || v === null ? "" : String(v);
  if (!s.trim()) throw new Error(`${key} is required for ${why}.`);
  return s;
}

export async function runBrowserAction(
  cdp: CdpBrowser,
  action: string,
  a: Record<string, unknown>,
  deps: BrowserDeps,
  /** The origin the last read came from, for the same-origin check. */
  lastUrl: string
): Promise<BrowserResult> {
  /* Every snapshot goes through here so the origin the content came from is
     recorded alongside it. The fence names that origin, and an origin the user
     did not expect is the clearest signal a page is hostile. */
  const snap = async (): Promise<string> => {
    const s = await snapshot(cdp);
    deps.onUrl(s.url);
    // A bot check is not the page that was asked for, and it does not read
    // like a failure - it reads like a page that happens to be about unusual
    // traffic. Handing the model twenty lines of that is how it ends up
    // apologising and giving up, which is the right response to the text and
    // the wrong response to the situation.
    const wall = looksLikeBotWall(s.url, s.text ?? "");
    if (wall) return botWallAdvice(wall, s.url);
    return renderSnapshot(s);
  };

  /* Placed here rather than inside each branch so a new mutating action cannot
     be added without it. */
  if (MUTATING.has(action)) await assertSameOrigin(cdp, lastUrl);

  switch (action) {
    case "open": {
      const url = normaliseUrl(need(a, "url", "open"));
      await navigate(cdp, url);
      return await snap();
    }

    case "read":
      return await snap();

    case "text": {
      // Recorded like any other read: the fence needs an origin, and a text
      // read is exactly the kind of untrusted content it exists for.
      const s = await snapshot(cdp);
      deps.onUrl(s.url);
      const body = await pageText(cdp);
      // A page with no prose is a real answer and a common one - an app shell,
      // a canvas, a login wall. Saying so points at `read` instead of leaving
      // the model to conclude the tool is broken.
      return body.trim()
        ? body
        : `${s.url} has no readable article text. It is probably an application ` +
          `rather than a document: use read to see what is on it.`;
    }

    case "click": {
      const ref = need(a, "ref", "click");
      await click(cdp, ref);
      return `Clicked ${ref}.\n\n` + (await snap());
    }

    case "type": {
      const ref = need(a, "ref", "type");
      await type(cdp, ref, String(a.text ?? ""), {
        submit: a.submit === true,
        clear: a.clear === true,
      });
      return `Typed into ${ref}.\n\n` + (await snap());
    }

    case "hover": {
      const ref = need(a, "ref", "hover");
      await hover(cdp, ref);
      return `Hovered ${ref}.\n\n` + (await snap());
    }

    case "set": {
      const ref = need(a, "ref", "set");
      // Not `need`: "" is a legitimate value to set a field to, and an empty
      // string is exactly how a model clears one.
      const now = await setValue(cdp, ref, String(a.text ?? ""));
      return `Set ${ref} to ${JSON.stringify(now)}.\n\n` + (await snap());
    }

    case "key": {
      const k = a.key !== undefined && String(a.key).trim() ? String(a.key) : need(a, "text", "key");
      await pressKey(cdp, k);
      return `Pressed ${k}.\n\n` + (await snap());
    }

    case "scroll":
      await scroll(cdp, Number(a.dy ?? 600));
      return await snap();

    case "back":
      await goBack(cdp);
      return await snap();

    case "forward":
      await goForward(cdp);
      return await snap();

    case "find": {
      const q = need(a, "text", "find: it is the thing to look for");
      const s = await snapshot(cdp);
      const hits = findRefs(s, q);
      if (!hits.length) {
        // Two different answers, because they call for two different next
        // moves and the model cannot tell them apart from one message. Text
        // that is on the page but attached to nothing clickable is the case
        // that reads as a lie: the model saw the words in the last read, asked
        // where they were, and was told they do not exist.
        const inText = s.text.toLowerCase().includes(q.toLowerCase());
        return inText
          ? `${JSON.stringify(q)} is on the page, but not as anything clickable - ` +
            `it is text rather than a link, button or field, so it has no ref. ` +
            `Use eval if you need to interact with it, or find the control near it.`
          : `Nothing on the page matches ${JSON.stringify(q)}. Read the page to see what is there.`;
      }
      return (
        `${hits.length} match${hits.length === 1 ? "" : "es"} for ${JSON.stringify(q)}:\n` +
        hits
          .slice(0, 40)
          .map((e) => `  [${e.ref}] ${e.role}${e.name ? " " + JSON.stringify(e.name) : ""}`)
          .join("\n")
      );
    }

    case "eval": {
      const expr = a.expression !== undefined && String(a.expression).trim()
        ? String(a.expression)
        : need(a, "text", "eval");
      const out = await runJs(cdp, expr);
      // `undefined` is what a statement evaluates to, and returning nothing
      // for it reads as a failure. Naming it says the script ran.
      const body = out.trim() ? out : "undefined (the expression produced no value)";
      return body.length > 20_000 ? body.slice(0, 20_000) + "\n… (truncated)" : body;
    }

    case "console": {
      const all = cdp.consoleLines();
      const lines = a.errorsOnly ? all.filter((l) => l.level === "error") : all;
      if (!lines.length) {
        return a.errorsOnly
          ? "The page has logged no errors."
          : "The page has logged nothing since it loaded.";
      }
      return (
        `${lines.length} console line${lines.length === 1 ? "" : "s"}:\n` +
        lines
          .slice(-80)
          .map((l) => `  [${l.level}] ${l.text}${l.source ? `  (${l.source})` : ""}`)
          .join("\n")
      );
    }

    case "network": {
      const all = cdp.networkLines();
      const rows = a.errorsOnly ? all.filter((r) => r.failed || (r.status ?? 0) >= 400) : all;
      if (!rows.length) {
        return a.errorsOnly ? "Every request succeeded." : "The page has made no requests.";
      }
      return (
        `${rows.length} request${rows.length === 1 ? "" : "s"}` +
        (a.errorsOnly ? " that failed" : "") + ":\n" +
        rows
          .slice(-60)
          .map(
            (r) =>
              `  ${r.failed ? "ERR" : String(r.status ?? "…").padStart(3)} ` +
              `${r.method} ${r.url}` +
              `${r.kind ? ` [${r.kind}]` : ""}${r.ms !== undefined ? ` ${r.ms}ms` : ""}` +
              `${r.failed ? ` - ${r.failed}` : ""}`
          )
          .join("\n")
      );
    }

    case "wait": {
      const out = await waitFor(cdp, {
        text: a.text ? String(a.text) : undefined,
        selector: a.selector ? String(a.selector) : undefined,
      });
      return out + "\n\n" + (await snap());
    }

    case "resize": {
      const w = Number(a.width ?? 1280);
      const h = Number(a.height ?? 800);
      const scheme = a.scheme === "dark" || a.scheme === "light" ? a.scheme : undefined;
      const got = await resize(cdp, w, h, scheme);
      // The mismatch is a finding about the page, not a failure of the call,
      // and stating it is what stops it being read as one.
      const note =
        got.actual !== got.asked
          ? ` The page laid out at ${got.actual}px rather than ${got.asked}: it has no` +
            ` <meta name="viewport">, so it falls back to a ${got.actual}px layout the way` +
            ` a real phone does. That is a responsive-design bug on the page.`
          : "";
      return (
        `Viewport is now ${got.asked}x${Math.round(h)}` +
        (got.mobile ? ", emulating a phone" : "") +
        (scheme ? `, asking for the ${scheme} theme` : "") +
        "." + note + "\n\n" + (await snap())
      );
    }

    case "screenshot": {
      const shot = await screenshot(cdp);
      const png = shot.bytes;
      const rel = deps.saveShot(png, shot.mediaType);
      const s = await snapshot(cdp);
      deps.onUrl(s.url);
      const of = `It is of: ${s.title || s.url}`;
      const saved =
        `Screenshot saved to ${rel} and shown to the user (${Math.round(png.length / 1024)} KB).`;
      if (!deps.vision) {
        return (
          `${saved}\n${of}\n` +
          `The image itself is not attached: this endpoint profile does not declare ` +
          `vision, so you cannot be shown it. Set capabilities.vision: true in the ` +
          `profile if the gateway supports images, or work from browser read instead.`
        );
      }
      return {
        text: `${saved}\n${of}\nThe image follows.`,
        images: [{ mediaType: shot.mediaType, data: png.toString("base64") }],
      };
    }

    default:
      // Names the alternatives. A model that guessed "navigate" can correct
      // itself from this; "Unknown action" only tells it to give up.
      throw new Error(
        `Unknown browser action ${JSON.stringify(action)}. Valid actions: ${BROWSER_ACTIONS.join(", ")}.`
      );
  }
}
