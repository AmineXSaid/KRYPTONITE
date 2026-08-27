/**
 * The features that live in the editor rather than in the chat.
 *
 * A quick fix on a squiggle, a CodeLens above a function, a doc comment, an
 * explanation. They share one insight: the user has already told us what they
 * mean by putting the cursor somewhere, so asking them to describe it again in
 * a chat box is a step that did not need to exist.
 *
 * Two destinations, and which one a feature uses is a real decision:
 *
 *   Edit  the answer replaces a range in the document. Used where the answer
 *         is code and the user's intent is unambiguous - fix this, document
 *         this. Goes through QuickEdit, which handles the fence, the no-op and
 *         the file changing underfoot.
 *
 *   Chat  the answer is prose or needs somewhere to go. Used for explain and
 *         tests, because dropping a test file into the middle of a source file
 *         is not what anybody meant.
 */

import * as vscode from "vscode";
import type { App } from "../core/app";
import { QuickEdit } from "../ui/quickEdit";
import { fixPrompt, docPrompt, explainPrompt, testsPrompt } from "../agent/editPrompts";
import { innermostAt, actionable, SymbolLike } from "../agent/symbols";

/** Everything in this file is off one setting, so it can be turned off whole. */
function enabled(key: "codeLens" | "codeActions"): boolean {
  return vscode.workspace.getConfiguration("genesis").get<boolean>(key, true);
}

async function symbolsOf(uri: vscode.Uri): Promise<SymbolLike[] | undefined> {
  try {
    // Fails quietly on a language with no symbol provider, which is most of
    // them. The callers all fall back to the selection.
    return await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
      "vscode.executeDocumentSymbolProvider",
      uri
    );
  } catch {
    return undefined;
  }
}

/**
 * The range a feature should act on.
 *
 * A real selection wins outright: the user drew it, and second-guessing that
 * is how a tool loses trust. Otherwise the enclosing symbol, and failing that
 * the whole lines the cursor or diagnostic touches - never a partial line,
 * because replacing half a line reliably produces something that does not
 * parse.
 */
export async function targetRange(
  doc: vscode.TextDocument,
  where: vscode.Range
): Promise<vscode.Range> {
  if (!where.isEmpty && where.start.line !== where.end.line) return where;

  const sym = innermostAt(await symbolsOf(doc.uri), where.start.line);
  if (sym) {
    return new vscode.Range(
      new vscode.Position(sym.range.start.line, 0),
      doc.lineAt(Math.min(sym.range.end.line, doc.lineCount - 1)).range.end
    );
  }
  return new vscode.Range(
    new vscode.Position(where.start.line, 0),
    doc.lineAt(where.end.line).range.end
  );
}

/* ── code actions ───────────────────────────────────────────────────────── */

export class GenesisCodeActions implements vscode.CodeActionProvider {
  /**
   * A function rather than a static field.
   *
   * As a static it ran at module load, which meant importing this file at all
   * required `vscode.CodeActionKind` to exist. That is true in the extension
   * host and not true anywhere else, so a harness that loads the built bundle
   * to check something unrelated died on an API it never touches. Evaluated at
   * registration, it costs the same and depends on nothing until it is used.
   */
  static metadata(): vscode.CodeActionProviderMetadata {
    return {
      providedCodeActionKinds: [
        vscode.CodeActionKind.QuickFix,
        vscode.CodeActionKind.RefactorRewrite,
      ],
    };
  }

  provideCodeActions(
    doc: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    ctx: vscode.CodeActionContext
  ): vscode.CodeAction[] {
    if (!enabled("codeActions")) return [];
    const out: vscode.CodeAction[] = [];

    // Only the diagnostics the editor says are in scope. Offering to fix a
    // problem 200 lines away because it happens to be in the same file is the
    // fastest way to make the lightbulb useless.
    const problems = ctx.diagnostics ?? [];
    if (problems.length) {
      const a = new vscode.CodeAction(
        problems.length === 1 ? "Fix with Genesis" : `Fix ${problems.length} problems with Genesis`,
        vscode.CodeActionKind.QuickFix
      );
      a.diagnostics = [...problems];
      a.command = {
        command: "genesis.fixProblem",
        title: "Fix with Genesis",
        // Diagnostics are passed rather than re-read. By the time the command
        // runs the user may have moved, and the fix must address the squiggle
        // they clicked on, not whatever is under the cursor now.
        arguments: [doc.uri, range, problems.map(plain)],
      };
      out.push(a);
    }

    const doc_ = new vscode.CodeAction("Document with Genesis", vscode.CodeActionKind.RefactorRewrite);
    doc_.command = {
      command: "genesis.documentSymbol",
      title: "Document with Genesis",
      arguments: [doc.uri, range],
    };
    out.push(doc_);

    const explain = new vscode.CodeAction("Explain with Genesis", vscode.CodeActionKind.Empty);
    explain.command = {
      command: "genesis.explainSelection",
      title: "Explain with Genesis",
      arguments: [doc.uri, range],
    };
    out.push(explain);

    return out;
  }
}

