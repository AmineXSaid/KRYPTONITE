/**
 * Putting a one-shot answer into a document.
 *
 * The three editor features - quick fix, doc comment, CodeLens - differ only
 * in what they ask for. Everything after the answer arrives is identical, and
 * it is the part with all the ways to get it wrong: writing a fence into
 * source, replacing a selection with the model's apology, replacing it with
 * itself, or writing into a file the user edited while waiting.
 *
 * That last one is the reason this is careful rather than three lines. A model
 * call takes seconds, an editor is live, and a range captured before the call
 * can point somewhere else by the time it returns. Applying anyway would
 * corrupt the file in a way the user did not do and cannot easily see.
 */

import * as vscode from "vscode";
import type { App } from "../core/app";
import { unfence } from "../agent/oneShot";

/**
 * Serves the proposed text to the diff view.
 *
 * A diff needs two documents and the proposal is not on disk, so it lives here
 * behind a custom scheme. Entries are dropped as soon as the diff closes -
 * this is a clipboard, not a cache, and holding the text would mean a stale
 * proposal could be reopened later and applied against a changed file.
 */
export class ProposedContent implements vscode.TextDocumentContentProvider {
  static readonly scheme = "kryptonite-proposed";

  private store = new Map<string, string>();
  private emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.store.get(uri.toString()) ?? "";
  }

  /**
   * The proposal keeps the original's file extension so the diff view gets
   * syntax highlighting. A diff of unhighlighted text is markedly harder to
   * read, and this view exists to be read.
   */
  put(original: vscode.Uri, text: string): vscode.Uri {
    const uri = original.with({
      scheme: ProposedContent.scheme,
      query: `k=${Date.now().toString(36)}`,
    });
    this.store.set(uri.toString(), text);
    this.emitter.fire(uri);
    return uri;
  }

  forget(uri: vscode.Uri): void {
    this.store.delete(uri.toString());
  }

  dispose(): void {
    this.store.clear();
    this.emitter.dispose();
  }
}

export interface QuickEditRequest {
  /** Shown in the progress notification, lowercase and short. */
  title: string;
  uri: vscode.Uri;
  /** The span the answer replaces. An empty range inserts. */
  range: vscode.Range;
  prompt: string;
  system?: string;
  maxTokens?: number;
}

export class QuickEdit {
  constructor(
    private readonly app: App,
    private readonly proposed: ProposedContent
  ) {}

  /** True when the document was changed. */
  async run(req: QuickEditRequest): Promise<boolean> {
    const doc = await vscode.workspace.openTextDocument(req.uri);
    // Version at the moment we read it. Everything below is checked against
    // this, because the user keeps typing while the model thinks.
    const version = doc.version;
    const before = doc.getText(req.range);

    let answer: string;
    try {
      answer = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Genesis: ${req.title}`, cancellable: true },
        async (_p, token) => {
          const ac = new AbortController();
          token.onCancellationRequested(() => ac.abort());
          return this.app.oneShot(req.prompt, {
            system: req.system,
            maxTokens: req.maxTokens,
            signal: ac.signal,
          });
        }
      );
    } catch (e: any) {
      // A cancelled request is the user's decision, not a failure to report.
      if (isAbort(e)) return false;
      void vscode.window.showErrorMessage(`Genesis: ${String(e?.message ?? e)}`);
      return false;
    }

    const next = unfence(answer);
    if (!next.trim()) {
      void vscode.window.showInformationMessage("Genesis: the model returned nothing to apply.");
      return false;
    }
    if (next === before) {
      void vscode.window.showInformationMessage("Genesis: no change needed.");
      return false;
    }

    const fresh = await vscode.workspace.openTextDocument(req.uri);
    if (fresh.version !== version) {
      // Refusing is the only safe answer. The range was measured against text
      // that no longer exists, so applying it would overwrite whatever now
      // occupies those offsets.
      void vscode.window.showWarningMessage(
        "Genesis: the file changed while the model was working, so nothing was applied."
      );
      return false;
    }

    if (this.app.uiConfig.previewDiff !== false && !(await this.confirm(fresh, req.range, next))) {
      return false;
    }

    const edit = new vscode.WorkspaceEdit();
    edit.replace(req.uri, req.range, next);
    const ok = await vscode.workspace.applyEdit(edit);
    if (!ok) void vscode.window.showWarningMessage("Genesis: the edit was rejected by the editor.");
    return ok;
  }

  /** Show the change as a diff and ask. */
  private async confirm(doc: vscode.TextDocument, range: vscode.Range, next: string): Promise<boolean> {
    const full = doc.getText();
    const start = doc.offsetAt(range.start);
    const end = doc.offsetAt(range.end);
    const proposedText = full.slice(0, start) + next + full.slice(end);

    const uri = this.proposed.put(doc.uri, proposedText);
    const name = doc.uri.path.split("/").pop() ?? "file";
    try {
      await vscode.commands.executeCommand("vscode.diff", doc.uri, uri, `${name}: proposed`, {
        preview: true,
        preserveFocus: false,
      });
      const go = await vscode.window.showInformationMessage(
        `Apply this change to ${name}?`,
        { modal: true },
        "Apply"
      );
      return go === "Apply";
    } finally {
      this.proposed.forget(uri);
    }
  }
}

/** An abort surfaces differently across undici versions and Node builds. */
function isAbort(e: any): boolean {
  return e?.name === "AbortError" || /abort/i.test(String(e?.message ?? ""));
}
