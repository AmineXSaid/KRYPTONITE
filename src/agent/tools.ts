import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ToolDef } from "../providers/client";
import type { Skill } from "../skills/loader";
import { BROWSER_ACTIONS } from "../browser/actions";
import {
  searchUrl, parseResults, renderResults, looksLikeBotWall, botWallAdvice, SEARCH_URL,
} from "../browser/search";

const pexec = promisify(execFile);

// CHANGED: added. Mirrors the update_todos tool schema.
export type TodoStatus = "pending" | "in_progress" | "completed";
export interface TodoItem {
  content: string;
  status: TodoStatus;
}

/**
 * What one write did to a file, so the panel can say it while the turn runs.
 *
 * The authoritative numbers arrive at the end of the turn from the shadow
 * repository's `numstat`. These are what the tool itself knows at the moment
 * it writes, which is the only thing available in real time.
 */
export interface FileChange {
  change: "created" | "modified";
  added: number;
  removed: number;
}

/**
 * Added and removed line counts for a whole-file replacement.
 *
 * Common leading and trailing lines are trimmed and what is left is counted.
 * That is exact for a single contiguous edit - which is what `edit_file`
 * always produces - and an overestimate for scattered ones, where it reports
 * the span containing them rather than the lines inside it. A real LCS diff
 * would be exact and is not worth its cost here: git supplies exact numbers a
 * few seconds later, and the job of these is to be right immediately.
 */
export function lineStat(before: string, after: string): { added: number; removed: number } {
  if (before === after) return { added: 0, removed: 0 };
  const a = before.split("\n");
  const b = after.split("\n");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++;
  }
  return { removed: a.length - head - tail, added: b.length - head - tail };
}

/**
 * A unified patch for the change a tool is ASKING to make.
 *
 * The approval card showed `- old_text` and `+ new_text` as a plain monospace
 * blob, and for an overwrite it showed a truncated prefix of the NEW content
 * and none of the old - so "see exactly what will change" was not on screen at
 * the moment of the decision, in the mode that is the default. The panel has
 * had a full diff renderer since diff cards existed; it just had nothing to
 * render, because nothing produced a patch before the write.
 *
 * Same span rule as `lineStat` above, and the same trade for the same reason: a
 * real LCS diff would place several small hunks exactly, and git supplies that
 * a few seconds later on the diff card. What is needed HERE is a correct
 * picture of the change immediately, and prefix/suffix trimming gives exactly
 * that for the shape both writers actually produce - one contiguous
 * replacement, or a whole-file overwrite.
 */
export function unifiedPatch(before: string, after: string, rel: string, context = 3): string {
  if (before === after) return "";
  const a = before.split("\n");
  const b = after.split("\n");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++;
  }
  const from = Math.max(0, head - context);
  const aEnd = Math.min(a.length, a.length - tail + context);
  const bEnd = Math.min(b.length, b.length - tail + context);

  const lines: string[] = [];
  for (let i = from; i < head; i++) lines.push(" " + a[i]);
  for (let i = head; i < a.length - tail; i++) lines.push("-" + a[i]);
  for (let i = head; i < b.length - tail; i++) lines.push("+" + b[i]);
  for (let i = a.length - tail; i < aEnd; i++) lines.push(" " + a[i]);

  return (
    `--- a/${rel}\n+++ b/${rel}\n` +
    `@@ -${from + 1},${aEnd - from} +${from + 1},${bEnd - from} @@\n` +
    lines.join("\n")
  );
}

export interface ToolContext {
  root: string;
  /**
   * Aborted when the user stops the turn.
   *
   * Nothing here took a signal, so Stop reached the model request and stopped
   * there: a `run_command` already running carried on to its own timeout - up
   * to ten minutes - holding the loop inside `await invoke(call)` the whole
   * time. The install kept going, its output was thrown away, and it was still
   * holding the lockfile when the user retried.
   *
   * Optional, so every offline harness and every caller that predates it keeps
   * working; absent means "nothing will interrupt this".
   */
  signal?: AbortSignal;
  /**
   * Whether READS may leave the workspace root. Writes never may, whatever
   * this says. See `readable()` for what "may" costs.
   *
   * Optional, and absent means false, so every offline harness and every
   * caller that predates the flag keeps the old workspace-only behaviour
   * without being edited.
   */
  readOutsideWorkspace?: boolean;
  skills: Skill[];
  /**
   * Returns true if the user allows this side effect.
   *
   * `patch` is a unified diff of the change being asked about, when there is
   * one. The panel renders it through the same diff rows the after-the-fact
   * diff card uses, so approving an edit and reviewing one look alike - which
   * they should, being the same information at two moments.
   */
  approve: (summary: string, detail?: string, patch?: string) => Promise<boolean>;
  /**
   * A file on disk changed. `change` is absent only for callers that do not
   * track line counts, which is every offline harness and nothing in the
   * extension itself.
   */
  onFileTouched: (absPath: string, change?: FileChange) => void;
  // CHANGED: added. Receives the validated list from update_todos. Optional so
  // callers that do not render a todo card need no changes.
  onTodos?: (todos: TodoItem[]) => void;
  /**
   * MCP servers, when any are configured. Optional so every existing caller and
   * the offline test harness keep working with no MCP at all.
   *
   * Typed structurally rather than importing McpRegistry, to keep this module
   * free of the mcp/ dependency - tools.ts is the one file both the agent loop
   * and the harness import.
   */
  /**
   * Web search, through whichever provider is configured.
   *
   * Its own hook rather than a `fetchUrl` call, because a search API needs
   * headers - a key, an accept - and `fetchUrl` is a page reader that returns
   * rendered text. Returns the rendered results, already formatted for the
   * model. Absent in harnesses that have no network.
   */
  search?: (query: string, limit: number) => Promise<string>;
  mcp?: {
    has(name: string): boolean;
    needsApproval(name: string): boolean;
    /**
     * Whether the user declared this tool's server read-only in
     * `.agent/mcp.json`. The agent loop consults it to decide whether an MCP
     * tool may be offered outside Act. Nothing verifies the claim.
     */
    isReadOnly(name: string): boolean;
    /**
     * May answer with pixels as well as text, on the same terms as `browser`
     * above: only the caller knows whether the active endpoint declares vision,
     * so the caller decides, and this signature only has to admit the answer.
     */
    call(name: string, args: unknown): Promise<ToolResult>;
  };
  /**
   * Image generation, present only when the active profile declares one.
   *
   * Typed structurally for the same reason as `mcp` above: tools.ts is imported
   * by both the agent loop and the offline harness, and neither should be made
   * to drag in the provider client.
   */
  image?: {
    /** Model id, for the approval prompt and the result line. */
    model: string;
    generate(prompt: string, size?: string): Promise<{ bytes: Buffer; mime: string }>;
  };
  /** Told about a rendered image so the transcript can show it. */
  onImage?: (absPath: string, prompt: string) => void;
  /**
   * Read a page as text, on the active endpoint's transport.
   *
   * Structural again, so tools.ts pulls in no undici and the offline harness
   * can supply a stub. Absent means no network, and the tool says so.
   */
  fetchUrl?: (url: string, withLinks: boolean) => Promise<string>;
  /**
   * Drive a real browser. Absent when none is installed, which is what makes
   * the tool withhold itself rather than fail on every call.
   *
   * May answer with pixels as well as text. Whether it does is the caller's
   * decision, not this module's: only the caller knows whether the endpoint
   * declares vision, and a base64 PNG sent to a gateway without it is a 400
   * rather than a degraded answer.
   */
  browser?: (
    action: string,
    args: Record<string, unknown>
  ) => Promise<string | { text: string; images?: ToolImage[] }>;
}

