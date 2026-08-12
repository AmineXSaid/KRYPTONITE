import * as vscode from "vscode";
import type { App } from "../core/app";
import { browserHtml, webviewOptions } from "./shell";
import { fetchPage, normaliseUrl } from "../browser/fetchPage";

/**
 * The browser tab.
 *
 * A singleton, like the Control Center, and for the same reason: two panels
 * would fight over one sink. Opening it again reveals the existing one, which
 * is also what makes reopening feel instant - there is nothing to rebuild.
 *
 * Two ways of showing a page, because neither is sufficient alone:
 *
 *   Live    an <iframe>. Interactive and current, and blind: a cross-origin
 *           frame cannot be read, so nothing here or in the agent can see the
 *           title, the text or the links. Many sites also refuse to frame at
 *           all - X-Frame-Options and CSP frame-ancestors are standard on
 *           anything with a login - and a refusal renders as a blank box with
 *           no explanation.
 *
 *   Reader  fetched on the active profile's dispatcher and reduced to text.
 *           Always works, always readable, and goes wherever the model's own
 *           endpoint goes: through the corporate CA, the CONNECT proxy and the
 *           client certificate. That is the part a system browser cannot do.
 *
 * The panel starts in Live and falls back to Reader by itself when a frame is
 * refused, because a blank box is the worst possible answer.
 */
export class BrowserPanel {
  static readonly viewType = "kryptonite.browser";
  private static current?: BrowserPanel;

  private disposables: vscode.Disposable[] = [];
  private inFlight?: AbortController;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly app: App,
    extensionUri: vscode.Uri
  ) {
    panel.webview.options = webviewOptions(extensionUri);
    panel.webview.html = browserHtml(panel.webview, extensionUri);
    panel.iconPath = {
      light: vscode.Uri.joinPath(extensionUri, "media", "icon.svg"),
      dark: vscode.Uri.joinPath(extensionUri, "media", "icon.svg"),
    };

    this.disposables.push(
      panel.webview.onDidReceiveMessage((raw: any) => void this.onMessage(raw))
    );
    panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  static show(app: App, extensionUri: vscode.Uri, url?: string): void {
    // Beside the editor rather than over it: a browser is a reference, and
    // replacing the file being worked on to show one is the opposite of that.
    const column = vscode.ViewColumn.Beside;

    if (BrowserPanel.current) {
      BrowserPanel.current.panel.reveal(column, true);
      if (url) void BrowserPanel.current.open(url);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      BrowserPanel.viewType,
      "Browser",
      { viewColumn: column, preserveFocus: true },
      // retainContextWhenHidden is what makes switching back feel instant:
      // without it the page is torn down and refetched on every tab change.
      { ...webviewOptions(extensionUri), retainContextWhenHidden: true }
    );
    BrowserPanel.current = new BrowserPanel(panel, app, extensionUri);
    if (url) void BrowserPanel.current.open(url);
  }

  /** Closing is a command as well as a tab button, so it can be bound. */
  static close(): void {
    BrowserPanel.current?.panel.dispose();
  }

  static isOpen(): boolean {
    return BrowserPanel.current !== undefined;
  }

  private async onMessage(msg: any): Promise<void> {
    switch (msg?.type) {
      case "browserOpen":
        await this.open(String(msg.url ?? ""));
        return;
      case "browserStop":
        this.inFlight?.abort();
        return;
      case "browserExternal":
        try {
          await vscode.env.openExternal(vscode.Uri.parse(normaliseUrl(String(msg.url ?? ""))));
        } catch (e: any) {
          this.post({ type: "browserError", message: String(e?.message ?? e) });
        }
        return;
      case "browserCopy":
        await vscode.env.clipboard.writeText(String(msg.text ?? ""));
        return;
      case "browserToAgent": {
        // The reason the reader exists: hand the page to the model without the
        // user having to copy it out.
        const text = String(msg.text ?? "").slice(0, 60_000);
        const url = String(msg.url ?? "");
        await this.app.session.send(
          `Here is the page at ${url}:\n\n${text}\n\nAnswer using only what it says.`
        );
        return;
      }
    }
  }

  /** Fetch a page for the reader half and report it. */
  private async open(raw: string): Promise<void> {
    let url: string;
    try {
      url = normaliseUrl(raw);
    } catch (e: any) {
      this.post({ type: "browserError", message: String(e?.message ?? e) });
      return;
    }

    this.inFlight?.abort();
    const ac = new AbortController();
    this.inFlight = ac;
    this.post({ type: "browserLoading", url });

    try {
      // The active profile's transport when there is one, so a page behind the
      // same corporate CA or proxy as the endpoint is reachable on the same
      // terms. Falls back to undici's default when no profile is selected.
      const profile = this.app.activeProfile();
      const dispatcher = profile ? (this.app.clientFor(profile) as any).dispatcher : undefined;
      const page = await fetchPage(url, { dispatcher, signal: ac.signal });
      if (ac.signal.aborted) return;
      this.post({ type: "browserPage", page });
      this.panel.title = page.title ? page.title.slice(0, 40) : "Browser";
    } catch (e: any) {
      if (ac.signal.aborted) return;
      this.post({ type: "browserError", message: String(e?.message ?? e), url });
    } finally {
      if (this.inFlight === ac) this.inFlight = undefined;
    }
  }

  private post(msg: unknown): void {
    void this.panel.webview.postMessage(msg);
  }

  private dispose(): void {
    BrowserPanel.current = undefined;
    this.inFlight?.abort();
    for (const d of this.disposables.splice(0)) {
      try {
        d.dispose();
      } catch {
        /* disposing twice is not worth a thrown error on shutdown */
      }
    }
  }
}