/** A `vscode.Diagnostic` reduced to what the prompt needs. */
function plain(d: vscode.Diagnostic) {
  const sev = ["error", "warning", "info", "hint"][d.severity] ?? "info";
  return {
    line: d.range.start.line + 1,
    col: d.range.start.character + 1,
    severity: sev,
    message: d.message,
    source: d.source,
    code: typeof d.code === "object" ? String((d.code as any).value) : d.code?.toString(),
  };
}

/* ── code lens ──────────────────────────────────────────────────────────── */

export class GenesisCodeLens implements vscode.CodeLensProvider {
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;

  /** Called when the setting flips, so lenses appear or vanish immediately. */
  refresh(): void {
    this.emitter.fire();
  }

  async provideCodeLenses(doc: vscode.TextDocument): Promise<vscode.CodeLens[]> {
    if (!enabled("codeLens")) return [];
    // A lens per symbol in a 6,000-line file is thousands of resolved commands
    // and a visibly slower editor for no benefit; nobody reads that far.
    if (doc.lineCount > 5000) return [];

    const syms = actionable(await symbolsOf(doc.uri));
    const out: vscode.CodeLens[] = [];
    for (const s of syms) {
      const at = new vscode.Range(s.range.start.line, 0, s.range.start.line, 0);
      const args = [doc.uri, new vscode.Range(s.range.start.line, 0, s.range.end.line, 0)];
      out.push(
        new vscode.CodeLens(at, { title: "Explain", command: "genesis.explainSelection", arguments: args }),
        new vscode.CodeLens(at, { title: "Document", command: "genesis.documentSymbol", arguments: args }),
        new vscode.CodeLens(at, { title: "Tests", command: "genesis.writeTests", arguments: args })
      );
    }
    return out;
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

/* ── the commands behind them ───────────────────────────────────────────── */

export function registerEditorFeatures(app: App, quick: QuickEdit): vscode.Disposable[] {
  const lens = new GenesisCodeLens();

  /** Resolve the arguments a command may or may not have been given. */
  const resolve = async (
    uri?: vscode.Uri,
    range?: vscode.Range
  ): Promise<{ doc: vscode.TextDocument; range: vscode.Range } | undefined> => {
    // Invoked from the palette there are no arguments, so fall back to the
    // active editor. Without this every one of these is greyed out in the
    // palette for no visible reason.
    const ed = vscode.window.activeTextEditor;
    const target = uri ?? ed?.document.uri;
    if (!target) {
      void vscode.window.showInformationMessage("Genesis: open a file first.");
      return undefined;
    }
    const doc = await vscode.workspace.openTextDocument(target);
    const where = range ?? ed?.selection ?? new vscode.Range(0, 0, 0, 0);
    return { doc, range: await targetRange(doc, where) };
  };

  /** Explain and Tests both put a prompt in the chat and reveal it. */
  const toChat = async (prompt: string): Promise<void> => {
    await vscode.commands.executeCommand("genesis.focusSidebar");
    await app.session.send(prompt);
  };

  return [
    lens,
    vscode.languages.registerCodeActionsProvider(
      { scheme: "file" },
      new GenesisCodeActions(),
      GenesisCodeActions.metadata()
    ),
    vscode.languages.registerCodeLensProvider({ scheme: "file" }, lens),

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("genesis.codeLens")) lens.refresh();
    }),

    vscode.commands.registerCommand(
      "genesis.fixProblem",
      async (uri?: vscode.Uri, range?: vscode.Range, problems?: any[]) => {
        const r = await resolve(uri, range);
        if (!r) return;
        await quick.run({
          title: "fixing",
          uri: r.doc.uri,
          range: r.range,
          maxTokens: 2048,
          prompt: fixPrompt({
            path: vscode.workspace.asRelativePath(r.doc.uri),
            language: r.doc.languageId,
            code: r.doc.getText(r.range),
            problems: problems ?? [],
          }),
        });
      }
    ),

    vscode.commands.registerCommand(
      "genesis.documentSymbol",
      async (uri?: vscode.Uri, range?: vscode.Range) => {
        const r = await resolve(uri, range);
        if (!r) return;
        await quick.run({
          title: "documenting",
          uri: r.doc.uri,
          range: r.range,
          maxTokens: 2048,
          prompt: docPrompt({
            path: vscode.workspace.asRelativePath(r.doc.uri),
            language: r.doc.languageId,
            code: r.doc.getText(r.range),
          }),
        });
      }
    ),

    vscode.commands.registerCommand(
      "genesis.explainSelection",
      async (uri?: vscode.Uri, range?: vscode.Range) => {
        const r = await resolve(uri, range);
        if (!r) return;
        await toChat(
          explainPrompt({
            path: vscode.workspace.asRelativePath(r.doc.uri),
            language: r.doc.languageId,
            code: r.doc.getText(r.range),
            startLine: r.range.start.line + 1,
          })
        );
      }
    ),

    vscode.commands.registerCommand(
      "genesis.writeTests",
      async (uri?: vscode.Uri, range?: vscode.Range) => {
        const r = await resolve(uri, range);
        if (!r) return;
        await toChat(
          testsPrompt({
            path: vscode.workspace.asRelativePath(r.doc.uri),
            language: r.doc.languageId,
            code: r.doc.getText(r.range),
          })
        );
      }
    ),
  ];
}