/** An image a tool hands back to the model. `data` is base64, no data: prefix. */
export interface ToolImage {
  mediaType: string;
  data: string;
}

export interface ToolResult {
  content: string;
  isError?: boolean;
  /**
   * Pixels for the model, alongside `content` rather than instead of it.
   *
   * A tool result that carries these becomes a multi-part message on the wire.
   * Nothing here reaches the transcript - what the *user* sees is posted
   * separately, through `onImage`, because the two audiences want different
   * things: the user wants the picture in the log, the model wants it in the
   * context window, and neither should be inferred from the other.
   */
  images?: ToolImage[];
}

/**
 * Resolve a workspace-relative path, refusing anything that escapes the root.
 *
 * The prefix test this replaced was `abs.startsWith(root)`, which is a string
 * comparison pretending to be a path comparison: with a root of `/work/proj`,
 * the path `../proj-secrets/id_rsa` resolves to `/work/proj-secrets/id_rsa`,
 * which starts with `/work/proj` and was therefore admitted. Every tool routes
 * through here, so a sibling directory whose name merely began with the
 * workspace name was fully readable and writable. The boundary has to be a
 * separator, not a character offset.
 *
 * `realpathSync` closes the second half of the same hole: a symlink inside the
 * workspace pointing anywhere on disk passes a purely lexical check. It is
 * applied to the nearest existing ancestor so that creating a new file still
 * works, and falls back to the lexical result when nothing on the path exists
 * yet.
 */
/**
 * Is `child` inside `parent`?
 *
 * THE BOUNDARY HAS TO BE A SEPARATOR, AND ON WINDOWS IT ALSO HAS TO IGNORE
 * CASE.
 *
 * The separator half was fixed a while ago: `abs.startsWith(root)` is a string
 * comparison pretending to be a path comparison, and with a root of
 * `/work/proj` it admitted `/work/proj-secrets/id_rsa`.
 *
 * The case half was not. Windows paths are case-insensitive, and VS Code hands
 * back a drive letter whose case depends on how the folder was opened - so
 * `C:\Work\Proj` and `c:\work\proj\file.ts` are the same location and
 * different strings. Compared exactly, a file the user is looking at is judged
 * to be OUTSIDE the workspace: refused for writes, and for reads either
 * refused or, with `readOutsideWorkspace` on, sent down the wrong branch and
 * checked against the credential-store list instead of being admitted
 * outright. Nothing in the suite runs on Windows, so it held there.
 *
 * POSIX is left case-sensitive, because on POSIX two paths differing in case
 * genuinely are two different files and folding them would widen the boundary
 * rather than fix it.
 */
function contains(parent: string, child: string): boolean {
  const fold = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
  const a = fold(parent);
  const b = fold(child);
  return b === a || b.startsWith(a.endsWith(path.sep) ? a : a + path.sep);
}

function writable(root: string, p: string): string {
  const base = path.resolve(root);
  const abs = path.resolve(base, p ?? ".");
  if (!contains(base, abs)) throw new Error(`Path ${p} is outside the workspace.`);

  let probe = abs;
  for (;;) {
    try {
      const real = fs.realpathSync(probe);
      const realRoot = fs.realpathSync(base);
      // Re-attach the part that does not exist yet to the resolved ancestor.
      const tail = path.relative(probe, abs);
      const finalAbs = tail ? path.resolve(real, tail) : real;
      if (!contains(realRoot, finalAbs)) {
        throw new Error(`Path ${p} resolves outside the workspace.`);
      }
      return abs;
    } catch (e: any) {
      if (e?.code !== "ENOENT") throw e;
      const up = path.dirname(probe);
      if (up === probe) return abs; // nothing on the path exists; lexical check stands
      probe = up;
    }
  }
}

/**
 * Paths a read is refused even when reads may leave the workspace.
 *
 * Widening reads to the whole filesystem is what the user asked for, and the
 * reason they asked is real: a Python project's actual dependencies live in
 * site-packages, a Go project's in the module cache, and an agent that cannot
 * open them can only guess at what the code it is reading actually calls.
 *
 * But "read any file" and "read any file and put it in a prompt" are the same
 * capability here, because everything a tool returns goes to the endpoint. So
 * the places whose entire purpose is to hold a credential stay closed. This is
 * not a security boundary against a hostile model - a determined one has a
 * shell in Act mode - it is a guard against the ordinary accident: a model
 * grepping a home directory for "token" and finding one.
 *
 * Matched on path segments, so `~/.aws` is blocked and `~/project/.aws-notes`
 * is not.
 */
const SECRET_DIRS = new Set([
  ".ssh", ".aws", ".gnupg", ".gpg", ".docker", ".kube", ".azure", ".config/gcloud",
  ".netrc", ".password-store", "keychains", "credentials.d",
]);
const SECRET_FILES = new Set([
  ".netrc", ".npmrc", ".pypirc", ".git-credentials", ".htpasswd",
  "id_rsa", "id_ed25519", "id_ecdsa", "id_dsa", "credentials", "shadow",
]);

/**
 * Resolve a path for READING.
 *
 * Inside the workspace this is exactly `writable()`. Outside it, the read is
 * allowed when `readOutsideWorkspace` is on and the path is not a credential
 * store - and refused with a message that names the setting when it is off,
 * because "outside the workspace" on its own sent someone round a three-turn
 * loop asking the model to relocate itself.
 */
/**
 * Judge a workspace-relative path that an `@` mention wants to inline.
 *
 * This is a SEPARATE gate from `readable()` and deliberately stricter than it,
 * because an `@` mention is not a tool call. A tool call is announced, can be
 * refused, and is subject to the phase - Ask cannot write, permissions are
 * asked for, the transcript shows what was touched. An `@` mention takes the
 * file's contents and puts them in the prompt before the model has said
 * anything at all, with no card to approve and no line in the log. Whatever
 * `read_file` is allowed to do, a mention should be allowed to do less.
 *
 * So: inside the workspace only - the picker never offers anything else, and
 * `@../../etc/passwd` typed by hand is not a feature - and never a credential
 * store, which `readable()` permits inside the workspace on the grounds that a
 * tool call for one is visible and refusable. This one would not be.
 *
 * Returns the absolute path, or the reason it was refused. A path that simply
 * does not exist is neither: `@pytest.mark.parametrize` and an email address
 * are ordinary prose and the caller leaves them alone.
 */
