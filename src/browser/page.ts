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

export interface PageSnapshot {
  url: string;
  title: string;
  text: string;
  elements: ElementRef[];
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
  const body = document.body ? document.body.innerText : '';
  return JSON.stringify({
    url: location.href,
    title: document.title,
    text: body.replace(/\n{3,}/g, '\n\n').slice(0, 40000),
    elements: out,
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
  };
}

export async function screenshot(cdp: CdpBrowser): Promise<Buffer> {
  const res = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, 30_000);
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
    `Interactive elements — click or type using the ref:\n` +
    (lines.length ? lines.join("\n") : "  (none found)") +
    `\n\nPage text:\n${text}`
  );
}
