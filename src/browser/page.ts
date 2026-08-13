import type { CdpBrowser } from "./cdp";

/**
 * What the model can do to a page.
 *
 * Everything is addressed by `ref`, not by coordinates. A model asked to click
 * at (412, 288) is guessing from a screenshot it may have misread, and the
 * guess silently lands on whatever moved there since. A ref is assigned by the
 * page itself, survives until the next read, and either resolves to an element
 * or fails loudly.
 *
 * The element list is produced by script injected into the page rather than
 * from the accessibility tree. The AX tree is the more principled source and
 * needs a second round trip per node to find where anything actually is;
 * one `Runtime.evaluate` returns role, name and box together, which is what
 * both the click and the screenshot annotation need.
 */

export interface ElementRef {
  ref: string;
  role: string;
  name: string;
  /** Viewport coordinates of the element's centre. */
  x: number;
  y: number;
  w: number;
  h: number;
  value?: string;
  disabled?: boolean;
}

/** A picture on the page, and whatever its author said it was. */
export interface ImageRef {
  /** alt, or title, or aria-label - whichever the author actually wrote. */
  text: string;
  w: number;
  h: number;
  /** Requested but never arrived, so it is not in the screenshot either. */
  broken?: boolean;
}

export interface PageSnapshot {
  url: string;
  title: string;
  text: string;
  elements: ElementRef[];
  /** Described images in view. Empty on a page that has none. */
  images: ImageRef[];
  /** How many in view carry no description at all. */
  undescribed: number;
}

/**
 * Injected into the page. Tags every interactive element with a stable ref and
 * reports where it is.
 *
 * Only what is visible and on-screen: a menu that has not been opened yet is
 * in the DOM, and offering it as clickable produces a click that lands on
 * nothing. Hidden elements are the single largest source of phantom refs.
 */
const COLLECT = String.raw`
(() => {
  const SEL = 'a[href], button, input, select, textarea, summary, ' +
    '[role="button"], [role="link"], [role="tab"], [role="checkbox"], [role="radio"], ' +
    '[role="menuitem"], [role="option"], [role="switch"], [contenteditable="true"], [onclick]';
  const out = [];
  let n = 0;
  for (const el of document.querySelectorAll(SEL)) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue;
    // Off-screen in either direction. Scrolling is a separate, explicit action.
    if (r.bottom < 0 || r.right < 0) continue;
    if (r.top > innerHeight || r.left > innerWidth) continue;

    const ref = 'ref_' + (++n);
    el.setAttribute('data-kx-ref', ref);

    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role') ||
      (tag === 'a' ? 'link'
        : tag === 'button' ? 'button'
        : tag === 'input' ? (el.type || 'text')
        : tag === 'select' ? 'select'
        : tag === 'textarea' ? 'textbox'
        : tag);
    const name = (
      el.getAttribute('aria-label') ||
      el.getAttribute('placeholder') ||
      el.getAttribute('title') ||
      (el.labels && el.labels[0] && el.labels[0].innerText) ||
      el.innerText || el.value || el.getAttribute('name') || ''
    ).replace(/\s+/g, ' ').trim().slice(0, 120);

    out.push({
      ref, role, name,
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + r.height / 2),
      w: Math.round(r.width), h: Math.round(r.height),
      value: (el.value !== undefined && el.type !== 'password') ? String(el.value).slice(0, 120) : undefined,
      disabled: Boolean(el.disabled),
    });
    if (out.length >= 300) break;
  }
  // Pictures. innerText does not include alt text, so without this a gallery
  // of eight captioned photographs reads as an empty page - the author wrote
  // a description of every one and none of it reaches the model.
  const images = [];
  let undescribed = 0;
  for (const im of document.querySelectorAll('img')) {
    const cs = getComputedStyle(im);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue;

    const alt = (im.getAttribute('alt') || '').trim();
    // alt="" is the author saying "this one is decoration, ignore it", which
    // is different from an image with no alt attribute at all: that one is
    // undescribed content, and worth counting so the model knows to look.
    if (im.hasAttribute('alt') && alt === '') continue;
    const label = (alt || (im.getAttribute('title') || '').trim() ||
      (im.getAttribute('aria-label') || '').trim()).replace(/\s+/g, ' ').slice(0, 160);

    // A broken image collapses to the line box of its own alt text - Chrome
    // drops the width and height it was given - so the size gate below would
    // discard every one of them. They are worth a line anyway: a description
    // of something that is definitively *not* in the screenshot explains a gap
    // that the screenshot cannot.
    if (im.complete && im.naturalWidth === 0) {
      if (label && images.length < 40) images.push({ text: label, w: 0, h: 0, broken: true });
      continue;
    }

    const r = im.getBoundingClientRect();
    // Icons, spacers and tracking pixels are not what anyone means by an image.
    if (r.width < 32 || r.height < 32) continue;
    if (r.bottom < 0 || r.right < 0) continue;
    if (r.top > innerHeight || r.left > innerWidth) continue;

    if (!label) { undescribed++; continue; }
    if (images.length < 40) {
      images.push({ text: label, w: Math.round(r.width), h: Math.round(r.height) });
    }
  }

  const body = document.body ? document.body.innerText : '';
  return JSON.stringify({
    url: location.href,
    title: document.title,
    text: body.replace(/\n{3,}/g, '\n\n').slice(0, 40000),
    elements: out,
    images: images,
    undescribed: undescribed,
  });
})()
`;

