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

    vscode.commands.registerCommand("kryptonite.moveToRight", async () => {
      await setSidebarSide("right", context);
    }),

    vscode.commands.registerCommand("kryptonite.moveToLeft", async () => {
      await setSidebarSide("left", context);
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

    vscode.commands.registerCommand("kryptonite.selectAgent", () => instance.pickAgent()),

    vscode.commands.registerCommand("kryptonite.newAgent", async () => {
      try {
        await instance.newAgent();
      } catch (e) {
        vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e));
      }
    }),

    // Two entries rather than one with a picker: "export this chat" is the
    // common case and should not cost a second dialog before the save dialog.
    vscode.commands.registerCommand("kryptonite.exportChat", () => exportChat(instance, "current")),

    vscode.commands.registerCommand("kryptonite.exportAllChats", () => exportChat(instance, "all")),

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

  // After the commands are registered, and not awaited: the window should not
  // wait on a layout preference to finish activating.
  void applySidebarSide(context);
}

/**
 * Run a chat export and report it, whichever surface asked for it.
 *
 * Dismissing the save dialog returns no path and is a normal outcome - it must
 * not surface as an error, which is the only reason this is not a one-liner.
 */
async function exportChat(instance: App, scope: "current" | "all"): Promise<void> {
  try {
    const file = await instance.exportChat(scope);
    if (!file) return;
    const open = await vscode.window.showInformationMessage(
      `Chat exported to ${file}.`,
      "Open"
    );
    if (open) {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      await vscode.window.showTextDocument(doc, { preview: false });
    }
  } catch (e) {
    vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e));
  }
}

/**
 * Which side of the window the sidebar sits on.
 *
 * VS Code has no way for an extension to place its own view container on the
 * right. A `viewsContainers.activitybar` contribution goes to the Primary Side
 * Bar, and the only commands that move anything are the two that move that
 * whole bar - there is no per-view equivalent. So this is honest about its
 * scope: it moves the Primary Side Bar, taking Explorer, Search and everything
 * else with it. That is what "sidebar on the right" means in VS Code, and it is
 * the same thing the built-in setting does.
 *
 * The alternative - the Secondary Side Bar on the far right - can only be
 * reached by dragging the container there by hand. Nothing in the API does it.
 */
export const SIDEBAR_STATE_KEY = "kryptonite.sidebarSideApplied";
/** Kept equal to the manifest's default; a test asserts they have not drifted. */
export const SIDEBAR_DEFAULT: "left" | "right" | "keep" = "right";

export async function setSidebarSide(
  side: "left" | "right",
  context: vscode.ExtensionContext
): Promise<void> {
  await vscode.commands.executeCommand(
    side === "right" ? "workbench.action.moveSideBarRight" : "workbench.action.moveSideBarLeft"
  );
  await context.globalState.update(SIDEBAR_STATE_KEY, side);
}

/**
 * Apply the configured side, once per change of that setting.
 *
 * Deliberately not on every activation. Someone who drags the bar back should
 * find it where they left it, and an extension that silently re-moves it on
 * each window is one people uninstall. Recording what was last applied means
 * this fires when the preference actually changes and stays quiet otherwise.
 */
export async function applySidebarSide(context: vscode.ExtensionContext): Promise<void> {
  // The fallback matches the manifest default deliberately. VS Code returns
  // the declared default and this argument never fires, so the two silently
  // disagreeing would only show up somewhere the manifest is not loaded.
  const want = vscode.workspace
    .getConfiguration("kryptonite")
    .get<"left" | "right" | "keep">("sidebarPosition", SIDEBAR_DEFAULT);
  if (want === "keep") return;
  if (context.globalState.get<string>(SIDEBAR_STATE_KEY) === want) return;
  try {
    await setSidebarSide(want, context);
  } catch {
    // An older VS Code without these commands is not a reason to fail
    // activation; the extension works perfectly well on either side.
  }
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
