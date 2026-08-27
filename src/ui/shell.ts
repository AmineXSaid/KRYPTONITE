import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * HTML shells for the two webview surfaces.
 *
 * Both are deliberately empty documents: a `<div id="root">`, a nonced
 * bootstrap that hands the frontend its VS Code API handle and its surface
 * name, and a nonced script tag. Everything visible is built by the frontend
 * from `stateSync`, so there is no server-rendered markup to keep in sync with
 * the store.
 *
 * The CSP is restrictive on purpose: no remote origins, no inline scripts
 * beyond the nonced pair, no `unsafe-eval`. An air-gapped install must render
 * identically to a connected one, which rules out CDN fonts and icon sets.
 */

/**
 * `script-src 'nonce-…'` is the only script permission granted. `style-src`
 * keeps `'unsafe-inline'` because VS Code itself injects the theme variable
 * block inline into every webview - removing it would strip the theme.
 */
function csp(webview: vscode.Webview, nonce: string): string {
  return [
    "default-src 'none'",
    `img-src ${webview.cspSource} data:`,
    `font-src ${webview.cspSource}`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
  ].join("; ");
}

function makeNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

/**
 * Emit `@font-face` rules only when the woff2 files actually ship.
 *
 * Anthropic Sans in two optical sizes. The `Text` cut is drawn for 11–13px and
 * carries the whole interface; `Display` is tightened for 15px and above and is
 * used only on the two panel titles that reach that size. Setting Display at
 * 12px is the standard way to make a well-drawn family look wrong, so the two
 * are separate CSS families rather than one - the stylesheet has to opt into
 * Display deliberately.
 *
 * Absent files are skipped rather than 404'd, so a build with no `media/fonts/`
 * still renders on the system stack in the CSS. `font-src` is scoped to the
 * extension origin and nothing here is remote, so the CSP is unchanged. The
 * Light and Extrabold cuts are not referenced by the design and do not ship.
 */
function fontFaces(extensionUri: vscode.Uri, webview: vscode.Webview): string {
  const dir = vscode.Uri.joinPath(extensionUri, "media", "fonts");
  let names: string[];
  try {
    names = fs.readdirSync(dir.fsPath);
  } catch {
    return "";
  }

  /* The Genesis design names three OFL families. Unlike Anthropic Sans they
     are free to redistribute, so bundling them raises no licensing question.
     They must be bundled rather than linked: the webview CSP is
     `default-src 'none'` with font-src scoped to the extension origin, so the
     Google Fonts <link> the mockup uses would simply be blocked.

     IBM Plex Sans ships as a single VARIABLE font - Google serves one file for
     400/500/600 - so it is registered once across a weight RANGE. Declaring it
     three times with one weight each would make the browser synthesise the
     intermediate weights it already has. */
  const wanted: { file: string; family: string; weight: string; italic?: true }[] = [
    { file: "IBMPlexSans-var.woff2", family: "IBM Plex Sans", weight: "100 700" },
    { file: "IBMPlexSans-var-ext.woff2", family: "IBM Plex Sans", weight: "100 700" },
    { file: "SpaceMono-400.woff2", family: "Space Mono", weight: "400" },
    { file: "SpaceMono-400-ext.woff2", family: "Space Mono", weight: "400" },
    { file: "SpaceMono-700.woff2", family: "Space Mono", weight: "700" },
    { file: "SpaceMono-700-ext.woff2", family: "Space Mono", weight: "700" },
    { file: "Michroma-400.woff2", family: "Michroma", weight: "400" },
    { file: "Michroma-400-ext.woff2", family: "Michroma", weight: "400" },
  ];

  const rules: string[] = [];
  for (const f of wanted) {
    if (!names.includes(f.file)) continue;
    const uri = webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, "media", "fonts", f.file)
    );
    rules.push(
      `@font-face{font-family:'${f.family}';font-style:${f.italic ? "italic" : "normal"};` +
        `font-weight:${f.weight};font-display:swap;src:url('${uri}') format('woff2')}`
    );
  }
  return rules.length ? `<style>${rules.join("")}</style>` : "";
}

function assetUri(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  ...parts: string[]
): vscode.Uri {
  return webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, ...parts));
}

function shell(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  surface: "sidebar" | "controlCenter",
  title: string
): string {
  const nonce = makeNonce();
  // Palette and type live in one file loaded ahead of the surface stylesheet,
  // for the same reason the crystal artwork is a shared script: two documents,
  // one definition. A surface sheet that redefined a token would silently fork
  // the design system.
  const tokens = assetUri(webview, extensionUri, "media", "webview", "tokens.css");
  const css = assetUri(webview, extensionUri, "media", "webview", `${surface}.css`);
  const js = assetUri(webview, extensionUri, "media", "webview", `${surface}.js`);
  // The brand mark is shared, so it ships as its own script rather than being
  // pasted into both surface files where the two copies would drift apart.
  const crystal = assetUri(webview, extensionUri, "media", "webview", "crystal.js");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${csp(webview, nonce)}">
<title>${title}</title>
${fontFaces(extensionUri, webview)}
<link rel="stylesheet" href="${tokens}">
<link rel="stylesheet" href="${css}">
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}">
  window.__kx = { api: acquireVsCodeApi(), surface: ${JSON.stringify(surface)} };
</script>
<script nonce="${nonce}" src="${crystal}"></script>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
}

export function sidebarHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  return shell(webview, extensionUri, "sidebar", "Kryptonite");
}

export function controlCenterHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  return shell(webview, extensionUri, "controlCenter", "KRYPTONITE Control Center");
}

/**
 * The browser surface, which is the one document that frames the open web.
 *
 * Its CSP has to differ from the other two, and only in the one direction it
 * needs: `frame-src https: http:` so a page can be shown at all. Everything
 * else stays as strict as the rest of the extension - the frame is a sealed
 * box that cannot reach back into this document, and this document still has
 * no `connect-src`, so nothing it holds can be sent anywhere.
 */
export function browserHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = makeNonce();
  const tokens = assetUri(webview, extensionUri, "media", "webview", "tokens.css");
  const css = assetUri(webview, extensionUri, "media", "webview", "browser.css");
  const js = assetUri(webview, extensionUri, "media", "webview", "browser.js");
  const policy = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data: https: http:`,
    `font-src ${webview.cspSource}`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    "frame-src https: http:",
  ].join("; ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${policy}">
<title>Browser</title>
${fontFaces(extensionUri, webview)}
<link rel="stylesheet" href="${tokens}">
<link rel="stylesheet" href="${css}">
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}">
  window.__kx = { api: acquireVsCodeApi(), surface: "browser" };
</script>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
}

/**
 * Shared by both surfaces so `localResourceRoots` is defined in one place.
 *
 * The open folders are included alongside `media` so a generated image can be
 * shown in the transcript from where it was saved. That is a read permission
 * for the webview only, and the CSP above grants it no way to send anything
 * anywhere: `default-src 'none'` with no `connect-src`. The alternative was
 * inlining every image as a data: URI, which would put megabytes of base64
 * into the transcript and into the saved session file.
 */
export function webviewOptions(extensionUri: vscode.Uri): vscode.WebviewOptions {
  return {
    enableScripts: true,
    localResourceRoots: [
      vscode.Uri.joinPath(extensionUri, "media"),
      ...(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri),
    ],
  };
}

/** Unused by the shells, kept beside them because it is the same asset concern. */
export function mediaPath(extensionUri: vscode.Uri, ...parts: string[]): string {
  return path.join(extensionUri.fsPath, "media", ...parts);
}