async function evaluate(cdp: CdpBrowser, expression: string, timeoutMs = 20_000): Promise<any> {
  const res = await cdp.send(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true },
    timeoutMs
  );
  if (res.exceptionDetails) {
    const t = res.exceptionDetails.exception?.description ?? res.exceptionDetails.text;
    throw new Error(String(t).split("\n")[0]);
  }
  return res.result?.value;
}

/** Navigate, then wait for the page to settle rather than for a fixed delay. */
export async function navigate(cdp: CdpBrowser, url: string, timeoutMs = 30_000): Promise<void> {
  const done = new Promise<void>((resolve) => {
    const off = () => resolve();
    // Either signal is good enough; a page that never fires load still
    // finishes its DOM, and waiting only for `load` hangs on a live socket.
    cdp.on("Page.loadEventFired", off);
    cdp.on("Page.domContentEventFired", off);
    setTimeout(off, timeoutMs);
  });
  // The previous page's console and requests are not evidence about this one.
  cdp.clearDiagnostics();
  const res = await cdp.send("Page.navigate", { url }, timeoutMs);
  if (res.errorText) throw new Error(`${url}: ${res.errorText}`);
  await done;
  // Frameworks paint after DOMContentLoaded; without this the first snapshot
  // of a single-page app is an empty shell.
  await new Promise((r) => setTimeout(r, 350));
}

export async function snapshot(cdp: CdpBrowser): Promise<PageSnapshot> {
  const raw = await evaluate(cdp, COLLECT);
  const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  return {
    url: String(parsed?.url ?? ""),
    title: String(parsed?.title ?? ""),
    text: String(parsed?.text ?? ""),
    elements: Array.isArray(parsed?.elements) ? parsed.elements : [],
    images: Array.isArray(parsed?.images) ? parsed.images : [],
    undescribed: Number(parsed?.undescribed ?? 0) || 0,
  };
}

export interface PageImage {
  bytes: Buffer;
  mediaType: "image/png" | "image/jpeg";
}

/**
 * Above this a png is worth a second look; below it, it is already small and
 * re-encoding could only cost sharpness. Measured, not guessed: a page of
 * prose is a 50 KB png that jpeg makes *bigger*, while a page of photographs
 * is a 1.2 MB png that jpeg turns into 425 KB of the same picture.
 */
const RECONSIDER_ABOVE = 200 * 1024;

