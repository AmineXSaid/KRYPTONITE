import * as vscode from "vscode";
import type { App } from "../core/app";
import type { InboundMessage, OutboundMessage } from "./protocol";
import { sidebarHtml, webviewOptions } from "./shell";

/**
 * The activity-bar sidebar.
 *
 * The provider is a thin conduit: it hands the webview its HTML, registers a
 * sink so `App` can push to it, and forwards inbound messages. It deliberately
 * holds no conversation state — a turn survives the view being hidden,
 * reloaded, or disposed, and the frontend re-hydrates from `stateSync` plus the
 * replay buffer when it comes back.
 */
export class SidebarProvider implements vscode.WebviewViewProvider {
  static readonly viewId = "kryptonite.sidebar";

  private view?: vscode.WebviewView;

  constructor(private readonly app: App, private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;

    view.webview.options = webviewOptions(this.extensionUri);
    view.webview.html = sidebarHtml(view.webview, this.extensionUri);

    const sink = (msg: OutboundMessage) => {
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
