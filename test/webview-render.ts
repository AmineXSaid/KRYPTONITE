/**
 * The webview, painted by a real browser engine.
 *
 * `test/drive.js` drives this surface in jsdom and is the reason the panel's
 * behaviour is trustworthy - 355 assertions of clicking things and reading the
 * result. What jsdom cannot do is lay anything out. It parses CSS permissively
 * and computes no boxes, so a stylesheet the real engine rejects, a grid that
 * collapses, a font that never arrives and a script that throws only in V8 all
 * pass it without complaint.
 *
 * So this loads the SAME html the extension serves - built by the real
 * `sidebarHtml`, with the real Content-Security-Policy, over http so that
 * policy is actually enforced - into the Chromium that ships with this
 * environment, and looks at what came out.
 *
 * It is not VS Code: the webview there is this document inside an iframe with
 * the editor's own theme variables layered on. Every VS Code distribution host
 * is refused by this environment's network policy, so that shell cannot be
 * fetched. What this does cover is the part that breaks silently - the CSS
 * parsing, the layout, the fonts, and whether the panel's own script survives
 * a real engine at the width it is actually used at.
 *
 * Run: npx esbuild test/webview-render.ts --bundle --outfile=dist/webview-render.cjs \
 *        --format=cjs --platform=node --target=node20 --alias:vscode=./test/vscode-stub.ts
 *      node dist/webview-render.cjs
 */
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { chromium } from "playwright-core";
import { sidebarHtml } from "../src/ui/shell";

/**
 * The browser globals, declared here and nowhere else.
 *
 * Everything inside a `page.evaluate` callback runs in Chromium, not in Node -
 * but TypeScript checks it in this file's context, and this project's tsconfig
 * deliberately omits the `dom` lib so that extension-host code cannot reach for
 * a `document` it will never have. Adding `dom` to the project to satisfy one
 * test file would remove that guard from every other one, so the handful of
 * names these callbacks use are declared locally instead.
 */
declare const document: any;
declare const getComputedStyle: (el: any) => any;
type Element = any;

let pass = 0;
let fail = 0;
function ck(ok: boolean, label: string, detail = "") {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
}

const ROOT = path.resolve(__dirname, "..");
const MIME: Record<string, string> = {
  ".css": "text/css",
  ".js": "text/javascript",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".html": "text/html",
};

/** The Chromium this environment ships, whatever revision it is on. */
function findChromium(): string {
  const base = "/opt/pw-browsers";
  const names = fs.existsSync(base) ? fs.readdirSync(base) : [];
  for (const n of names.filter((d) => d.startsWith("chromium-")).sort().reverse()) {
    const p = path.join(base, n, "chrome-linux", "chrome");
    if (fs.existsSync(p)) return p;
  }
  for (const n of names.filter((d) => d.startsWith("chromium_headless_shell")).sort().reverse()) {
    const p = path.join(base, n, "chrome-linux", "headless_shell");
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`no Chromium under ${base}: ${names.join(", ")}`);
}