/**
 * A screenshot small enough to send.
 *
 * png first, always, because most of what a model looks at is a page of text
 * and small text is the one thing jpeg is worst at. But a photograph in png is
 * a megabyte, and a megabyte becomes 1.4 MB of base64 in a JSON body headed
 * for a gateway that may well have an opinion about request size. So a large
 * png earns a second capture as jpeg, and whichever is smaller wins - the
 * decision is made on the two files that actually exist rather than on a guess
 * about what kind of page this is.
 */
export async function screenshot(cdp: CdpBrowser): Promise<PageImage> {
  const png = await capture(cdp, { format: "png" });
  if (png.length <= RECONSIDER_ABOVE) return { bytes: png, mediaType: "image/png" };

  try {
    const jpeg = await capture(cdp, { format: "jpeg", quality: 80 });
    if (jpeg.length < png.length) return { bytes: jpeg, mediaType: "image/jpeg" };
  } catch {
    // A browser that will not encode jpeg is not a reason to lose the png.
  }
  return { bytes: png, mediaType: "image/png" };
}

async function capture(cdp: CdpBrowser, opts: Record<string, unknown>): Promise<Buffer> {
  const res = await cdp.send(
    "Page.captureScreenshot",
    { captureBeyondViewport: false, ...opts },
    30_000
  );
  if (!res?.data) throw new Error("The browser returned no image.");
  return Buffer.from(String(res.data), "base64");
}

/** Where a ref is now, re-read from the page rather than from a stale list. */
async function locate(cdp: CdpBrowser, ref: string): Promise<{ x: number; y: number }> {
  const box = await evaluate(
    cdp,
    `(() => {
      const el = document.querySelector('[data-kx-ref=${JSON.stringify(ref)}]');
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return null;
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`
  );
  if (!box) {
    throw new Error(
      `${ref} is no longer on the page. Read the page again - refs are assigned per read, ` +
      `and anything that navigated or re-rendered has new ones.`
    );
  }
  return box;
}

export async function click(cdp: CdpBrowser, ref: string): Promise<void> {
  const { x, y } = await locate(cdp, ref);
  // A real click is a move, a press and a release. Dispatching only the press
  // leaves elements that listen for mouseup or click unfired.
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
  await new Promise((r) => setTimeout(r, 250));
}

export async function type(
  cdp: CdpBrowser,
  ref: string,
  text: string,
  opts: { submit?: boolean; clear?: boolean } = {}
): Promise<void> {
  await click(cdp, ref);
  if (opts.clear) {
    await evaluate(
      cdp,
      `(() => {
        const el = document.querySelector('[data-kx-ref=${JSON.stringify(ref)}]');
        if (el && 'value' in el) {
          el.value = '';
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
      })()`
    );
  }
  // insertText rather than per-key events: it is one round trip instead of one
  // per character, and it does not misrepresent a paste as typing.
  await cdp.send("Input.insertText", { text });
  if (opts.submit) {
    for (const type of ["keyDown", "keyUp"] as const) {
      await cdp.send("Input.dispatchKeyEvent", {
        type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
        text: type === "keyDown" ? "\r" : undefined,
      });
    }
    await new Promise((r) => setTimeout(r, 600));
  }
}

export async function scroll(cdp: CdpBrowser, dy: number): Promise<void> {
  await evaluate(cdp, `window.scrollBy(0, ${Math.round(dy)}); true`);
  await new Promise((r) => setTimeout(r, 200));
}

export async function goBack(cdp: CdpBrowser): Promise<void> {
  await evaluate(cdp, "history.back(); true");
  await new Promise((r) => setTimeout(r, 600));
}

export async function goForward(cdp: CdpBrowser): Promise<void> {
  await evaluate(cdp, "history.forward(); true");
  await new Promise((r) => setTimeout(r, 600));
}

