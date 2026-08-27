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

export interface ToolContext {
  root: string;
  skills: Skill[];
  /** Returns true if the user allows this side effect. */
  approve: (summary: string, detail?: string) => Promise<boolean>;
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
    call(name: string, args: unknown): Promise<{ content: string; isError?: boolean }>;
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
function inside(root: string, p: string): string {
  const base = path.resolve(root);
  const abs = path.resolve(base, p ?? ".");
  const contains = (parent: string, child: string) =>
    child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);

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
        const abs = inside(ctx.root, args.path);
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
        const abs = inside(ctx.root, args.path);
        const existed = fs.existsSync(abs);
        const ok = await ctx.approve(
          `${existed ? "Overwrite" : "Create"} ${args.path}`,
          args.content.slice(0, 2000)
        );
        if (!ok) return { content: "The user declined this edit.", isError: true };
        // Read before the write, and only once approval is in: an overwrite has
        // to be measured against what it replaced, and there is nothing to
        // measure if the user says no.
        let before = "";
        if (existed) {
          try {
            before = fs.readFileSync(abs, "utf8");
          } catch {
            // Unreadable (binary, permissions) - the write still stands, only
            // the line counts are unavailable.
          }
        }
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
        const abs = inside(ctx.root, args.path);
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
        const ok = await ctx.approve(
          `Edit ${args.path}${all && count > 1 ? ` (${count} occurrences)` : ""}`,
          `- ${args.old_text}\n+ ${args.new_text}`
        );
        if (!ok) return { content: "The user declined this edit.", isError: true };
        const after = all
          ? before.split(args.old_text).join(args.new_text)
          : before.replace(args.old_text, args.new_text);
        fs.writeFileSync(abs, after, "utf8");
        ctx.onFileTouched(abs, { change: "modified", ...lineStat(before, after) });
        return { content: `Edited ${args.path}${all && count > 1 ? ` (${count} occurrences).` : "."}` };
      }

      case "list_files": {
        const abs = inside(ctx.root, args.path ?? ".");
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
        const from = inside(ctx.root, args.path ?? ".");
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
          re = new RegExp(args.pattern, flags);
        } catch (e: any) {
          return { content: `Invalid pattern: ${e.message}`, isError: true };
        }

        const from = inside(ctx.root, args.path ?? ".");
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
            return files.length < limit || mode === "content";
          });
        }

        if (mode === "files_with_matches") {
          const shown = files.slice(0, limit);
          return {
            content: shown.join("\n") ||
              "No matches." + (files.length > limit ? `\n\n[${files.length} files; showing ${limit}.]` : ""),
          };
        }
        if (mode === "count") {
          if (!counts.length) return { content: "No matches." };
          const total = counts.reduce((s, c) => s + c[1], 0);
          return {
            content:
              counts.slice(0, limit).map(([f, c]) => `${c}\t${f}`).join("\n") +
              `\n\n[${total} matches across ${counts.length} file(s).]`,
          };
        }
        if (!lines.length) return { content: "No matches." };
        return {
          content:
            lines.join("\n") +
            (truncated || lines.length >= limit
              ? `\n\n[Truncated at ${limit} lines. Narrow the pattern, pass a glob, or raise head_limit.]`
              : ""),
        };
      }

      case "run_command": {
        if (typeof args.command !== "string" || !args.command.trim()) {
          return { content: "command is required.", isError: true };
        }
        const ok = await ctx.approve(`Run: ${args.command}`, args.reason);
        if (!ok) return { content: "The user declined to run that command.", isError: true };
        const timeout = Math.max(1_000, Math.min(args.timeout_ms ?? 120_000, 600_000));
        try {
          const { stdout, stderr } = await pexec(args.command, {
            cwd: ctx.root,
            shell: true,
            timeout,
            maxBuffer: 4 * 1024 * 1024,
          } as any);
          return { content: (stdout + (stderr ? "\n" + stderr : "")).slice(0, 30_000) || "(no output)" };
        } catch (e: any) {
          // A timeout kill arrives as a signal with no exit code, and reporting
          // it as "Exit undefined" tells the model nothing it can act on.
          if (e?.killed || e?.signal) {
            return {
              content:
                `Command timed out after ${timeout}ms and was killed.\n` +
                `${(e.stdout ?? "") + (e.stderr ?? "")}`.slice(0, 30_000),
              isError: true,
            };
          }
          return {
            content: `Exit ${e.code}\n${(e.stdout ?? "") + (e.stderr ?? "")}`.slice(0, 30_000),
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
              "No browser is available. Kryptonite drives the Chrome or Edge already " +
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
        const abs = inside(ctx.root, rel);
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