(async () => {
  /* ── serve the extension's own media over http ────────────────────────── */
  // Over http rather than file:// so the CSP is a real one: `default-src
  // 'none'` with an origin allowance behaves quite differently against file
  // URLs, and a policy that is not enforced is not being tested.
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent((req.url ?? "/").split("?")[0]);
    const abs = path.join(ROOT, rel);
    if (!abs.startsWith(ROOT) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": MIME[path.extname(abs)] ?? "application/octet-stream" });
    res.end(fs.readFileSync(abs));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  const origin = `http://127.0.0.1:${port}`;

  // The real html builder, with a webview whose asWebviewUri points at that
  // server. Nothing about the document is written by this test.
  const webview: any = {
    cspSource: origin,
    asWebviewUri: (u: any) => ({
      toString: () => origin + "/" + path.relative(ROOT, u.fsPath).split(path.sep).join("/"),
    }),
  };
  const extensionUri: any = { fsPath: ROOT, path: ROOT, scheme: "file", toString: () => ROOT };
  const html = sidebarHtml(webview, extensionUri);
  ck(/Content-Security-Policy/.test(html), "the served document carries a CSP");
  ck(/script-src 'nonce-/.test(html), "which allows only nonced scripts");
  ck(!/unsafe-eval/.test(html), "and no unsafe-eval");

  /* ── paint it, in both themes ─────────────────────────────────────────── */
  const browser = await chromium.launch({
    // Resolved rather than hard-coded: the bundled build carries a revision in
    // its directory name, so a pinned path goes stale on the next image.
    executablePath: process.env.PLAYWRIGHT_CHROMIUM ?? findChromium(),
    // Offline and quiet. This extension's whole reason for existing is
    // air-gapped and proxied networks, so its own test suite must not depend on
    // reaching the internet - and a browser phoning home mid-run makes the
    // proxy log look like the code under test did it.
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-default-apps",
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });

  /**
   * Render once, the way VS Code actually presents this document.
   *
   * Two details are what make it faithful, and getting either wrong renders a
   * state the product never shows. VS Code puts a `vscode-dark` or
   * `vscode-light` class on `body`, and the panel's stylesheet keys off it:
   * `body` is transparent on purpose so a docked view takes the colour of the
   * container beside it, and only in a LIGHT workbench does the sheet paint its
   * own ground. Render it with no class and no container colour - as the first
   * version of this test did - and you get near-white text on the browser's
   * default white, which looks like a catastrophic contrast bug and is an
   * artefact of the harness.
   */
  async function render(theme: "dark" | "light") {
    const page = await browser.newPage({ viewport: { width: 320, height: 900 } });
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const blocked: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text());
    });
    page.on("pageerror", (e) => pageErrors.push(String(e.message)));
    page.on("requestfailed", (r) => blocked.push(`${r.url()} ${r.failure()?.errorText ?? ""}`));

    // The one thing the editor provides that a browser does not, plus the class
    // the editor stamps on the body before any of the panel's script runs.
    await page.addInitScript((t: string) => {
      (globalThis as any).acquireVsCodeApi = () => ({
        postMessage: () => {},
        getState: () => undefined,
        setState: () => {},
      });
      document.addEventListener("DOMContentLoaded", () => {
        document.body.classList.add(t === "dark" ? "vscode-dark" : "vscode-light");
      });
    }, theme);

    await page.route(origin + "/index.html", (route) =>
      route.fulfill({ status: 200, contentType: "text/html", body: html })
    );
    await page.goto(origin + "/index.html", { waitUntil: "networkidle" });

    // A dark workbench paints the container; the panel is transparent over it.
    // A light one does not, because the sheet paints its own ground instead.
    if (theme === "dark") {
      await page.evaluate(() => {
        const bg = getComputedStyle(document.documentElement).getPropertyValue("--kx-bg").trim();
        document.documentElement.style.background = bg || "#1b1b1f";
      });
    }
    return { page, consoleErrors, pageErrors, blocked };
  }

  for (const theme of ["dark", "light"] as const) {
    console.log(`\n──── the panel in a ${theme} workbench ────`);
    const { page, consoleErrors, pageErrors, blocked } = await render(theme);

    ck(pageErrors.length === 0, "the panel's script runs without throwing", pageErrors.slice(0, 2).join(" | "));
    ck(consoleErrors.length === 0, "and logs no errors", consoleErrors.slice(0, 2).join(" | "));
    ck(blocked.length === 0, "every asset the document asks for loads", blocked.slice(0, 3).join(" | "));

    const drew = await page.evaluate(() => {
      const root = document.getElementById("root");
      return { present: !!root, children: root ? root.children.length : 0 };
    });
    ck(drew.present && drew.children > 0, "the frontend built a tree into #root", String(drew.children));

    // Real layout, which is the whole reason for using an engine. A sidebar
    // that overflows horizontally is unusable and jsdom cannot see it.
    const layout = await page.evaluate(() => {
      const el = document.getElementById("draft");
      const r = el?.getBoundingClientRect();
      return {
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        bodyHeight: document.body.getBoundingClientRect().height,
        composer: r ? { w: Math.round(r.width), h: Math.round(r.height) } : null,
      };
    });
    ck(
      layout.scrollWidth <= layout.clientWidth,
      "nothing overflows the sidebar horizontally at 320px",
      `${layout.scrollWidth} vs ${layout.clientWidth}`
    );
    ck(layout.bodyHeight > 0, "the body has a real box", String(Math.round(layout.bodyHeight)));
    ck(
      !!layout.composer && layout.composer.w > 100 && layout.composer.h > 10,
      "and the composer has a usable size rather than a collapsed one",
      layout.composer ? `${layout.composer.w}x${layout.composer.h}` : "absent"
    );

    // Contrast as the engine actually composites it. test/contrast.cjs computes
    // the same ratios from the stylesheet against --kx-bg; this checks the
    // painted result agrees, which is the half a token calculation cannot do.
    const measured = await page.evaluate(() => {
      const lum = (c: string) => {
        const m = (c.match(/[\d.]+/g) ?? ["0", "0", "0"]).map(Number);
        const f = (v: number) => {
          v /= 255;
          return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
        };
        return 0.2126 * f(m[0]) + 0.7152 * f(m[1]) + 0.0722 * f(m[2]);
      };
      const ratio = (a: string, b: string) => {
        const l1 = lum(a);
        const l2 = lum(b);
        return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      };
      /**
       * What is actually behind this text, composited.
       *
       * Walking up to the first non-transparent ancestor is not enough, and
       * getting it wrong reads as a real defect: the composer sits on
       * `rgba(255,255,255,0.04)`, a four-percent lift over the panel, and
       * treating that as opaque white put the composer at 2.54:1 against a
       * ground it never has. The layers have to be composited from the last
       * opaque one upward, which is what the engine does when it paints.
       */
      const parse = (c: string): [number, number, number, number] => {
        const m = (c.match(/[\d.]+/g) ?? ["0", "0", "0", "0"]).map(Number);
        return [m[0] ?? 0, m[1] ?? 0, m[2] ?? 0, m[3] === undefined ? 1 : m[3]];
      };
      const over = (fg: [number, number, number, number], bg: [number, number, number, number]) => {
        const a = fg[3];
        return [
          fg[0] * a + bg[0] * (1 - a),
          fg[1] * a + bg[1] * (1 - a),
          fg[2] * a + bg[2] * (1 - a),
          1,
        ] as [number, number, number, number];
      };
      const ground = (el: Element): string => {
        const layers: [number, number, number, number][] = [];
        let n: Element | null = el;
        while (n) {
          const c = parse(getComputedStyle(n).backgroundColor);
          if (c[3] > 0) {
            layers.push(c);
            if (c[3] === 1) break; // nothing below an opaque layer shows through
          }
          n = n.parentElement;
        }
        // The browser's own canvas, if every layer above it was translucent.
        let acc: [number, number, number, number] = layers.length && layers[layers.length - 1][3] === 1
          ? layers.pop()!
          : [255, 255, 255, 1];
        for (let i = layers.length - 1; i >= 0; i--) acc = over(layers[i], acc);
        return `rgb(${Math.round(acc[0])}, ${Math.round(acc[1])}, ${Math.round(acc[2])})`;
      };
      const out: Array<{ sel: string; ratio: number; color: string; bg: string }> = [];
      for (const sel of [".kx-tab", "h2", ".kx-empty p", "#draft"]) {
        const el = document.querySelector(sel);
        if (!el) continue;
        const cs = getComputedStyle(el);
        const bg = ground(el);
        out.push({ sel, ratio: +ratio(cs.color, bg).toFixed(2), color: cs.color, bg });
      }
      return out;
    });
    ck(measured.length > 0, "text was found to measure", measured.map((m) => m.sel).join(", "));
    const worst = measured.reduce((a, b) => (a.ratio < b.ratio ? a : b), measured[0]);
    // 4.5:1 is WCAG AA for body text. The panel's own suite holds the palette
    // to this; the point here is that the engine composites it that way too.
    ck(
      measured.every((m) => m.ratio >= 4.5),
      "every measured label meets 4.5:1 as painted",
      `worst ${worst.sel} at ${worst.ratio}:1 (${worst.color} on ${worst.bg})`
    );

    const shot = path.join(os.tmpdir(), `genesis-sidebar-${theme}.png`);
    await page.screenshot({ path: shot, fullPage: true });
    ck(fs.existsSync(shot) && fs.statSync(shot).size > 2000, "and it paints something", shot);
    await page.close();
  }

  await browser.close();
  server.close();
  console.log(`\n──── ${pass} passed, ${fail} failed ────`);
  process.exit(fail ? 1 : 0);
})();
