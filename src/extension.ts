import * as vscode from "vscode";
import { App } from "./core/app";
import { SidebarProvider } from "./ui/sidebar";
import { ControlCenterPanel } from "./ui/controlCenter";
import { BrowserPanel } from "./ui/browser";
import type { CcSection } from "./ui/protocol";

/**
 * Activation is intentionally thin. Everything of substance lives in `App`;
 * this file wires the three surfaces to it and registers the command palette
 * entries.
 *
 * Nothing here assumes a workspace folder is open. With no folder, `App` loads
 * zero profiles, the sidebar renders its empty state, and every root-dependent
 * handler answers with "Open a folder first." rather than throwing.
 */

let app: App | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const instance = new App(context);
  app = instance;
  await instance.init();

  const sidebar = new SidebarProvider(instance, context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SidebarProvider.viewId, sidebar, {
      // A hidden sidebar keeps its transcript rather than rebuilding it from
      // scratch every time the user visits Explorer mid-stream.
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("kryptonite.focusSidebar", async () => {
      await vscode.commands.executeCommand("workbench.view.extension.kryptonite");
      sidebar.reveal();
    }),

    vscode.commands.registerCommand("kryptonite.openControlCenter", (section?: CcSection) => {
      ControlCenterPanel.show(instance, context.extensionUri, section);
    }),

    vscode.commands.registerCommand("kryptonite.openBrowser", (url?: string) => {
      BrowserPanel.show(instance, context.extensionUri, url);
    }),

    // A separate command rather than only the tab's close button, so it can be
    // bound to a key and closed without reaching for the mouse.
    vscode.commands.registerCommand("kryptonite.closeBrowser", () => {
      BrowserPanel.close();
    }),

    vscode.commands.registerCommand("kryptonite.newChat", async () => {
      instance.session.newChat();
      await vscode.commands.executeCommand("kryptonite.focusSidebar");
    }),

    vscode.commands.registerCommand("kryptonite.runDiagnostics", async () => {
      await vscode.commands.executeCommand("kryptonite.focusSidebar");
      await instance.runTrace();
    }),

    vscode.commands.registerCommand("kryptonite.selectEndpoint", () => instance.pickEndpoint()),

    vscode.commands.registerCommand("kryptonite.newEndpoint", () =>
      instance.handleMessage({ type: "newEndpoint" }, "sidebar")
    ),

    vscode.commands.registerCommand("kryptonite.restoreCheckpoint", () =>
      instance.pickCheckpointRestore()
    ),

    vscode.commands.registerCommand("kryptonite.exportBundle", async () => {
      try {
        await instance.exportBundle();
        vscode.window.showInformationMessage("Offline bundle written to dist/.");
      } catch (e) {
        vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e));
      }
    })
  );

  context.subscriptions.push({ dispose: () => void instance.dispose() });
}

/**
 * Test hook. The extension host never calls this; the offline verification
 * harness uses it to reach `App` after activation, since there is no other way
 * to drive the session lifecycle without a running VS Code.
 */
export function __app(): App | undefined {
  return app;
}

export async function deactivate(): Promise<void> {
  await app?.dispose();
  app = undefined;
}
