import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ToolDef } from "../providers/client";
import type { Skill } from "../skills/loader";

const pexec = promisify(execFile);

// CHANGED: added. Mirrors the update_todos tool schema.
export type TodoStatus = "pending" | "in_progress" | "completed";
export interface TodoItem {
  content: string;
  status: TodoStatus;
}

export interface ToolContext {
  root: string;
  skills: Skill[];
  /** Returns true if the user allows this side effect. */
  approve: (summary: string, detail?: string) => Promise<boolean>;
  onFileTouched: (absPath: string) => void;
  // CHANGED: added. Receives the validated list from update_todos. Optional so
  // callers that do not render a todo card need no changes.
  onTodos?: (todos: TodoItem[]) => void;
}

export interface ToolResult {
  content: string;
  isError?: boolean;
}

function inside(root: string, p: string): string {
  const abs = path.resolve(root, p);
  if (!abs.startsWith(path.resolve(root))) {
    throw new Error(`Path ${p} is outside the workspace.`);
  }
  return abs;
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
    description: "Replace one exact string in a file. The old text must appear exactly once.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_text: { type: "string" },
        new_text: { type: "string" },
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
    name: "search",
    description: "Search file contents with a regular expression.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        glob: { type: "string", description: "Optional filename filter, e.g. *.ts" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "run_command",
    description: "Run a shell command in the workspace root. Requires approval.",
    parameters: {
      type: "object",
      properties: { command: { type: "string" }, reason: { type: "string" } },
      required: ["command", "reason"],
    },
  },
  {
    name: "read_skill",
    description: "Load the full instructions for a named skill.",
    parameters: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
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
    switch (name) {
      case "read_file": {
        const abs = inside(ctx.root, args.path);
        const lines = fs.readFileSync(abs, "utf8").split("\n");
        const start = Math.max(1, args.start ?? 1);
        const end = Math.min(lines.length, args.end ?? lines.length);
        if (end - start > 2000) {
          return { content: `That range is ${end - start} lines. Read it in smaller pieces.`, isError: true };
        }
        return {
          content: lines
            .slice(start - 1, end)
            .map((l, i) => `${start + i}\t${l}`)
            .join("\n"),
        };
      }

      case "write_file": {
        const abs = inside(ctx.root, args.path);
        const existed = fs.existsSync(abs);
        const ok = await ctx.approve(
          `${existed ? "Overwrite" : "Create"} ${args.path}`,
          args.content.slice(0, 2000)
        );
        if (!ok) return { content: "The user declined this edit.", isError: true };
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, args.content, "utf8");
        ctx.onFileTouched(abs);
        return { content: `Wrote ${args.content.split("\n").length} lines to ${args.path}.` };
      }

      case "edit_file": {
        const abs = inside(ctx.root, args.path);
        if (!fs.existsSync(abs)) return { content: `${args.path} does not exist.`, isError: true };
        const before = fs.readFileSync(abs, "utf8");
        const count = before.split(args.old_text).length - 1;
        if (count === 0) {
          return { content: `That exact text is not in ${args.path}. Read the file again.`, isError: true };
        }
        if (count > 1) {
          return {
            content: `That text appears ${count} times in ${args.path}. Include more surrounding context.`,
            isError: true,
          };
        }
        const ok = await ctx.approve(`Edit ${args.path}`, `- ${args.old_text}\n+ ${args.new_text}`);
        if (!ok) return { content: "The user declined this edit.", isError: true };
        fs.writeFileSync(abs, before.replace(args.old_text, args.new_text), "utf8");
        ctx.onFileTouched(abs);
        return { content: `Edited ${args.path}.` };
      }

      case "list_files": {
        const abs = inside(ctx.root, args.path ?? ".");
        const out: string[] = [];
        const walk = (dir: string, depth: number) => {
          if (depth > (args.depth ?? 2) || out.length > 500) return;
          for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (e.name.startsWith(".") || IGNORED.has(e.name)) continue;
            const full = path.join(dir, e.name);
            out.push(path.relative(ctx.root, full) + (e.isDirectory() ? "/" : ""));
            if (e.isDirectory()) walk(full, depth + 1);
          }
        };
        walk(abs, 0);
        return { content: out.join("\n") || "(empty)" };
      }

      case "search": {
        const re = new RegExp(args.pattern, "gm");
        const globRe = args.glob
          ? new RegExp("^" + args.glob.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$")
          : undefined;
        const hits: string[] = [];
        const walk = (dir: string) => {
          if (hits.length > 200) return;
          for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (e.name.startsWith(".") || IGNORED.has(e.name)) continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) {
              walk(full);
              continue;
            }
            if (globRe && !globRe.test(e.name)) continue;
            let text: string;
            try {
              text = fs.readFileSync(full, "utf8");
            } catch {
              continue;
            }
            text.split("\n").forEach((line, i) => {
              re.lastIndex = 0;
              if (re.test(line)) hits.push(`${path.relative(ctx.root, full)}:${i + 1}: ${line.trim().slice(0, 200)}`);
            });
          }
        };
        walk(ctx.root);
        return { content: hits.slice(0, 200).join("\n") || "No matches." };
      }

      case "run_command": {
        const ok = await ctx.approve(`Run: ${args.command}`, args.reason);
        if (!ok) return { content: "The user declined to run that command.", isError: true };
        try {
          const { stdout, stderr } = await pexec(args.command, {
            cwd: ctx.root,
            shell: true,
            timeout: 120_000,
            maxBuffer: 4 * 1024 * 1024,
          } as any);
          return { content: (stdout + (stderr ? "\n" + stderr : "")).slice(0, 30_000) || "(no output)" };
        } catch (e: any) {
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
        const extras = skill.files.length
          ? `\n\nFiles in this skill's folder (${path.relative(ctx.root, skill.dir)}): ${skill.files.join(", ")}`
          : "";
        return { content: skill.body + extras };
      }

      // CHANGED: added. No approval gate — this touches no files and runs no
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