export function mentionable(root: string, rel: string): { abs: string } | { refused: string } {
  const base = path.resolve(root);
  const abs = path.resolve(base, rel);
  if (!contains(base, abs)) return { refused: `${rel} is outside the workspace` };

  // Symlinks are resolved before judging, so a link named innocuously cannot
  // point at a key. A path that does not exist is judged lexically and will be
  // dropped by the caller's stat anyway.
  let real = abs;
  try { real = fs.realpathSync(abs); } catch { /* judge the lexical path */ }
  if (real !== abs && !contains(base, real)) {
    return { refused: `${rel} is a link out of the workspace` };
  }

  const segs = real.split(path.sep).filter(Boolean);
  const name = segs[segs.length - 1] ?? "";
  if (SECRET_FILES.has(name)) return { refused: `${rel} is a credential store` };
  for (let i = 0; i < segs.length; i++) {
    if (SECRET_DIRS.has(segs[i]) || SECRET_DIRS.has(segs.slice(i, i + 2).join("/"))) {
      return { refused: `${rel} is inside ${segs[i]}, a credential store` };
    }
  }
  return { abs: real };
}

function readable(ctx: { root: string; readOutsideWorkspace?: boolean }, p: string): string {
  const base = path.resolve(ctx.root);
  const abs = path.resolve(base, p ?? ".");
  if (contains(base, abs)) return writable(ctx.root, p);

  if (!ctx.readOutsideWorkspace) {
    throw new Error(
      `Path ${p} is outside the workspace, and reading outside it is turned off. ` +
      `Set "genesis.readOutsideWorkspace": true to allow it, or bring the file ` +
      `into the workspace. Writes stay inside the workspace either way.`
    );
  }

  // Resolve symlinks before judging the path, so a link named innocuously
  // cannot point at a key.
  let real = abs;
  try { real = fs.realpathSync(abs); } catch { /* may not exist; judge the lexical path */ }

  const segs = real.split(path.sep).filter(Boolean);
  const base_ = segs[segs.length - 1] ?? "";
  if (SECRET_FILES.has(base_)) {
    throw new Error(`Refusing to read ${p}: that filename is a credential store.`);
  }
  for (let i = 0; i < segs.length; i++) {
    if (SECRET_DIRS.has(segs[i]) || SECRET_DIRS.has(segs.slice(i, i + 2).join("/"))) {
      throw new Error(`Refusing to read ${p}: it is inside ${segs[i]}, a credential store.`);
    }
  }
  return real;
}

/**
 * How long a single `search` may spend before it gives up and says so.
 *
 * Generous, because a legitimate search of a large tree is worth waiting for,
 * and short enough that nobody concludes the editor has hung.
 */
const SEARCH_BUDGET_MS = 10_000;

/**
 * Is this pattern shaped like one that backtracks exponentially?
 *
 * Returns the reason it was refused, or undefined.
 *
 * The dangerous shape is a repetition wrapped around another repetition over
 * an overlapping character set - `(a+)+`, `(\s*\w+)+`, `(\w|\d)*$` - where
 * the engine has exponentially many ways to divide the same input between the
 * two. Against a non-matching line of a few hundred characters that is enough
 * to hang the process for longer than anyone will wait.
 *
 * This is a shape check, not a proof: it cannot catch every catastrophic
 * pattern and it will refuse a handful of harmless ones. That trade is right
 * here because the cost of a false positive is a rewritten pattern, and the
 * cost of a false negative is a frozen extension host - which takes every
 * other extension in the window with it, and takes Stop with it too, because
 * Stop is a message a frozen host cannot process.
 */
export function catastrophicShape(pattern: string): string | undefined {
  if (typeof pattern !== "string") return undefined;
  // A quantified group whose body itself contains an unbounded quantifier.
  // The body match is deliberately non-greedy and bounded so this check
  // cannot itself be the slow thing.
  if (/\((?![?]:)?[^()]{0,200}?[*+][^()]{0,200}?\)\s*[*+]/.test(pattern)) {
    return "it repeats a group that already repeats.";
  }
  if (/\((?![?]:)?[^()]{0,200}?[*+][^()]{0,200}?\)\s*\{\d+,\s*\}/.test(pattern)) {
    return "it repeats a group that already repeats.";
  }
  /* `(a|a)*`, `(a|ab)+`: a repeated alternation whose branches can match the
   * same text, so the engine has more than one way to divide the input.
   *
   * Branches that cannot overlap - `(foo|bar)+`, `(?:get|set)\s+\w+` - are
   * common and perfectly safe, so the test is whether two branches could start
   * with the same character rather than merely that an alternation is there. */
  const alt = /\((?:\?:)?([^()]{1,200})\)\s*[*+]/.exec(pattern);
  if (alt && alt[1].includes("|") && branchesOverlap(alt[1].split("|"))) {
    return "it repeats an alternation whose branches can match the same text.";
  }
  return undefined;
}

/**
 * Could two of these alternation branches begin with the same character?
 *
 * A class or escape (`\w`, `\d`, `.`, `[a-z]`) is treated as matching
 * anything, which is the conservative direction: it means `(\w|\d)+` is
 * flagged, and it is - `\d` is a subset of `\w`, so every digit run has
 * exponentially many splits.
 */
function branchesOverlap(branches: string[]): boolean {
  const firsts = branches.map((b) => {
    const t = b.replace(/^\^+/, "");
    if (!t) return "*";              // an empty branch matches everywhere
    if (t[0] === "\\" || t[0] === "[" || t[0] === ".") return "*";
    return t[0];
  });
  if (firsts.some((f) => f === "*")) return true;
  return new Set(firsts).size !== firsts.length;
}

/** Skip anything that is not plausibly text, so a search never scans a binary. */
const BINARY_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".pdf", ".zip", ".gz",
  ".tar", ".7z", ".rar", ".exe", ".dll", ".so", ".dylib", ".class", ".jar", ".wasm",
  ".woff", ".woff2", ".ttf", ".otf", ".eot", ".mp3", ".mp4", ".mov", ".avi", ".webm",
  ".vsix", ".pyc", ".node", ".bin", ".lock",
]);

/** Cheap NUL sniff for extensionless binaries the list above cannot catch. */
function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/**
 * Translate a glob to a RegExp.
 *
 * Supports `**` (any depth), `*` (within one segment), `?`, and `{a,b}`. The
 * old one-liner replaced every `*` with `.*`, so `*.ts` matched
 * `src/deep/x.ts` and `**` was indistinguishable from `*` - a filter that
 * silently matched more than it claimed.
 */
