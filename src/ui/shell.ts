import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

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

/**
 * The nonce is the whole of `script-src`, so it has to be unguessable.
 *
 * This was 32 characters of `Math.random()`, which is a fast PRNG with a
 * recoverable internal state and no security claim of any kind. The CSP above
 * is the only thing standing between untrusted model output rendered into this
 * document and script execution inside it; deriving its one secret from a
 * generator that is documented as "not cryptographically secure" undercuts the
 * entire policy. `node:crypto` was already a dependency of four other files.
 */
function makeNonce(): string {
  return crypto.randomBytes(24).toString("base64url");
}

/**
 * Emit `@font-face` rules only when the woff2 files actually ship.
 *
 * The two families the Genesis design is drawn in, and nothing else:
 *
 *   JetBrains Mono  the interface. Labels, tabs, the wordmark, code, and every
 *                   id that has to line up in a column. 40 KB, variable.
 *   IBM Plex Sans   prose, and only prose - see --kx-prose in tokens.css for
 *                   the exact surfaces. 45 KB, variable.
 *
 * Both are SIL Open Font License, so bundling them is redistribution the
 * licence expressly permits - see media/fonts/LICENSE-NOTE.md, which this
 * replaced an unresolved licensing question with.
 *
 * Absent files are skipped rather than 404'd, so a build with no `media/fonts/`
 * still renders on the system stack in the CSS. `font-src` is scoped to the
 * extension origin and nothing here is remote, so the CSP is unchanged.
 */
function fontFaces(extensionUri: vscode.Uri, webview: vscode.Webview): string {
  const dir = vscode.Uri.joinPath(extensionUri, "media", "fonts");
  let names: string[];
  try {
    names = fs.readdirSync(dir.fsPath);
  } catch {
    return "";
  }

  const wanted: { file: string; family: string; weight: string; italic?: true }[] = [
    // Two faces, one per ROLE, both variable so each is a single file.
    //
    // JetBrains Mono is the interface: labels, tabs, the wordmark, code, and
    // every id that has to line up in a column.
    //
    // IBM Plex Sans is prose, and only prose - --kx-prose in tokens.css names
    // exactly the surfaces it reaches. Setting long-form model output in a
    // monospace was the deliberate cost of the terminal direction, and it came
    // due: every character is a full advance, so a line with no narrow letters
    // to absorb it wraps early, and the transcript broke mid-sentence at a
    // dock width where a proportional face still had room. That is the one
    // place the trade was not worth it.
    { file: "JetBrainsMono-Variable.woff2", family: "JetBrains Mono", weight: "100 800" },
    { file: "IBMPlexSans-Variable.woff2", family: "IBM Plex Sans", weight: "100 700" },
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
  return shell(webview, extensionUri, "sidebar", "Genesis");
}

export function controlCenterHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  return shell(webview, extensionUri, "controlCenter", "Genesis Control Center");
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
