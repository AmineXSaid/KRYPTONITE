import * as vscode from "vscode";
import type { App } from "../core/app";
import type { InboundMessage, OutboundMessage } from "./protocol";
import { sidebarHtml, webviewOptions } from "./shell";

/**
 * The panel itself, contributed to the Secondary Side Bar.
 *
 * The provider is a thin conduit: it hands the webview its HTML, registers a
 * sink so `App` can push to it, and forwards inbound messages. It deliberately
 * holds no conversation state - a turn survives the view being hidden,
 * reloaded, or disposed, and the frontend re-hydrates from `stateSync` plus the
 * replay buffer when it comes back.
 */
export class SidebarProvider implements vscode.WebviewViewProvider {
  static readonly viewId = "genesis.sidebar";

  private view?: vscode.WebviewView;

  constructor(private readonly app: App, private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;

    view.webview.options = webviewOptions(this.extensionUri);
    view.webview.html = sidebarHtml(view.webview, this.extensionUri);

    const sink = (msg: OutboundMessage) => {
      // A generated image is stored as a workspace-relative path, because that
      // is what survives in a saved session. Turning it into a URI the webview
      // may actually load has to happen here: `asWebviewUri` is per-webview, so
      // neither the agent nor the session can do it.
      if (msg.type === "imageGenerated" && !msg.src) {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri;
        if (root) {
          msg = {
            ...msg,
            src: view.webview.asWebviewUri(vscode.Uri.joinPath(root, ...msg.path.split("/"))).toString(),
          };
        }
      }
      void view.webview.postMessage(msg);
    };
    this.app.registerSink("sidebar", sink);

    const sub = view.webview.onDidReceiveMessage((raw: InboundMessage) => {
      void this.app.handleMessage(raw, "sidebar");
    });

    view.onDidDispose(() => {
      sub.dispose();
      this.app.unregisterSink("sidebar");
      this.view = undefined;
    });
  }

  /** Reveal the view without stealing keyboard focus from the editor. */
  reveal(): void {
    this.view?.show?.(true);
  }
}