/**
 * Run an expression in the page and bring the answer back.
 *
 * The escape hatch for everything the structured actions do not cover: reading
 * a computed style, checking a global, counting matches. `returnByValue` means
 * the result has to survive being serialised, so a DOM node comes back as an
 * empty object - callers are expected to return a string or a number.
 */
export async function runJs(cdp: CdpBrowser, expression: string): Promise<string> {
  // Wrapped so a bare expression and a statement both work: a model writing
  // `document.title` and one writing `return document.title` both mean the
  // same thing, and refusing one of them is a papercut with no upside.
  const wrapped = /\breturn\b/.test(expression)
    ? `(() => { ${expression} })()`
    : `(${expression})`;
  let value: unknown;
  try {
    value = await evaluate(cdp, wrapped);
  } catch {
    // Fall back to running it as statements, for input that is neither.
    value = await evaluate(cdp, `(() => { ${expression} })()`);
  }
  if (value === undefined) return "undefined";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 1) ?? String(value);
  } catch {
    return String(value);
  }
}

/** The current address, read cheaply enough to check before every action. */
export async function currentUrl(cdp: CdpBrowser): Promise<string> {
  try {
    return String((await evaluate(cdp, "location.href")) ?? "");
  } catch {
    return "";
  }
}

/** Scheme and host, which is the unit a trust decision is actually made in. */
export function originOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "";
  }
}

/**
 * Refuse to act if the page moved between being read and being acted on.
 *
 * A ref is minted against one page. If the tab navigates before the click
 * lands, the ref either resolves to a different element or the coordinates
 * land on somebody else's page - and the model has no way to know, because it
 * is reasoning about the page it was shown. That gap is a real attack: a page
 * that redirects on a timer can have the agent click something on a site it
 * never agreed to visit.
 *
 * Compared by origin rather than by full URL on purpose. A single-page app
 * rewriting its path is not a trust change and must not be blocked; a hop to
 * another host is, and must be.
 */
export async function assertSameOrigin(cdp: CdpBrowser, expected: string): Promise<void> {
  if (!expected) return;
  const now = await currentUrl(cdp);
  const before = originOf(expected);
  const after = originOf(now);
  if (!before || !after || before === after) return;
  throw new Error(
    `The page navigated from ${before} to ${after} after it was read, so this ` +
    `action was refused: the element it targets belongs to a page that is no ` +
    `longer open. Read the page again and decide whether ${after} is somewhere ` +
    `you meant to be.`
  );
}

/** Move the pointer over an element without clicking, to reveal what hovers. */
export async function hover(cdp: CdpBrowser, ref: string): Promise<void> {
  const { x, y } = await locate(cdp, ref);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 });
  await new Promise((r) => setTimeout(r, 250));
}

/** Named keys the model is likely to ask for, and what CDP wants for them. */
const KEYS: Record<string, { code: string; key: string; vk: number; text?: string }> = {
  enter: { code: "Enter", key: "Enter", vk: 13, text: "\r" },
  tab: { code: "Tab", key: "Tab", vk: 9, text: "\t" },
  escape: { code: "Escape", key: "Escape", vk: 27 },
  backspace: { code: "Backspace", key: "Backspace", vk: 8 },
  delete: { code: "Delete", key: "Delete", vk: 46 },
  arrowup: { code: "ArrowUp", key: "ArrowUp", vk: 38 },
  arrowdown: { code: "ArrowDown", key: "ArrowDown", vk: 40 },
  arrowleft: { code: "ArrowLeft", key: "ArrowLeft", vk: 37 },
  arrowright: { code: "ArrowRight", key: "ArrowRight", vk: 39 },
  pageup: { code: "PageUp", key: "PageUp", vk: 33 },
  pagedown: { code: "PageDown", key: "PageDown", vk: 34 },
  home: { code: "Home", key: "Home", vk: 36 },
  end: { code: "End", key: "End", vk: 35 },
};