function globToRe(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**/` may match zero segments, so `**/*.ts` also matches `x.ts`.
        if (glob[i + 2] === "/") { re += "(?:[^/]*/)*"; i += 2; }
        else { re += ".*"; i += 1; }
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const close = glob.indexOf("}", i);
      if (close === -1) re += "\\{";
      else {
        re += "(?:" + glob.slice(i + 1, close).split(",").map(escapeRe).join("|") + ")";
        i = close;
      }
    } else re += escapeRe(c);
  }
  return new RegExp("^" + re + "$");
}
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A filename from a prompt: readable, bounded, and safe on every platform. */
function slug(s: string): string {
  const out = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
  return out || "image";
}

/** Local copy of the mime → extension map, so tools.ts imports no provider code. */
function extFor(mime: string): string {
  return (
    {
      "image/png": ".png",
      "image/jpeg": ".jpg",
      "image/webp": ".webp",
      "image/gif": ".gif",
      "image/svg+xml": ".svg",
    } as Record<string, string>
  )[mime] ?? ".bin";
}

export const TOOL_DEFS: ToolDef[] = [
  {
    name: "read_file",
    description: "Read a workspace file. Returns numbered lines.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative path." },
        start: { type: "number", description: "First line, 1-based." },
        end: { type: "number", description: "Last line." },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Create a file or replace its whole contents.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description:
      "Replace exact text in a file. The old text must appear exactly once unless " +
      "replace_all is set, which replaces every occurrence.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_text: { type: "string" },
        new_text: { type: "string" },
        replace_all: {
          type: "boolean",
          description: "Replace every occurrence instead of requiring exactly one.",
        },
      },
      required: ["path", "old_text", "new_text"],
    },
  },
  {
    name: "list_files",
    description: "List files under a directory, skipping ignored folders.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, depth: { type: "number" } },
      required: ["path"],
    },
  },
  {
    name: "glob",
    description:
      "Find files by path pattern, newest first. Supports ** for any depth, * within " +
      "a segment, ? for one character and {a,b} alternates. Use this to locate files " +
      "by name; use search to look inside them.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "e.g. src/**/*.ts or **/*.{js,ts}" },
        path: { type: "string", description: "Directory to search under. Defaults to the workspace root." },
        limit: { type: "number", description: "Maximum paths to return. Default 200." },
      },
      required: ["pattern"],
    },
  },
  {
    name: "search",
    description:
      "Search file contents with a regular expression. Returns matching lines by default; " +
      "set output_mode to files_with_matches for paths only or count for per-file totals.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regular expression." },
        path: { type: "string", description: "File or directory to search under. Defaults to the workspace root." },
        glob: { type: "string", description: "Filename filter, e.g. *.ts or src/**/*.{js,ts}" },
        output_mode: {
          type: "string",
          enum: ["content", "files_with_matches", "count"],
          description: "content (default) shows matching lines; the others summarise.",
        },
        case_insensitive: { type: "boolean", description: "Ignore case." },
        multiline: { type: "boolean", description: "Let the pattern span lines; . matches newline." },
        context_before: { type: "number", description: "Lines of context before each match." },
        context_after: { type: "number", description: "Lines of context after each match." },
        head_limit: { type: "number", description: "Cap results. Default 200." },
      },
      required: ["pattern"],
    },
  },
  {
    name: "run_command",
    description:
      "Run a shell command in the workspace root. Requires approval. " +
      "Never use it for commands that wait for input.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        reason: { type: "string" },
        timeout_ms: { type: "number", description: "Milliseconds before the command is killed. Default 120000, max 600000." },
      },
      required: ["command", "reason"],
    },
  },
  {
    name: "read_skill",
    description:
      "Load a skill's full instructions and the list of files bundled with it. " +
      "Call this before starting work whenever a skill from the Skills index matches the task, " +
      "and always when the user's message starts with /<skill-name>. Cheap and read-only.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Exact skill name from the Skills index." },
      },
      required: ["name"],
    },
  },
  {
    name: "browser",
    description:
      "Drive a real browser. Use this when a page needs JavaScript, a login, or a click " +
      "to reveal what you need - fetch_url only reads static HTML. Always `read` before " +
      "`click` or `type`: refs are assigned by each read and anything that navigated has " +
      "new ones. `read` gives you the text, the refs you act on, and a line for each " +
      "described picture in view; `screenshot` gives you the picture itself, and is the " +
      "only way to judge what neither can carry - a chart, a diagram, a layout, an " +
      "undescribed photograph, where something sits on the page. Read first and look when " +
      "it leaves you guessing, rather than on every step: a screenshot stays in the " +
      "context window for the rest of the conversation.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          // Generated from the implementation's own list rather than repeated.
          // Drift between the two is silent in both directions: an action here
          // with no branch there throws at the model, and a branch with no
          // entry here is a capability the model is never told it has.
          enum: [...BROWSER_ACTIONS],
          description:
            "open: go to a url. read: page text plus every clickable ref. " +
            "text: the article, without the navigation and without refs - use it when you " +
            "are reading rather than acting, since a long page's ref list is pure noise " +
            "if you are not going to click anything. find: the refs " +
            "matching a query, without re-reading the whole page. click/hover/type act on " +
            "a ref. set: choose a <select> option or toggle a checkbox, which typing " +
            "cannot do. key: press Enter, Escape, Tab, an arrow - wherever focus is. " +
            "scroll: move the viewport. screenshot: see it. eval: run JavaScript and get " +
            "the value back. console: what the page logged and threw. network: the " +
            "requests it made, with statuses. wait: block until text or a selector " +
            "appears, or the network goes quiet. resize: change the viewport, and " +
            "optionally ask for the dark theme. back/forward: history. close when done.",
        },
        url: { type: "string", description: "For open." },
        ref: { type: "string", description: "For click, hover, type and set, from the last read." },
        text: { type: "string", description: "For type, set (the value), find (the query), and wait." },
        submit: { type: "boolean", description: "For type: press Enter afterwards." },
        clear: { type: "boolean", description: "For type: empty the field first." },
        dy: { type: "number", description: "For scroll: pixels, negative to go up." },
        key: { type: "string", description: "For key: enter, escape, tab, arrowdown, …" },
        expression: { type: "string", description: "For eval: JavaScript evaluated in the page." },
        selector: { type: "string", description: "For wait: a CSS selector to wait for." },
        errorsOnly: { type: "boolean", description: "For console and network: only failures." },
        width: { type: "number", description: "For resize." },
        height: { type: "number", description: "For resize." },
        scheme: {
          type: "string",
          enum: ["light", "dark"],
          description: "For resize: which colour scheme to claim.",
        },
      },
      required: ["action"],
    },
  },
  {
    name: "fetch_url",
    description:
      "Read a web page as text. Goes out on the active endpoint's connection, so it " +
      "reaches whatever that endpoint reaches - including behind a corporate proxy or " +
      "a private CA. Use it for documentation, an API reference, or a link the user gave you.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "http(s) address." },
        links: { type: "boolean", description: "Also list the page's links. Off by default; they are noisy." },
      },
      required: ["url"],
    },
  },
  {
    name: "web_search",
    description:
      "Search the web and get back titles, addresses and snippets. Use this whenever " +
      "you need to find something rather than read a page you already have the address " +
      "for - it is the only thing here that works for search. Do NOT drive the browser " +
      "at google.com, bing.com or duckduckgo.com: a search page served to an automated " +
      "browser is a bot check, not results. This goes out over HTTP on the active " +
      "endpoint's connection, so it reaches whatever that endpoint reaches, and it is " +
      "not subject to that check. Follow up with browser open or fetch_url on a result.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to search for, in plain words." },
        limit: { type: "number", description: "How many results to return. Default 8, max 20." },
      },
      required: ["query"],
    },
  },
  {
    name: "generate_image",
    description:
      "Draw an image from a text description and save it into the workspace. " +
      "Use this whenever the user asks for a picture, illustration, diagram or logo. " +
      "Do not write a script to draw one instead - this calls a real image model.",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description:
            "What to draw, described in full. Include subject, style, composition and " +
            "lighting; the image model sees only this string and none of the conversation.",
        },
        path: {
          type: "string",
          description:
            "Workspace-relative file to write. The extension is corrected to match the " +
            "bytes actually returned. Defaults to images/<slug>.png",
        },
        size: { type: "string", description: "e.g. 1024x1024. Falls back to the profile's default." },
      },
      required: ["prompt"],
    },
  },
  // CHANGED: added. The todo card's only data source.
  {
    name: "update_todos",
    description: "Replace the current task list. Use it to track multi-step work.",
    parameters: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          items: {
            type: "object",
            properties: {
              content: { type: "string" },
              status: { type: "string", enum: ["pending", "in_progress", "completed"] },
            },
            required: ["content", "status"],
          },
        },
      },
      required: ["todos"],
    },
  },
];

