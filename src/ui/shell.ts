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
 * block inline into every webview — removing it would strip the theme.
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
 * The design names Inter and JetBrains Mono, but nothing in the layout depends
 * on their metrics. When `media/fonts/` is absent — the default — the system
 * stacks in the CSS take over and the CSP still forbids a remote fetch.
 */
function fontFaces(extensionUri: vscode.Uri, webview: vscode.Webview): string {
  const dir = vscode.Uri.joinPath(extensionUri, "media", "fonts");
  let names: string[];
  try {
    names = fs.readdirSync(dir.fsPath);
  } catch {
    return "";
  }

  const wanted: { file: string; family: string; weight: string }[] = [
    { file: "Inter-Regular.woff2", family: "Inter", weight: "400" },
    { file: "Inter-Medium.woff2", family: "Inter", weight: "500" },
    { file: "Inter-SemiBold.woff2", family: "Inter", weight: "600" },
    { file: "Inter-Bold.woff2", family: "Inter", weight: "700" },
    { file: "JetBrainsMono-Regular.woff2", family: "JetBrains Mono", weight: "400" },
    { file: "JetBrainsMono-Medium.woff2", family: "JetBrains Mono", weight: "500" },
  ];

  const rules: string[] = [];
  for (const f of wanted) {
    if (!names.includes(f.file)) continue;
    const uri = webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, "media", "fonts", f.file)
    );
    rules.push(
      `@font-face{font-family:'${f.family}';font-style:normal;font-weight:${f.weight};` +
        `font-display:swap;src:url('${uri}') format('woff2')}`
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

/** Shared by both surfaces so `localResourceRoots` is defined in one place. */
export function webviewOptions(extensionUri: vscode.Uri): vscode.WebviewOptions {
  return {
    enableScripts: true,
    localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
  };
}

/** Unused by the shells, kept beside them because it is the same asset concern. */
export function mediaPath(extensionUri: vscode.Uri, ...parts: string[]): string {
  return path.join(extensionUri.fsPath, "media", ...parts);
}