/**
 * Press a key at the page, wherever focus happens to be.
 *
 * Distinct from `type`, which targets a ref and inserts text. Escape closes a
 * dialog, Tab moves focus, ArrowDown walks a combobox - none of which is text
 * going into a field, and none of which `Input.insertText` can express.
 */
export async function pressKey(cdp: CdpBrowser, name: string): Promise<void> {
  const k = KEYS[name.trim().toLowerCase()];
  if (!k) {
    throw new Error(
      `Unknown key "${name}". Known: ${Object.keys(KEYS).join(", ")}. ` +
      `Use type for ordinary text.`
    );
  }
  for (const type of ["keyDown", "keyUp"] as const) {
    await cdp.send("Input.dispatchKeyEvent", {
      type,
      key: k.key,
      code: k.code,
      windowsVirtualKeyCode: k.vk,
      nativeVirtualKeyCode: k.vk,
      text: type === "keyDown" ? k.text : undefined,
    });
  }
  await new Promise((r) => setTimeout(r, 250));
}

/**
 * Set a form control that typing cannot reach.
 *
 * A `<select>` ignores keystrokes, and a checkbox has no text to insert. Both
 * are set through the DOM and told to announce it: a framework listening for
 * `change` never hears a property assignment on its own, so the page would
 * look right and behave as though nothing had happened.
 */
export async function setValue(cdp: CdpBrowser, ref: string, value: string): Promise<string> {
  const out = await evaluate(
    cdp,
    `(() => {
      const el = document.querySelector('[data-kx-ref=${JSON.stringify(ref)}]');
      if (!el) return "missing";
      const tag = el.tagName.toLowerCase();
      const v = ${JSON.stringify(value)};
      if (tag === 'select') {
        const opts = [...el.options];
        const hit = opts.find(o => o.value === v) || opts.find(o => o.text.trim() === v) ||
          opts.find(o => o.text.toLowerCase().includes(v.toLowerCase()));
        if (!hit) return "nooption:" + opts.map(o => o.text.trim()).slice(0, 20).join(" | ");
        el.value = hit.value;
      } else if (el.type === 'checkbox' || el.type === 'radio') {
        el.checked = !(v === 'false' || v === '0' || v === 'off' || v === 'unchecked');
      } else {
        el.value = v;
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return "ok:" + (el.type === 'checkbox' || el.type === 'radio' ? String(el.checked) : el.value);
    })()`
  );
  const s = String(out ?? "");
  if (s === "missing") {
    throw new Error(
      `${ref} is no longer on the page. Read the page again - refs are assigned per read.`
    );
  }
  if (s.startsWith("nooption:")) {
    throw new Error(`No option matching "${value}". The options are: ${s.slice(9)}`);
  }
  return s.slice(3);
}

/**
 * Wait for the page to say something, rather than for a fixed delay.
 *
 * A sleep long enough to be safe is always too long, and a sleep short enough
 * to be quick is sometimes wrong. Polls twice a second for text appearing, a
 * selector matching, or the network going quiet.
 */
