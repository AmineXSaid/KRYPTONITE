import * as vscode from "vscode";
import type { App } from "../core/app";
import type { CcSection, InboundMessage, OutboundMessage } from "./protocol";
import { controlCenterHtml, webviewOptions } from "./shell";

/**
 * The Control Center editor tab.
 *
 * A singleton: opening it twice reveals the existing panel rather than making a
 * second copy, because two panels would both register the `"cc"` sink and one
 * would silently stop receiving updates.
 */
export class ControlCenterPanel {
  static readonly viewType = "kryptonite.controlCenter";
  private static current?: ControlCenterPanel;

  private disposables: vscode.Disposable[] = [];
  private pendingSection?: CcSection;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly app: App,
    extensionUri: vscode.Uri
  ) {
    panel.webview.options = webviewOptions(extensionUri);
    panel.webview.html = controlCenterHtml(panel.webview, extensionUri);
    panel.iconPath = {
      light: vscode.Uri.joinPath(extensionUri, "media", "icon.svg"),
      dark: vscode.Uri.joinPath(extensionUri, "media", "icon.svg"),
    };

    const sink = (msg: OutboundMessage) => {
      void panel.webview.postMessage(msg);
    };
    app.registerSink("cc", sink);

    this.disposables.push(
      panel.webview.onDidReceiveMessage((raw: InboundMessage) => {
        void app.handleMessage(raw, "cc");
      })
    );

    panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  static show(app: App, extensionUri: vscode.Uri, section?: CcSection): void {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.Active;

    if (ControlCenterPanel.current) {
      ControlCenterPanel.current.panel.reveal(column, false);
      if (section) ControlCenterPanel.current.navigate(section);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      ControlCenterPanel.viewType,
      "Genesis",
      { viewColumn: column, preserveFocus: false },
      webviewOptions(extensionUri)
    );

    ControlCenterPanel.current = new ControlCenterPanel(panel, app, extensionUri);

    // The frontend posts `ready` once its script runs; navigating before that
    // would be dropped, so the requested section is queued until then.
    if (section) ControlCenterPanel.current.pendingSection = section;
  }

  /** Called by App after the CC surface reports ready. */
  static flushPendingSection(app: App): void {
    const current = ControlCenterPanel.current;
    if (!current?.pendingSection) return;
    const section = current.pendingSection;
    current.pendingSection = undefined;
    app.postTo("cc", { type: "navigate", section });
  }

  navigate(section: CcSection): void {
    this.app.postTo("cc", { type: "navigate", section });
  }

  static isOpen(): boolean {
    return Boolean(ControlCenterPanel.current);
  }

  private dispose(): void {
    ControlCenterPanel.current = undefined;
    this.app.unregisterSink("cc");
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
    this.panel.dispose();
  }
}