const IGNORED = new Set(["node_modules", ".git", "dist", "out", "build", ".venv", "__pycache__"]);

/**
 * Walk the workspace, yielding files.
 *
 * Both list_files and search previously skipped every entry whose name began
 * with a dot, which hid `.agent/` - the extension's own configuration folder,
 * where profiles, skills and mcp.json live. The agent could not read the
 * settings it was being asked about. Only the IGNORED set is skipped now, and
 * dot-entries are visible; `.git` stays out because it is in that set.
 */
function walkFiles(
  root: string,
  from: string,
  onFile: (abs: string, rel: string, ent: fs.Dirent) => boolean | void,
  maxDepth = Infinity
): void {
  const stack: Array<[string, number]> = [[from, 0]];
  while (stack.length) {
    const [dir, depth] = stack.pop()!;
    if (depth > maxDepth) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable directory is not a reason to abort the whole walk
    }
    for (const e of entries) {
      if (IGNORED.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      const rel = path.relative(root, abs).split(path.sep).join("/");
      if (e.isDirectory()) {
        stack.push([abs, depth + 1]);
        if (onFile(abs, rel + "/", e) === false) return;
      } else if (onFile(abs, rel, e) === false) return;
    }
  }
}

// CHANGED: added. Models get the schema wrong often enough that the card would
// otherwise render blank rows or an unbounded list. Coerce rather than reject:
// a slightly wrong todo list is still useful, a hard failure is not.
const VALID_STATUS: TodoStatus[] = ["pending", "in_progress", "completed"];
function normaliseTodos(raw: unknown): TodoItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, 20)
    .map((item) => {
      const obj = (item ?? {}) as Record<string, unknown>;
      const content = String(obj.content ?? "").slice(0, 200);
      const status = obj.status as TodoStatus;
      return {
        content,
        status: VALID_STATUS.includes(status) ? status : "pending",
      };
    })
    .filter((t) => t.content.length > 0);
}

