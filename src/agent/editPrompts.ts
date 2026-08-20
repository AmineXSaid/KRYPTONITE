/**
 * The prompts behind the editor features.
 *
 * Kept apart from the providers that use them for one reason: these are the
 * part that can be wrong in a way no type checker catches. A prompt that
 * forgets to say "return only the code" produces a file with "Certainly!"
 * written into it, and the only way to notice before a user does is to assert
 * on the text itself.
 *
 * They are also shared. A quick fix on a diagnostic and `/fix` in the composer
 * must ask for the same thing, or the two features quietly diverge and the one
 * used less often rots.
 */

/** Structurally the `ProblemRef` from editorContext, without the vscode import. */
export interface PromptProblem {
  line: number;
  col: number;
  severity: string;
  message: string;
  source?: string;
  code?: string;
}

/** One diagnostic, as a compiler would print it. */
export function formatProblem(p: PromptProblem): string {
  const where = `${p.line}:${p.col}`;
  const who = [p.source, p.code].filter(Boolean).join(" ");
  return `${where}  ${p.severity}${who ? `  ${who}` : ""}  ${p.message}`;
}

export interface FixInput {
  path: string;
  language: string;
  /** The exact text the answer will replace. */
  code: string;
  problems: PromptProblem[];
}

/**
 * Repair the diagnostics in a snippet.
 *
 * The snippet is the unit rather than the file because the answer replaces a
 * range: asking about a file and applying the reply to a range is how a fix
 * for line 4 ends up overwriting line 400.
 */
export function fixPrompt(i: FixInput): string {
  const problems = i.problems.length
    ? i.problems.map(formatProblem).join("\n")
    : "(none reported; fix what is actually wrong)";

  return [
    `Fix the problems in this ${i.language} code from ${i.path}.`,
    "",
    "Reported problems:",
    problems,
    "",
    "Code:",
    fence(i.code, i.language),
    "",
    // Both halves matter. Without the first the model returns prose; without
    // the second it returns a fixed snippet re-indented to column zero, which
    // applies cleanly and corrupts the file.
    "Return only the corrected code, with no explanation and no code fence.",
    "Keep the original indentation of the first line and the surrounding style.",
    "Change as little as possible: fix the reported problems and nothing else.",
  ].join("\n");
}

export interface DocInput {
  path: string;
  language: string;
  code: string;
}

/**
 * Add a doc comment to a symbol.
 *
 * The model returns the symbol *with* the comment rather than the comment
 * alone. Returning the comment alone means deciding where it goes, and the
 * answer differs by language, by decorator, by attribute and by whether the
 * symbol is exported. Returning the whole thing makes placement the model's
 * problem, which it is good at, and makes the edit a plain range replacement.
 */
export function docPrompt(i: DocInput): string {
  return [
    `Add a documentation comment to this ${i.language} code from ${i.path}.`,
    "",
    fence(i.code, i.language),
    "",
    "Use the documentation comment convention this language and file already use.",
    "Describe what it does, its parameters and what it returns. Do not describe how it works line by line.",
    "Return the original code unchanged with the comment added above it.",
    "Return only code, with no explanation and no code fence.",
    "Keep the original indentation of the first line.",
  ].join("\n");
}

export interface CommitInput {
  diff: string;
  /** Paths in the staged change, so the model can name the area. */
  files: string[];
  truncated: boolean;
  dropped: number;
}

/**
 * Write a commit message for a staged change.
 *
 * The truncation is stated rather than hidden. A model that believes it saw
 * the whole change writes "rename the config loader"; one that knows it saw
 * the first 400 lines of it writes something it can actually stand behind.
 */
export function commitPrompt(i: CommitInput): string {
  const parts = [
    "Write a git commit message for this staged change.",
    "",
    `Files (${i.files.length}):`,
    i.files.slice(0, 50).join("\n") + (i.files.length > 50 ? `\n… and ${i.files.length - 50} more` : ""),
    "",
    "Diff:",
    fence(i.diff, "diff"),
  ];
  if (i.truncated) {
    parts.push(
      "",
      `This diff was truncated; ${i.dropped} more lines were not shown. Describe the change you can see and do not guess at the rest.`
    );
  }
  parts.push(
    "",
    "Write a subject line in the imperative mood, under 72 characters, with no trailing full stop.",
    "If the change needs explaining, add a blank line and a short body saying why, not what.",
    "Return only the message, with no explanation, no quotes and no code fence."
  );
  return parts.join("\n");
}

export interface ExplainInput {
  path: string;
  language: string;
  code: string;
  startLine: number;
}

/**
 * Explain a selection. Unlike the others this one goes into the chat, so it
 * asks for prose and gets to keep its formatting.
 */
export function explainPrompt(i: ExplainInput): string {
  const end = i.startLine + i.code.split("\n").length - 1;
  return [
    `Explain this ${i.language} code from ${i.path} (lines ${i.startLine}-${end}):`,
    "",
    fence(i.code, i.language),
    "",
    "Say what it does and why it might be written this way. Call out anything surprising or wrong.",
  ].join("\n");
}

export interface TestsInput {
  path: string;
  language: string;
  code: string;
}

/** Ask for tests. Also chat-bound: the user chooses where they land. */
export function testsPrompt(i: TestsInput): string {
  return [
    `Write tests for this ${i.language} code from ${i.path}:`,
    "",
    fence(i.code, i.language),
    "",
    "Use the test framework and conventions already used in this project.",
    "Cover the edge cases and failure paths, not just the happy path.",
  ].join("\n");
}

/**
 * Fence a snippet for a prompt.
 *
 * Chooses a fence long enough to survive whatever the snippet contains -
 * source files about markdown really do contain triple backticks, and a naive
 * fence there ends the block early and hands the model a truncated snippet.
 */
export function fence(code: string, language = ""): string {
  let longest = 0;
  for (const m of code.matchAll(/`{3,}/g)) longest = Math.max(longest, m[0].length);
  const bars = "`".repeat(Math.max(3, longest + 1));
  return `${bars}${language}\n${code}\n${bars}`;
}
