import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Same shape as the Anthropic skills repo: a folder per skill, a SKILL.md with
 * YAML frontmatter, any supporting files alongside. Only name + description go
 * into the system prompt; the body is fetched by the model through a tool when
 * it decides the skill is relevant. On a 32k gateway that difference is the
 * whole ballgame.
 */
export interface Skill {
  name: string;
  description: string;
  body: string;
  dir: string;
  files: string[];
}

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { meta: {}, body: raw };
  const meta: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i === -1) continue;
    meta[line.slice(0, i).trim()] = line
      .slice(i + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
  }
  return { meta, body: raw.slice(m[0].length) };
}

export function loadSkills(root: string): { skills: Skill[]; warnings: string[] } {
  const skills: Skill[] = [];
  const warnings: string[] = [];
  if (!fs.existsSync(root)) return { skills, warnings };

  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    const file = path.join(dir, "SKILL.md");
    if (!fs.existsSync(file)) {
      warnings.push(`${entry.name} has no SKILL.md and was ignored.`);
      continue;
    }
    const { meta, body } = parseFrontmatter(fs.readFileSync(file, "utf8"));
    const name = meta.name ?? entry.name;
    const description = meta.description ?? "";
    if (!description) {
      warnings.push(`${name} has no description, so the model cannot tell when to use it.`);
    }
    skills.push({
      name,
      description,
      body,
      dir,
      files: fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((f) => f.isFile() && f.name !== "SKILL.md")
        .map((f) => f.name),
    });
  }
  return { skills, warnings };
}

/** The index that goes into the system prompt. Cheap — a line per skill. */
export function skillIndex(skills: Skill[]): string {
  if (!skills.length) return "";
  const lines = skills.map((s) => `- ${s.name}: ${s.description}`);
  return [
    "Skills available in this workspace. Each is a set of instructions you can read on demand.",
    "When a task matches one, call read_skill with its name before starting work.",
    ...lines,
  ].join("\n");
}
