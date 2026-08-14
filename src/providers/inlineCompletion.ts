/**
 * Ghost-text completion.
 *
 * Off by default, behind two independent gates, and that is the design rather
 * than timidity. Inline completion wants a sub-500ms round trip and a
 * fill-in-the-middle model; this extension exists for corporate gateways,
 * air-gapped deployments and mTLS endpoints, which usually offer neither. On
 * those it would be the feature most likely to feel broken, and a laggy
 * suggestion nobody asked for is worse than no suggestion.
 *
 * So it takes both `capabilities.fim` on the profile (does this endpoint have
 * any business doing this?) and `kryptonite.inlineCompletion` in settings (do
 * you want it?). Either one off means not a single request is sent.
 */

import * as vscode from "vscode";
import type { App } from "../core/app";
import {
  Lru,
  completionKey,
  fimPrompt,
  windowAround,
  trimCompletion,
  worthCompleting,
} from "../agent/completion";
import { unfence } from "../agent/oneShot";

/** Long enough that a pause in typing means something, short enough to feel live. */
const DEBOUNCE_MS = 250;

const SYSTEM =
  "You complete code at a cursor. You reply with code and nothing else: " +
  "no explanation, no code fence, no repetition of the surrounding text.";

export class InlineCompletions implements vscode.InlineCompletionItemProvider {
  private cache = new Lru<string>(100);

  constructor(private readonly app: App) {}

  private enabled(): boolean {
    if (!vscode.workspace.getConfiguration("kryptonite").get<boolean>("inlineCompletion", false)) {
      return false;
    }
    return this.app.activeProfile()?.capabilities.fim === true;
  }

  async provideInlineCompletionItems(
    doc: vscode.TextDocument,
    position: vscode.Position,
    _ctx: vscode.InlineCompletionContext,
    token: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionItem[]> {
    if (!this.enabled()) return [];
    // A turn in flight is using the same endpoint and the same connection
    // pool. Racing it with a keystroke completion makes the chat slower for a
    // suggestion nobody is waiting on.
    if (this.app.session.running) return [];

    const line = doc.lineAt(position.line);
    const linePrefix = line.text.slice(0, position.character);
    const lineSuffix = line.text.slice(position.character);
    if (!worthCompleting(linePrefix, lineSuffix)) return [];

    const text = doc.getText();
    const offset = doc.offsetAt(position);
    const { prefix, suffix } = windowAround(text, offset);

    const key = completionKey(doc.uri.toString(), doc.version, prefix);
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached ? [item(cached, position)] : [];

    // Debounce. Every keystroke calls this method, and without a wait here the
    // feature sends a request per character typed.
    if (!(await idleFor(DEBOUNCE_MS, token))) return [];

    const ac = new AbortController();
    token.onCancellationRequested(() => ac.abort());

    let answer: string;
    try {
      answer = await this.app.oneShot(
        fimPrompt({
          path: vscode.workspace.asRelativePath(doc.uri),
          language: doc.languageId,
          prefix,
          suffix,
        }),
        { system: SYSTEM, maxTokens: 160, signal: ac.signal }
      );
    } catch {
      // Silent by design. This runs on a timer the user did not start, and a
      // toast for every failed completion would be unusable on a flaky link.
      return [];
    }
    if (token.isCancellationRequested) return [];

    const out = trimCompletion(unfence(answer), prefix, suffix);
    // Negative results are cached too, so a position with nothing to say does
    // not get re-asked every time the cursor returns to it.
    this.cache.set(key, out);
    return out ? [item(out, position)] : [];
  }
}

function item(text: string, position: vscode.Position): vscode.InlineCompletionItem {
  return new vscode.InlineCompletionItem(text, new vscode.Range(position, position));
}

/** Resolve true if nothing cancelled us for `ms`. */
function idleFor(ms: number, token: vscode.CancellationToken): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      sub.dispose();
      resolve(!token.isCancellationRequested);
    }, ms);
    const sub = token.onCancellationRequested(() => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

export function registerInlineCompletion(app: App): vscode.Disposable {
  // Registered for every document rather than a language list. The gates above
  // decide whether anything happens, and a language allow-list would silently
  // exclude whatever the user actually writes.
  return vscode.languages.registerInlineCompletionItemProvider(
    { pattern: "**" },
    new InlineCompletions(app)
  );
}
