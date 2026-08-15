import * as vscode from "vscode";
import { App } from "./core/app";
import { SidebarProvider } from "./ui/sidebar";
import { ControlCenterPanel } from "./ui/controlCenter";
import { BrowserPanel } from "./ui/browser";
import { ProposedContent, QuickEdit } from "./ui/quickEdit";
import { registerEditorFeatures } from "./providers/editorFeatures";
import { registerCommitMessage } from "./providers/commitMessage";
import { registerInlineCompletion } from "./providers/inlineCompletion";
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

  // The editor-side features: quick fixes, CodeLens, doc comments, commit
  // messages. They share one model path and one edit applier, which is why
  // they are constructed together rather than each reaching for their own.
  const proposed = new ProposedContent();
  context.subscriptions.push(
    proposed,
    vscode.workspace.registerTextDocumentContentProvider(ProposedContent.scheme, proposed),
    ...registerEditorFeatures(instance, new QuickEdit(instance, proposed)),
    registerCommitMessage(instance),
    registerInlineCompletion(instance)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("kryptonite.focusSidebar", async () => {
      // `<viewId>.focus` is registered by VS Code for every contributed view and
      // opens whichever part the view currently lives in. The container command
      // would only find it in its declared home, so dragging the panel to the
      // Primary Side Bar or the panel would break this.
      await vscode.commands.executeCommand(`${SidebarProvider.viewId}.focus`);
      sidebar.reveal();
    }),

    vscode.commands.registerCommand("kryptonite.openControlCenter", (section?: CcSection) => {
      ControlCenterPanel.show(instance, context.extensionUri, section);
    }),

    vscode.commands.registerCommand("kryptonite.openBrowser", (url?: string) => {
      BrowserPanel.show(instance, context.extensionUri, url);
    }),

    // Distinct from openBrowser: this one lands on the agent's view and starts
    // watching, which is what "the model just launched a browser" calls for.
    vscode.commands.registerCommand("kryptonite.watchAgentBrowser", () => {
      BrowserPanel.showAgent(instance, context.extensionUri);
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

  // After the commands are registered, and not awaited: the window should not
  // wait on a layout repair to finish activating.
  void undoSideBarMove(context);
}

/**
 * Where the panel lives.
 *
 * The manifest contributes the container to `viewsContainers.secondarySidebar`,
 * so VS Code opens it in the Secondary Side Bar - the strip on the far right,
 * beside the editor. That is the whole of the layout story now: no command runs
 * at activation, nothing is moved, and the Primary Side Bar keeps Explorer and
 * Search on the left where the user put them. Dragging the panel elsewhere is a
 * VS Code gesture and VS Code remembers it.
 *
 * What is left below is a one-time repair. Versions up to 0.5.4 moved the whole
 * Primary Side Bar to the right, because no container could be contributed to
 * the Secondary Side Bar at the time. Anyone who ran those versions has a
 * right-hand Explorer this extension put there, so it is this extension's job
 * to put it back.
 */
export const SIDEBAR_STATE_KEY = "kryptonite.sidebarSideApplied";

/**
 * Undo the Primary Side Bar move that older versions applied, once.
 *
 * Gated on the same globalState key those versions wrote, so it fires exactly
 * on the machines that were affected and never on a fresh install. The key is
 * cleared first: if the workbench command throws, the repair is still not
 * retried on every window, because a bar that stays on the right is a smaller
 * annoyance than an extension that fights the layout every morning.
 */
export async function undoSideBarMove(context: vscode.ExtensionContext): Promise<void> {
  if (context.globalState.get<string>(SIDEBAR_STATE_KEY) !== "right") return;
  await context.globalState.update(SIDEBAR_STATE_KEY, undefined);
  try {
    await vscode.commands.executeCommand("workbench.action.moveSideBarLeft");
  } catch {
    // Not a reason to fail activation. The panel is on the right either way.
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