export async function waitFor(
  cdp: CdpBrowser,
  what: { text?: string; selector?: string; idleMs?: number },
  timeoutMs = 15_000
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  const label = what.text
    ? `text ${JSON.stringify(what.text)}`
    : what.selector
      ? `selector ${JSON.stringify(what.selector)}`
      : "the network to go quiet";

  while (Date.now() < deadline) {
    if (what.text) {
      const hit = await evaluate(
        cdp,
        `(document.body ? document.body.innerText : "").includes(${JSON.stringify(what.text)})`
      );
      if (hit === true) return `Found ${label}.`;
    } else if (what.selector) {
      const hit = await evaluate(
        cdp,
        `Boolean(document.querySelector(${JSON.stringify(what.selector)}))`
      );
      if (hit === true) return `Found ${label}.`;
    } else {
      // Quiet means nothing started in the last stretch. Requests already in
      // flight are not tracked here; this is the cheap version and it answers
      // the question that is usually being asked - "has it stopped loading".
      const before = cdp.networkLines().length;
      await new Promise((r) => setTimeout(r, what.idleMs ?? 700));
      if (cdp.networkLines().length === before) return "The network went quiet.";
      continue;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Waited ${Math.round(timeoutMs / 1000)}s and never saw ${label}.`);
}

/**
 * Resize the viewport, optionally asking the page for its dark theme.
 *
 * Returns the width the page *actually* ended up laying out at, which is not
 * always the one asked for. Below 768 the page is told it is a phone, so media
 * queries and touch behave as they would on one - and a page with no
 * `<meta name="viewport">` responds to that exactly as a real phone does, by
 * falling back to a 980px layout viewport and scaling it down. That is correct
 * emulation and a genuine finding about the page, but a caller who asked for
 * 400 and is silently given 980 will draw the wrong conclusion, so the number
 * is reported rather than assumed.
 */
export async function resize(
  cdp: CdpBrowser,
  width: number,
  height: number,
  scheme?: "light" | "dark"
): Promise<{ asked: number; actual: number; mobile: boolean }> {
  const asked = Math.max(200, Math.round(width));
  const mobile = asked < 768;
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: asked,
    height: Math.max(200, Math.round(height)),
    deviceScaleFactor: 1,
    mobile,
  });
  if (scheme) {
    await cdp.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: scheme }],
    }).catch(() => {});
  }
  await new Promise((r) => setTimeout(r, 250));
  let actual = asked;
  try {
    const n = await evaluate(cdp, "innerWidth");
    if (typeof n === "number" && n > 0) actual = n;
  } catch {
    // A page mid-navigation cannot be asked; the requested width is the best
    // answer available and is very nearly always the right one.
  }
  return { asked, actual, mobile };
}

/**
 * The refs whose role or name matches, so a long page can be acted on without
 * re-reading all of it.
 */
export function findRefs(s: PageSnapshot, query: string): ElementRef[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const words = q.split(/\s+/);
  return s.elements.filter((e) => {
    const hay = `${e.role} ${e.name} ${e.value ?? ""}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** The element list, rendered for a model to read and choose from. */
export function renderSnapshot(s: PageSnapshot, opts: { maxText?: number } = {}): string {
  const cap = opts.maxText ?? 12_000;
  const lines = s.elements.map((e) => {
    const bits = [`[${e.ref}]`, e.role];
    if (e.name) bits.push(JSON.stringify(e.name));
    if (e.value) bits.push(`value=${JSON.stringify(e.value)}`);
    if (e.disabled) bits.push("(disabled)");
    return "  " + bits.join(" ");
  });
  const text = s.text.length > cap ? s.text.slice(0, cap) + "\n… (truncated)" : s.text;
  return (
    `${s.title || "(untitled)"}\n${s.url}\n\n` +
    `Interactive elements - click or type using the ref:\n` +
    (lines.length ? lines.join("\n") : "  (none found)") +
    imageSection(s) +
    `\n\nPage text:\n${text}`
  );
}

/**
 * The pictures, described by whoever wrote the page.
 *
 * Omitted entirely when there are none, so a page of prose is not taxed a
 * heading for something it does not have. The undescribed count earns its
 * place by being the one line that tells a model its reading is incomplete:
 * "6 more with no description" is the cue to take a screenshot, and without it
 * an image-only page looks like an empty one.
 */
function imageSection(s: PageSnapshot): string {
  const shown = s.images ?? [];
  const undescribed = s.undescribed ?? 0;
  if (!shown.length && !undescribed) return "";
  const rows = shown.map((im) =>
    im.broken
      ? `  ${JSON.stringify(im.text)} (failed to load)`
      : `  ${im.w}x${im.h} ${JSON.stringify(im.text)}`
  );
  if (undescribed) {
    rows.push(
      `  ${undescribed} more with no description - screenshot to see ${undescribed === 1 ? "it" : "them"}`
    );
  }
  return `\n\nImages in view:\n${rows.join("\n")}`;
}
