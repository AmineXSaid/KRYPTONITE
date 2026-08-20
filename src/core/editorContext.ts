/**
 * What the editor already knows, written down for the model.
 *
 * A user who types "fix this" has an editor in front of them: a file open, a
 * cursor in it, a red squiggle on line 88, four other tabs they were just
 * reading. None of that reached the model, so "this" resolved to nothing and
 * the turn was spent asking which file they meant.
 *
 * Deliberately no `vscode` import. Gathering is the host's job and lives in
 * `App`; this file is the shape and the rendering, which is the part with
 * decisions in it and the part worth testing without an editor running.
 *
 * The rendered block goes in the *user* message, never the system prompt.
 * That is not a stylistic choice: the system prompt is a cache key, and this
 * text changes every time the cursor moves. Putting it at the head would miss
 * the prompt cache on every single turn, which on a gateway that charges for
 * cache writes is worse than not having the feature.
 */

export type Severity = "error" | "warning" | "info";

export interface ProblemRef {
  /** 1-based, as a human and a compiler both count. */
  line: number;
  col: number;
  severity: Severity;
  message: string;
  /** "ts", "eslint", … when the diagnostic declares one. */
  source?: string;
  code?: string;
}

export interface ActiveFile {
  /** Workspace-relative where possible, absolute when outside the folder. */
  path: string;
  language: string;
  lines: number;
  cursorLine: number;
  dirty: boolean;
}

export interface EditorContext {
  active?: ActiveFile;
  /** Other editors on screen: a split view, not the tab bar. */
  visible: string[];
  /** Open tabs, in the order the editor reports them. */
  tabs: string[];
  /** Problems in the active file only. */
  problems: ProblemRef[];
  /** Everything else, as a count. A model does not need 400 warnings listed. */
  workspace: { errors: number; warnings: number; files: number };
}

export const EMPTY_CONTEXT: EditorContext = {
  visible: [],
  tabs: [],
  problems: [],
  workspace: { errors: 0, warnings: 0, files: 0 },
};

/** Caps. Every one of these is a token budget, not a display preference. */
const TAB_CAP = 10;
const PROBLEM_CAP = 12;
const MESSAGE_CAP = 200;

function clip(s: string, n: number): string {
  const flat = String(s ?? "").replace(/\s+/g, " ").trim();
  return flat.length > n ? flat.slice(0, n) + "…" : flat;
}

/**
 * The block as the model reads it, or "" when there is nothing to say.
 *
 * Returning "" matters: a window with no folder and no editor open must not
 * append an empty heading to every message, and a heading with nothing under
 * it reads to a model as though the editor were genuinely empty.
 *
 * It is labelled as automatic. Without that, a model cannot tell the
 * difference between a file the user deliberately attached and a file that
 * merely happened to be focused, and it will treat the second as an
 * instruction - answering about whatever was on screen instead of what was
 * asked.
 */
export function renderEditorContext(c: EditorContext): string {
  const lines: string[] = [];

  if (c.active) {
    const a = c.active;
    const bits = [a.language, `${a.lines} lines`, `cursor line ${a.cursorLine}`];
    if (a.dirty) bits.push("unsaved");
    lines.push(`Active file: ${a.path} (${bits.join(", ")})`);
  }

  const others = c.visible.filter((v) => v !== c.active?.path);
  if (others.length) lines.push(`Also on screen: ${others.join(", ")}`);

  const tabs = c.tabs.filter((t) => t !== c.active?.path);
  if (tabs.length) {
    const shown = tabs.slice(0, TAB_CAP);
    const rest = tabs.length - shown.length;
    lines.push(`Open tabs: ${shown.join(", ")}${rest ? `, and ${rest} more` : ""}`);
  }

  if (c.problems.length) {
    const shown = c.problems.slice(0, PROBLEM_CAP);
    const rest = c.problems.length - shown.length;
    lines.push(`Problems in ${c.active ? c.active.path : "the active file"}:`);
    for (const p of shown) {
      const tag = [p.source, p.code].filter(Boolean).join(" ");
      lines.push(
        `  ${p.line}:${p.col} ${p.severity} ${clip(p.message, MESSAGE_CAP)}${tag ? ` [${tag}]` : ""}`
      );
    }
    if (rest) lines.push(`  and ${rest} more`);
  }

  const w = c.workspace;
  if (w.errors || w.warnings) {
    const parts: string[] = [];
    if (w.errors) parts.push(`${w.errors} error${w.errors === 1 ? "" : "s"}`);
    if (w.warnings) parts.push(`${w.warnings} warning${w.warnings === 1 ? "" : "s"}`);
    lines.push(
      `Elsewhere in the workspace: ${parts.join(", ")} across ${w.files} file${w.files === 1 ? "" : "s"}`
    );
  }

  if (!lines.length) return "";
  return (
    "Editor context. This is what is on the user's screen right now, gathered " +
    "automatically - they did not attach it, and it is not necessarily what " +
    "they are asking about.\n" +
    lines.join("\n")
  );
}