export async function runTool(name: string, args: any, ctx: ToolContext): Promise<ToolResult> {
  try {
    // MCP tools are namespaced (`mcp__<server>__<tool>`) so they can never
    // collide with a built-in, and are dispatched before the switch. A server
    // set to approval: ask goes through the same gate as a shell command -
    // an MCP tool is a side effect in a process this extension started, and
    // "someone else wrote the server" is not a reason to trust it more.
    if (ctx.mcp?.has(name)) {
      if (ctx.mcp.needsApproval(name)) {
        const preview = JSON.stringify(args ?? {});
        const ok = await ctx.approve(
          `Call MCP tool ${name}`,
          preview.length > 2000 ? preview.slice(0, 2000) + "…" : preview
        );
        if (!ok) return { content: "The user declined this MCP tool call.", isError: true };
      }
      return ctx.mcp.call(name, args);
    }

    switch (name) {
      case "read_file": {
        const abs = readable(ctx, args.path);
        const st = fs.statSync(abs);
        if (st.isDirectory()) {
          return { content: `${args.path} is a directory. Use list_files or glob.`, isError: true };
        }
        const raw = fs.readFileSync(abs);
        if (looksBinary(raw)) {
          return { content: `${args.path} is a binary file (${st.size} bytes).`, isError: true };
        }
        const lines = raw.toString("utf8").split("\n");
        const start = Math.max(1, args.start ?? 1);
        const asked = args.end ?? lines.length;
        // Asking for a 5,000-line file used to be an error telling the model to
        // try again smaller, which costs a whole round trip to learn something
        // the tool already knew. Serve the first window and say what was left.
        const CAP = 2000;
        const end = Math.min(lines.length, asked, start + CAP - 1);
        const body = lines
          .slice(start - 1, end)
          .map((l, i) => `${start + i}\t${l}`)
          .join("\n");
        const more =
          end < Math.min(lines.length, asked)
            ? `\n\n[${lines.length} lines total; showing ${start}-${end}. ` +
              `Call read_file again with start: ${end + 1}.]`
            : "";
        return { content: body + more };
      }

      case "write_file": {
        const abs = writable(ctx.root, args.path);
        const existed = fs.existsSync(abs);
        /* READ BEFORE ASKING, WHICH REVERSES A DELIBERATE CHOICE HERE.
         *
         * This read used to sit AFTER the approval, and the comment defending
         * it said: "an overwrite has to be measured against what it replaced,
         * and there is nothing to measure if the user says no." That is the
         * right rule for the line COUNTS, which are only reported after a write
         * happens - and it is exactly backwards for the question being asked,
         * because what the user is being asked to approve IS the difference,
         * and it cannot be shown without reading the file first.
         *
         * The cost of the reversal is one read of a file the user may decline.
         * That has no side effect, and the card it pays for is the only place
         * an overwrite is reviewable: before this, approving one showed a
         * truncated prefix of the new content and never a line of the old. */
        let before = "";
        if (existed) {
          try {
            before = fs.readFileSync(abs, "utf8");
          } catch {
            // Unreadable (binary, permissions). The write still stands; the
            // card falls back to showing the new content, as it always did.
          }
        }
        const ok = await ctx.approve(
          `${existed ? "Overwrite" : "Create"} ${args.path}`,
          args.content.slice(0, 2000),
          existed && before ? unifiedPatch(before, args.content, args.path) : undefined
        );
        if (!ok) return { content: "The user declined this edit.", isError: true };
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, args.content, "utf8");
        ctx.onFileTouched(
          abs,
          existed
            ? { change: "modified", ...lineStat(before, args.content) }
            : { change: "created", added: args.content.split("\n").length, removed: 0 }
        );
        return { content: `Wrote ${args.content.split("\n").length} lines to ${args.path}.` };
      }

      case "edit_file": {
        const abs = writable(ctx.root, args.path);
        if (!fs.existsSync(abs)) return { content: `${args.path} does not exist.`, isError: true };
        const before = fs.readFileSync(abs, "utf8");
        // An empty needle "appears" between every character; split would report
        // a match on every file and the replace would corrupt it.
        if (typeof args.old_text !== "string" || args.old_text === "") {
          return { content: "old_text must be a non-empty string.", isError: true };
        }
        if (args.old_text === args.new_text) {
          return { content: "old_text and new_text are identical; nothing to do.", isError: true };
        }
        const count = before.split(args.old_text).length - 1;
        if (count === 0) {
          return { content: `That exact text is not in ${args.path}. Read the file again.`, isError: true };
        }
        const all = args.replace_all === true;
        if (count > 1 && !all) {
          return {
            content:
              `That text appears ${count} times in ${args.path}. Include more surrounding ` +
              `context, or set replace_all to change every occurrence.`,
            isError: true,
          };
        }
        // Computed before the question so the card can show it, and reused for
        // the write below rather than recomputed.
        const after = all
          ? before.split(args.old_text).join(args.new_text)
          : before.replace(args.old_text, args.new_text);
        const ok = await ctx.approve(
          `Edit ${args.path}${all && count > 1 ? ` (${count} occurrences)` : ""}`,
          `- ${args.old_text}\n+ ${args.new_text}`,
          unifiedPatch(before, after, args.path)
        );
        if (!ok) return { content: "The user declined this edit.", isError: true };
        fs.writeFileSync(abs, after, "utf8");
        ctx.onFileTouched(abs, { change: "modified", ...lineStat(before, after) });
        return { content: `Edited ${args.path}${all && count > 1 ? ` (${count} occurrences).` : "."}` };
      }

      case "list_files": {
        const abs = readable(ctx, args.path ?? ".");
        const out: string[] = [];
        walkFiles(
          ctx.root,
          abs,
          (_a, rel) => {
            out.push(rel);
            return out.length < 500;
          },
          args.depth ?? 2
        );
        out.sort();
        return { content: out.join("\n") || "(empty)" };
      }

      case "glob": {
        if (typeof args.pattern !== "string" || !args.pattern) {
          return { content: "pattern is required.", isError: true };
        }
        const from = readable(ctx, args.path ?? ".");
        const re = globToRe(args.pattern);
        // Patterns are written either against the workspace root ("src/**/*.ts")
        // or as a bare filename ("*.ts"); accept both rather than making the
        // model guess which one this tool wants.
        const bare = !args.pattern.includes("/");
        const found: Array<{ rel: string; mtime: number }> = [];
        walkFiles(ctx.root, from, (abs, rel, ent) => {
          if (ent.isDirectory()) return;
          const name = rel.slice(rel.lastIndexOf("/") + 1);
          if (!re.test(bare ? name : rel)) return;
          let mtime = 0;
          try { mtime = fs.statSync(abs).mtimeMs; } catch { /* raced deletion */ }
          found.push({ rel, mtime });
        });
        // Newest first: when a pattern matches many files, the ones just touched
        // are nearly always the ones being asked about.
        found.sort((a, b) => b.mtime - a.mtime);
        const lim = Math.max(1, Math.min(args.limit ?? 200, 1000));
        const shown = found.slice(0, lim);
        if (!shown.length) return { content: `No files match ${args.pattern}.` };
        return {
          content:
            shown.map((f) => f.rel).join("\n") +
            (found.length > lim ? `\n\n[${found.length} matches; showing ${lim}.]` : ""),
        };
      }

      case "search": {
        let re: RegExp;
        try {
          let flags = "g";
          if (args.case_insensitive) flags += "i";
          if (args.multiline) flags += "s";
          /* A PATTERN THE MODEL WROTE, RUN ON THE EXTENSION HOST THREAD.
           *
           * `re.exec` is synchronous and uncancellable, and JavaScript's
           * engine backtracks: a pattern like `(\s*\w+)+$` against a long line
           * takes exponential time. Nothing here could stop it, so the host
           * froze - taking every other extension in the window with it, and
           * taking Stop with it too, because Stop is a message a frozen host
           * cannot process.
           *
           * Node has no regex timeout, so the shape is rejected before it
           * runs. This is a guard against the accident, which is what actually
           * happens: a model reaching for a "words" pattern and writing a
           * nested quantifier. */
          const risk = catastrophicShape(args.pattern);
          if (risk) {
            return {
              content:
                `That pattern is refused: ${risk} Patterns of this shape can take exponential ` +
                `time on an ordinary file, and the search runs in the editor's own process. ` +
                `Rewrite it without the nested repetition - "(\\s*\\w+)+" is almost always ` +
                `meant as "[\\s\\w]+".`,
              isError: true,
            };
          }
          re = new RegExp(args.pattern, flags);
        } catch (e: any) {
          return { content: `Invalid pattern: ${e.message}`, isError: true };
        }
        /* And a wall-clock budget for everything else. A pattern that is not
         * catastrophic can still be slow across a large tree, and a search
         * that returns "I looked at 8,000 files and ran out of time" is worth
         * far more than one that never returns. */
        const deadline = Date.now() + SEARCH_BUDGET_MS;
        let outOfTime = false;

        const from = readable(ctx, args.path ?? ".");
        const globRe = args.glob ? globToRe(args.glob) : undefined;
        const globBare = args.glob ? !args.glob.includes("/") : false;
        const mode = args.output_mode ?? "content";
        const limit = Math.max(1, Math.min(args.head_limit ?? 200, 2000));
        const before = Math.max(0, Math.min(args.context_before ?? 0, 20));
        const after = Math.max(0, Math.min(args.context_after ?? 0, 20));

        const lines: string[] = [];
        const files: string[] = [];
        const counts: Array<[string, number]> = [];
        let truncated = false;

        const scan = (abs: string, rel: string) => {
          // Checked per file rather than per match: a single `exec` cannot be
          // interrupted, so this bounds how many of them are started.
          if (Date.now() > deadline) { outOfTime = true; return; }
          if (BINARY_EXT.has(path.extname(abs).toLowerCase())) return;
          let buf: Buffer;
          try { buf = fs.readFileSync(abs); } catch { return; }
          if (looksBinary(buf)) return;
          const text = buf.toString("utf8");

          if (args.multiline) {
            re.lastIndex = 0;
            const hit = re.test(text);
            if (!hit) return;
            files.push(rel);
            if (mode === "content") {
              re.lastIndex = 0;
              let m: RegExpExecArray | null;
              let n = 0;
              while ((m = re.exec(text)) && lines.length < limit) {
                const ln = text.slice(0, m.index).split("\n").length;
                lines.push(`${rel}:${ln}: ${m[0].replace(/\n/g, "\\n").slice(0, 300)}`);
                n++;
                if (m.index === re.lastIndex) re.lastIndex++;
              }
              counts.push([rel, n]);
            } else if (mode === "count") {
              re.lastIndex = 0;
              let n = 0;
              while (re.exec(text)) { n++; if (re.lastIndex === 0) break; }
              counts.push([rel, n]);
            }
            return;
          }

          const rows = text.split("\n");
          let n = 0;
          for (let i = 0; i < rows.length; i++) {
            re.lastIndex = 0;
            if (!re.test(rows[i])) continue;
            n++;
            if (mode === "content" && lines.length < limit) {
              for (let b = Math.max(0, i - before); b < i; b++) {
                lines.push(`${rel}-${b + 1}- ${rows[b].slice(0, 300)}`);
              }
              lines.push(`${rel}:${i + 1}: ${rows[i].trim().slice(0, 300)}`);
              for (let a = i + 1; a <= Math.min(rows.length - 1, i + after); a++) {
                lines.push(`${rel}-${a + 1}- ${rows[a].slice(0, 300)}`);
              }
            } else if (mode === "content") {
              truncated = true;
            }
          }
          if (n) {
            files.push(rel);
            counts.push([rel, n]);
          }
        };

        // A path pointing at a single file searches just that file.
        let st: fs.Stats | undefined;
        try { st = fs.statSync(from); } catch { /* handled below */ }
        if (!st) return { content: `${args.path} does not exist.`, isError: true };

        if (st.isFile()) {
          scan(from, path.relative(ctx.root, from).split(path.sep).join("/"));
        } else {
          walkFiles(ctx.root, from, (abs, rel, ent) => {
            if (ent.isDirectory()) return;
            if (globRe) {
              const name = rel.slice(rel.lastIndexOf("/") + 1);
              if (!globRe.test(globBare ? name : rel)) return;
            }
            scan(abs, rel);
            if (outOfTime) return false;
            return files.length < limit || mode === "content";
          });
        }

        const timeNote = outOfTime
          ? `\n\n[Stopped after ${Math.round(SEARCH_BUDGET_MS / 1000)}s; not every file was ` +
            `searched. Narrow the pattern or pass a glob.]`
          : "";

        if (mode === "files_with_matches") {
          const shown = files.slice(0, limit);
          return {
            content: (shown.join("\n") ||
              "No matches.") + (files.length > limit ? `\n\n[${files.length} files; showing ${limit}.]` : "") + timeNote,
          };
        }
        if (mode === "count") {
          if (!counts.length) return { content: "No matches." + timeNote };
          const total = counts.reduce((s, c) => s + c[1], 0);
          return {
            content:
              counts.slice(0, limit).map(([f, c]) => `${c}\t${f}`).join("\n") +
              `\n\n[${total} matches across ${counts.length} file(s).]` + timeNote,
          };
        }
        if (!lines.length) return { content: "No matches." + timeNote };
        return {
          content:
            lines.join("\n") +
            (truncated || lines.length >= limit
              ? `\n\n[Truncated at ${limit} lines. Narrow the pattern, pass a glob, or raise head_limit.]`
              : "") + timeNote,
        };
      }

      case "run_command": {
        if (typeof args.command !== "string" || !args.command.trim()) {
          return { content: "command is required.", isError: true };
        }
        const ok = await ctx.approve(`Run: ${args.command}`, args.reason);
        if (!ok) return { content: "The user declined to run that command.", isError: true };
        const timeout = Math.max(1_000, Math.min(args.timeout_ms ?? 120_000, 600_000));
        const MAX_BUFFER = 4 * 1024 * 1024;
        try {
          const { stdout, stderr } = await pexec(args.command, {
            cwd: ctx.root,
            shell: true,
            timeout,
            maxBuffer: MAX_BUFFER,
            // Stop now actually stops the process, rather than releasing the
            // composer and leaving it running for another nine minutes.
            signal: ctx.signal,
            killSignal: "SIGTERM",
          } as any);
          return { content: (stdout + (stderr ? "\n" + stderr : "")).slice(0, 30_000) || "(no output)" };
        } catch (e: any) {
          const partial = `${(e.stdout ?? "") + (e.stderr ?? "")}`.slice(0, 30_000);
          // The user pressed Stop. Said as its own outcome so the model does
          // not read it as the command having failed on its own merits and
          // helpfully try again.
          if (ctx.signal?.aborted || e?.name === "AbortError") {
            return {
              content: `The user stopped this command before it finished.\n${partial}`,
              isError: true,
            };
          }
          /* THREE WAYS A CHILD DIES, AND THEY USED TO READ AS ONE.
           *
           * Node sets `killed: true` when `maxBuffer` is exceeded as well as
           * when the timeout fires, so a verbose build producing more than
           * 4 MB was reported to both the model and the user as "Command timed
           * out after 120000ms and was killed" - which sent both of them off
           * to raise a timeout that had nothing to do with it. */
          if (e?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
            return {
              content:
                `The command produced more than ${Math.round(MAX_BUFFER / 1024 / 1024)} MB of ` +
                `output and was killed. It did not time out. Re-run it writing to a file, or ` +
                `narrow what it prints.\n${partial}`,
              isError: true,
            };
          }
          // A timeout kill arrives as a signal with no exit code, and reporting
          // it as "Exit undefined" tells the model nothing it can act on.
          if (e?.killed || e?.signal) {
            return {
              content: `Command timed out after ${timeout}ms and was killed.\n${partial}`,
              isError: true,
            };
          }
          return {
            content: `Exit ${e.code}\n${partial}`,
            isError: true,
          };
        }
      }

      case "read_skill": {
        const skill = ctx.skills.find((s) => s.name === args.name);
        if (!skill) {
          return {
            content: `No skill named "${args.name}". Available: ${ctx.skills.map((s) => s.name).join(", ") || "none"}.`,
            isError: true,
          };
        }
        // The folder path is workspace-relative so the model can hand it
        // straight to read_file without guessing at the layout.
        const rel = path.relative(ctx.root, skill.dir).split(path.sep).join("/");

        // Bounded. The bundled `claude-api` SKILL.md is 72,000 characters -
        // roughly 20k tokens - and returning it whole did two kinds of damage:
        // it consumed most of a small model's context in one tool call, and it
        // put a wall of documentation in the transcript. The loader already
        // warns when a SKILL.md is this large; handing it over intact anyway
        // made the warning pointless.
        //
        // The head of a SKILL.md is its routing section, which is the part that
        // tells the model where to go next. That is what is worth spending
        // context on; the rest is reachable with read_file, and the truncation
        // says so in-band so the model knows there is more.
        const CAP = 12_000;
        const truncated = skill.body.length > CAP;
        const body = truncated ? skill.body.slice(0, CAP) : skill.body;
        const cut = truncated
          ? `\n\n---\n[Truncated: showing the first ${CAP.toLocaleString()} of ` +
            `${skill.body.length.toLocaleString()} characters. Read ` +
            `\`${rel}/SKILL.md\` with read_file for a specific later section.]`
          : "";

        const extras = skill.files.length
          ? `\n\n---\nBundled files, relative to \`${rel}/\`. Read one with read_file only if the ` +
            `instructions above send you to it:\n` +
            skill.files.map((f) => `- ${rel}/${f}`).join("\n")
          : "";
        return { content: body + cut + extras };
      }

      case "browser": {
        if (!ctx.browser) {
          return {
            content:
              "No browser is available. Genesis drives the Chrome or Edge already " +
              "installed on this machine; none was found. Use fetch_url for static pages.",
            isError: true,
          };
        }
        const action = String(args?.action ?? "").trim();
        if (!action) return { content: "action is required.", isError: true };

        // Opening a page and acting on one are different risks. Reading what is
        // already on screen is not a side effect and would be approval fatigue;
        // navigating somewhere new, clicking, and typing all are.
        const gated: Record<string, string | undefined> = {
          open: `Open ${args?.url ?? ""} in the browser`,
          click: `Click ${args?.ref ?? ""} in the browser`,
          type: `Type into ${args?.ref ?? ""}: ${String(args?.text ?? "").slice(0, 80)}`,
          // Setting a control and pressing a key are side effects on the page
          // in exactly the way clicking is; reading is not, and hovering only
          // reveals what a mouse passing over would.
          set: `Set ${args?.ref ?? ""} to: ${String(args?.text ?? "").slice(0, 80)}`,
          key: `Press ${String(args?.key ?? "")} in the browser`,
          // Arbitrary script in the page can do anything a click can and more,
          // so it is gated even though it is often only a read.
          eval: `Run JavaScript in the page: ${String(args?.expression ?? "").slice(0, 120)}`,
        };
        if (gated[action]) {
          const ok = await ctx.approve(gated[action]!, "The browser is driven by the model.");
          if (!ok) return { content: "The user declined that browser action.", isError: true };
        }

        try {
          const out = await ctx.browser(action, args ?? {});
          return typeof out === "string"
            ? { content: out }
            : { content: out.text, images: out.images };
        } catch (e: any) {
          return { content: `browser ${action}: ${e?.message ?? e}`, isError: true };
        }
      }

      case "web_search": {
        if (!ctx.search) {
          return { content: "Searching is not available in this context.", isError: true };
        }
        const query = String(args?.query ?? "").trim();
        if (!query) return { content: "query is required.", isError: true };
        const limit = Math.min(20, Math.max(1, Number(args?.limit ?? 8) || 8));

        // The same gate as fetch_url: it reaches the network, and the query
        // came from the model rather than from the user.
        const ok = await ctx.approve(
          `Search the web for ${JSON.stringify(query)}`,
          "Queries the configured search provider over HTTP on the active endpoint's connection."
        );
        if (!ok) return { content: "The user declined that search.", isError: true };

        try {
          return { content: await ctx.search(query, limit) };
        } catch (e: any) {
          return { content: `The search failed: ${String(e?.message ?? e)}`, isError: true };
        }
      }

      case "fetch_url": {
        if (!ctx.fetchUrl) {
          return { content: "Fetching pages is not available in this context.", isError: true };
        }
        const raw = String(args?.url ?? "").trim();
        if (!raw) return { content: "url is required.", isError: true };
        // Reaching the network is a side effect, and the address comes from the
        // model rather than the user, so it goes through the same gate as a
        // shell command. The full URL is shown because that is the thing being
        // approved.
        const ok = await ctx.approve(`Fetch ${raw}`, "Reads the page as text. No cookies are sent.");
        if (!ok) return { content: "The user declined that fetch.", isError: true };
        try {
          const p = await ctx.fetchUrl(raw, args?.links === true);
          return { content: p };
        } catch (e: any) {
          return { content: `Could not fetch ${raw}: ${e?.message ?? e}`, isError: true };
        }
      }

      case "generate_image": {
        if (!ctx.image) {
          return {
            content:
              "This endpoint profile has no image model. Add an `image:` block with a " +
              "`model:` to the profile YAML, then try again. Do not attempt to draw the " +
              "image with a script instead - say that image generation is not configured.",
            isError: true,
          };
        }
        const prompt = String(args?.prompt ?? "").trim();
        if (!prompt) return { content: "prompt is required.", isError: true };

        // Chosen before the request so the approval names a real destination.
        const wanted = typeof args?.path === "string" && args.path.trim()
          ? args.path.trim()
          : "images/" + slug(prompt) + ".png";

        const ok = await ctx.approve(
          `Generate an image with ${ctx.image.model}`,
          `${prompt}\n\n→ ${wanted}`
        );
        if (!ok) return { content: "The user declined image generation.", isError: true };

        let out: { bytes: Buffer; mime: string };
        try {
          out = await ctx.image.generate(prompt, typeof args?.size === "string" ? args.size : undefined);
        } catch (e: any) {
          return { content: `Image generation failed: ${e?.message ?? e}`, isError: true };
        }
        if (!out.bytes.length) return { content: "The image model returned no data.", isError: true };
        if (out.mime === "application/octet-stream") {
          return {
            content: "The endpoint returned data that is not a recognised image format.",
            isError: true,
          };
        }

        // The extension follows the bytes, not the request: asking for .png and
        // being handed JPEG is common, and a mislabelled file fails to render
        // later in a way that looks like the generation failed.
        const want = extFor(out.mime);
        const rel = wanted.replace(/\.[A-Za-z0-9]+$/, "") + want;
        const abs = writable(ctx.root, rel);
        const replaced = fs.existsSync(abs);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, out.bytes);
        // Lines are meaningless for a PNG, so the counts stay at zero and the
        // panel shows the file without a diff stat beside it.
        ctx.onFileTouched(abs, { change: replaced ? "modified" : "created", added: 0, removed: 0 });
        ctx.onImage?.(abs, prompt);

        const kb = Math.max(1, Math.round(out.bytes.length / 1024));
        return {
          content:
            `Saved ${rel} (${out.mime}, ${kb} KB). It is already shown to the user - ` +
            `describe it briefly rather than restating the prompt, and do not offer to ` +
            `generate it again unless asked.`,
        };
      }

      // CHANGED: added. No approval gate - this touches no files and runs no
      // commands, so prompting for it would train the user to click through.
      case "update_todos": {
        const todos = normaliseTodos(args?.todos);
        ctx.onTodos?.(todos);
        return { content: `Todo list updated (${todos.length} items).` };
      }

      default:
        return { content: `Unknown tool "${name}".`, isError: true };
    }
  } catch (e: any) {
    return { content: e.message, isError: true };
  }
}
