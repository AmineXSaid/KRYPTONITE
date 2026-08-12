import * as fs from "node:fs";
import * as path from "node:path";

/**
 * The project's standing instructions.
 *
 * A skill is loaded on demand, by name, when the model decides it is relevant.
 * That is the right shape for "how to review a test file" and the wrong shape
 * for "this repo targets Node 18, never use fetch" - a fact that has to be
 * true on every turn, including the first one, before the model has decided
 * anything. This file is the second shape: one document, always present, at
 * the stable head of the prompt.
 *
 * It lives at `.agent/instructions.md` rather than the `.kryptonite/` a
 * Copilot user might expect, because everything else this extension reads is
 * already under `.agent/` - endpoints, skills, transforms, mcp.json. A second
 * dot-directory would be a second convention for no gain, and the path is a
 * setting for anyone who disagrees.
 */

/**
 * Characters of instruction admitted into every request.
 *
 * Generous enough for a page of real conventions, small enough that a file
 * somebody pasted a dependency manifest into cannot quietly consume a 32k
 * window on every turn. Truncation is stated in-band rather than silent: a
 * model told that it is reading a fragment can ask for the rest, while one
 * handed a sentence that stops mid-word cannot know why.
 */
export const INSTRUCTIONS_CAP = 16_000;

export interface ProjectInstructions {
  /** The block as it enters the system prompt, heading and all. */
  block: string;
  /** Workspace-relative, for the log line and the Control Center. */
  path: string;
  /** Characters read from disk, before any cap. */
  size: number;
  truncated: boolean;
}

/**
 * Read the instructions file, or nothing at all.
 *
 * Absent is the overwhelmingly common case and is not a warning: most
 * workspaces have no such file and must not be nagged about it. Unreadable is
 * also silent here - the caller logs it - because a permissions error on an
 * optional file is not a reason to fail a turn.
 */
export function loadInstructions(
  root: string | undefined,
  rel: string
): ProjectInstructions | undefined {
  if (!root) return undefined;
  const clean = rel.trim();
  if (!clean) return undefined;

  const abs = path.isAbsolute(clean) ? clean : path.join(root, ...clean.split(/[\\/]/));
  let raw: string;
  try {
    if (!fs.statSync(abs).isFile()) return undefined;
    raw = fs.readFileSync(abs, "utf8");
  } catch {
    return undefined;
  }

  const text = raw.trim();
  if (!text) return undefined;

  const truncated = text.length > INSTRUCTIONS_CAP;
  const body = truncated
    ? text.slice(0, INSTRUCTIONS_CAP) +
      `\n\n[Truncated at ${INSTRUCTIONS_CAP} of ${text.length} characters.]`
    : text;

  // The heading names the file. A model that is told where a rule came from
  // can say "your instructions file says X" instead of asserting X as though
  // it were its own idea, and the user can go and change it.
  return {
    block:
      `Project instructions, from \`${clean}\` in this workspace. These are the ` +
      `user's standing directions for this project; follow them unless the user ` +
      `says otherwise in conversation.\n\n${body}`,
    path: clean,
    size: text.length,
    truncated,
  };
}
