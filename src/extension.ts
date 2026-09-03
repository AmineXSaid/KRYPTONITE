import * as vscode from "vscode";
import { App } from "./core/app";
import { SidebarProvider } from "./ui/sidebar";
import { ControlCenterPanel } from "./ui/controlCenter";
import { BrowserPanel } from "./ui/browser";
import { ProposedContent, QuickEdit } from "./ui/quickEdit";
import { registerEditorFeatures } from "./providers/editorFeatures";
import { registerCommitMessage } from "./providers/commitMessage";
import { applyTerminalTheme, revertTerminalTheme } from "./theme/terminal";
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
    // The panel's "Diff view" serves its left-hand side the same way, out of
    // the shadow repo. Same scheme, same provider class, its own store.
    instance.beforeContent,
    vscode.workspace.registerTextDocumentContentProvider(
      instance.beforeContent.scheme, instance.beforeContent
    ),
    ...registerEditorFeatures(instance, new QuickEdit(instance, proposed)),
    registerCommitMessage(instance),
    registerInlineCompletion(instance)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("genesis.focusSidebar", async () => {
      // `<viewId>.focus` is registered by VS Code for every contributed view and
      // opens whichever part the view currently lives in. The container command
      // would only find it in its declared home, so dragging the panel to the
      // Primary Side Bar or the panel would break this.
      await vscode.commands.executeCommand(`${SidebarProvider.viewId}.focus`);
      sidebar.reveal();
    }),

    vscode.commands.registerCommand("genesis.openControlCenter", (section?: CcSection) => {
      ControlCenterPanel.show(instance, context.extensionUri, section);
    }),

    vscode.commands.registerCommand("genesis.openBrowser", (url?: string) => {
      BrowserPanel.show(instance, context.extensionUri, url);
    }),

    // Distinct from openBrowser: this one lands on the agent's view and starts
    // watching, which is what "the model just launched a browser" calls for.
    vscode.commands.registerCommand("genesis.watchAgentBrowser", () => {
      BrowserPanel.showAgent(instance, context.extensionUri);
    }),

    // A separate command rather than only the tab's close button, so it can be
    // bound to a key and closed without reaching for the mouse.
    vscode.commands.registerCommand("genesis.closeBrowser", () => {
      BrowserPanel.close();
    }),

    /* The panel's palette, on the terminal beside it.

       The two are docked side by side and the terminal runs whatever ANSI
       colours the workbench theme ships, so they do not read as one product.
       Everything applied here is derived from `media/webview/tokens.css` - the
       same file the panel is drawn from - so the terminal cannot drift away
       from it. See src/theme/palette.ts for what has to be derived and why. */
    vscode.commands.registerCommand("genesis.applyTerminalTheme", async () => {
      const n = await applyTerminalTheme(context);
      void vscode.window.showInformationMessage(
        `Genesis: applied ${n.colors} terminal colours and ${n.fonts} font settings. ` +
          "Run \u201cRevert terminal theme\u201d to undo."
      );
    }),

    vscode.commands.registerCommand("genesis.revertTerminalTheme", async () => {
      const undone = await revertTerminalTheme(context);
      void vscode.window.showInformationMessage(
        undone
          ? "Genesis: terminal theme reverted."
          : "Genesis: no terminal theme to revert - nothing was applied."
      );
    }),

    /* The HOST'S file dialog, which the composer's attach button no longer
       uses.

       That button now opens a file input in the webview, because the webview
       renderer runs on the user's own machine while `showOpenDialog` runs on
       the extension host - and in a WSL, dev container or SSH window those are
       different computers, so the dialog could not reach the user's own disk.

       This dialog is still the only way to reach a file on the REMOTE machine
       that is outside the workspace, which `@` does not cover, so it keeps a
       route rather than being deleted with the button that used to call it. */
    vscode.commands.registerCommand("genesis.attachFromHost", async () => {
      await vscode.commands.executeCommand("genesis.focusSidebar");
      await instance.pickAndAttach();
    }),

    vscode.commands.registerCommand("genesis.searchWeb", async (query?: string) => {
      let q = typeof query === "string" ? query.trim() : "";
      if (!q) {
        const ed = vscode.window.activeTextEditor;
        const picked = ed && !ed.selection.isEmpty
          ? ed.document.getText(ed.selection).replace(/\s+/g, " ").trim().slice(0, 200)
          : "";
        q = (await vscode.window.showInputBox({
          title: "Search the web",
          prompt:
            "Runs on the active endpoint's connection, so it reaches whatever that " +
            "endpoint reaches - the same proxy, the same CAs.",
          placeHolder: "What are you looking for?",
          value: picked,
          ignoreFocusOut: true,
        }) ?? "").trim();
      }
      if (!q) return;
      BrowserPanel.search(instance, context.extensionUri, q);
    }),

    vscode.commands.registerCommand("genesis.newChat", async () => {
      instance.session.newChat();
      await vscode.commands.executeCommand("genesis.focusSidebar");
    }),

    vscode.commands.registerCommand("genesis.runDiagnostics", async () => {
      await vscode.commands.executeCommand("genesis.focusSidebar");
      await instance.runTrace();
    }),

    vscode.commands.registerCommand("genesis.selectEndpoint", () => instance.pickEndpoint()),

    vscode.commands.registerCommand("genesis.newEndpoint", () =>
      instance.handleMessage({ type: "newEndpoint" }, "sidebar")
    ),

    vscode.commands.registerCommand("genesis.restoreCheckpoint", () =>
      instance.pickCheckpointRestore()
    ),

    vscode.commands.registerCommand("genesis.selectAgent", () => instance.pickAgent()),

    vscode.commands.registerCommand("genesis.newAgent", async () => {
      try {
        await instance.newAgent();
      } catch (e) {
        vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e));
      }
    }),

    // Two entries rather than one with a picker: "export this chat" is the
    // common case and should not cost a second dialog before the save dialog.
    vscode.commands.registerCommand("genesis.exportChat", () => exportChat(instance, "current")),

    vscode.commands.registerCommand("genesis.exportAllChats", () => exportChat(instance, "all")),

    vscode.commands.registerCommand("genesis.exportBundle", async () => {
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
 * Where the panel lives.
 *
 * The manifest contributes the container to `viewsContainers.activitybar`, so
 * VS Code opens it in the PRIMARY Side Bar, alongside Explorer and Search.
 *
 * It was the Secondary Side Bar until 0.8, on the argument that an agent
 * belongs opposite the file tree rather than on top of it. It moved to satisfy
 * a request that has no other answer: open at the same width as the other
 * agent extension in the window. VS Code exposes no API for a view's width -
 * there is no such property on a view or a view container - and it remembers
 * ONE width per sidebar. Two extensions can therefore only share a width by
 * sharing a sidebar.
 *
 * That is the whole of the layout story: no command runs at activation and
 * nothing is moved. Dragging the panel to the Secondary Side Bar is a VS Code
 * gesture, and VS Code remembers it.
 *
 * What is left below is a one-time repair. Versions up to 0.5.4 moved the whole
 * Primary Side Bar to the right, because no container could be contributed to
 * the Secondary Side Bar at the time. Anyone who ran those versions has a
 * right-hand Explorer this extension put there, so it is this extension's job
 * to put it back.
 */
export const SIDEBAR_STATE_KEY = "genesis.sidebarSideApplied";

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
