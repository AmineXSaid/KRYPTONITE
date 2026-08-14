/**
 * Choosing what a code action or a CodeLens applies to.
 *
 * Every editor feature here needs the same answer to the same question: given
 * a cursor, what is the smallest meaningful piece of code around it? Get it
 * wrong in one direction and the model documents a single line; get it wrong
 * in the other and a CodeLens on a 900-line class sends the whole file on
 * every click.
 *
 * Written against a structural shape rather than `vscode.DocumentSymbol` so it
 * can be tested without an editor. The real type satisfies it.
 */

export interface SymbolLike {
  name: string;
  kind: number;
  range: { start: { line: number }; end: { line: number } };
  /** The symbol's name, used for the CodeLens label. */
  selectionRange?: { start: { line: number }; end: { line: number } };
  children?: SymbolLike[];
}

/**
 * `vscode.SymbolKind` values worth acting on.
 *
 * Deliberately not every kind the language server reports. A CodeLens above
 * every variable and every property is not a feature, it is a wall of links
 * that people turn off within a minute, taking the useful ones with it.
 */
export const ACTIONABLE_KINDS = new Set([
  4, // Class
  5, // Method
  8, // Constructor
  9, // Enum
  10, // Interface
  11, // Function
  22, // Struct
]);

/**
 * The innermost actionable symbol containing a line.
 *
 * Innermost rather than outermost: with the cursor in a method, the method is
 * the thing being asked about, not the class that holds it.
 *
 * `maxLines` is a guard rather than a preference. Sending a 900-line class to
 * be documented costs more than the doc comment is worth and usually exceeds
 * what the model will write back, so an oversized symbol is treated as no
 * symbol and the caller falls back to the selection.
 */
export function innermostAt(
  symbols: SymbolLike[] | undefined,
  line: number,
  maxLines = 400
): SymbolLike | undefined {
  let best: SymbolLike | undefined;

  const walk = (list: SymbolLike[] | undefined): void => {
    for (const s of list ?? []) {
      if (line < s.range.start.line || line > s.range.end.line) continue;
      const span = s.range.end.line - s.range.start.line + 1;
      if (ACTIONABLE_KINDS.has(s.kind) && span <= maxLines) {
        // Later wins only when it is strictly smaller, so a child replaces its
        // parent but a sibling that merely also contains the line does not.
        if (!best || span <= best.range.end.line - best.range.start.line + 1) best = s;
      }
      // Recurse regardless: an oversized class still holds right-sized methods.
      walk(s.children);
    }
  };
  walk(symbols);
  return best;
}

/**
 * Every actionable symbol, flattened, in document order.
 *
 * Used for CodeLens, where the parent and its children all get their own line.
 */
export function actionable(symbols: SymbolLike[] | undefined, maxLines = 400): SymbolLike[] {
  const out: SymbolLike[] = [];
  const walk = (list: SymbolLike[] | undefined): void => {
    for (const s of list ?? []) {
      const span = s.range.end.line - s.range.start.line + 1;
      if (ACTIONABLE_KINDS.has(s.kind) && span <= maxLines) out.push(s);
      walk(s.children);
    }
  };
  walk(symbols);
  return out.sort((a, b) => a.range.start.line - b.range.start.line);
}
