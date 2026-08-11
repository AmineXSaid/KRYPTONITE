import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Skills, loaded the way Claude Code loads them: progressive disclosure.
 *
 * A skill is a folder with a SKILL.md carrying YAML frontmatter, plus whatever
 * supporting files it needs. Three levels, each paid for only when reached:
 *
 *   1. name + description   - in the system prompt, always. ~2 lines per skill.
 *   2. SKILL.md body        - fetched by `read_skill` when the model decides
 *                             the skill is relevant.
 *   3. bundled files        - listed by `read_skill`, read individually with
 *                             `read_file` only if the body points at them.
 *
 * On a 32k gateway that staging is the whole ballgame: seventeen bundled
 * skills cost about a thousand tokens at level 1 and nothing at all after
 * that unless one is actually used.
 */
export interface Skill {
  name: string;
  description: string;
  body: string;
  dir: string;
  /**
   * Paths of supporting files, relative to the skill folder, forward-slashed
   * and depth-limited. Subdirectories are included: a skill whose body says
   * "use the template in templates/" is useless if the model cannot see that
   * templates/ exists.
   */
  files: string[];
  /** Frontmatter beyond name/description, kept for future contribution points. */
  meta: Record<string, string>;
}

const MAX_FILE_DEPTH = 3;
const MAX_FILES_LISTED = 60;
/** A SKILL.md larger than this is a reference document, not an instruction. */
const MAX_BODY_CHARS = 24_000;

/**
 * Minimal YAML frontmatter reader.
 *
 * Deliberately not a YAML parser: frontmatter here is flat scalars, and
 * pulling the `yaml` dependency into the skill path would mean a malformed
 * SKILL.md could throw where it currently degrades. It understands the two
 * forms that appear in practice - `key: value` and a folded/literal block
 * (`key: >-`) whose continuation lines are indented.
 */
function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { meta: {}, body: raw };

  const meta: Record<string, string> = {};
  const lines = m[1].split(/\r?\n/);
  let key: string | null = null;
  let folded: string[] = [];

  const flush = () => {
    if (key && folded.length) meta[key] = folded.join(" ").trim();
    folded = [];
  };

  for (const line of lines) {
    // A continuation line of a block scalar: indented, and we are inside one.
    if (key && folded.length !== 0 && /^\s+\S/.test(line)) {
      folded.push(line.trim());
      continue;
    }
    const i = line.indexOf(":");
    if (i === -1) continue;
    flush();
    key = line.slice(0, i).trim();
    const value = line.slice(i + 1).trim();
    if (value === ">" || value === ">-" || value === "|" || value === "|-") {
      // Block scalar: the value is on the following indented lines.
      folded = [""];
      continue;
    }
    meta[key] = value.replace(/^["']|["']$/g, "");
    key = null;
  }
  flush();
  return { meta, body: raw.slice(m[0].length) };
}

/** Supporting files, recursively, so bundled resources are discoverable. */
function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (abs: string, rel: string, depth: number) => {
    if (depth > MAX_FILE_DEPTH || out.length >= MAX_FILES_LISTED) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX_FILES_LISTED) return;
      if (e.name.startsWith(".")) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        walk(path.join(abs, e.name), childRel, depth + 1);
      } else if (e.name !== "SKILL.md") {
        out.push(childRel);
      }
    }
  };
  walk(dir, "", 0);
  return out;
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
    if (body.length > MAX_BODY_CHARS) {
      warnings.push(
        `${name}'s SKILL.md is ${Math.round(body.length / 1000)}k characters - it will crowd a small context. ` +
          `Move the detail into a reference file and point at it from the body.`
      );
    }
    delete meta.name;
    delete meta.description;
    skills.push({ name, description, body: body.trim(), dir, files: listFiles(dir), meta });
  }
  return { skills, warnings };
}

/**
 * The index that goes into the system prompt - level 1 of the disclosure.
 *
 * Wording matters more than it looks. The model decides whether to spend a
 * turn on `read_skill` purely from these lines, so the block states the
 * trigger rule (match on the description, not the name), the cost (one tool
 * call, nothing up front), and the failure mode it is meant to prevent:
 * answering from a half-remembered idea of what a skill probably says. The
 * `/name` convention is spelled out because the composer inserts exactly that
 * when a skill is picked from the slash palette, and without this the leading
 * token reads as noise.
 */
export function skillIndex(skills: Skill[]): string {
  if (!skills.length) return "";
  const lines = skills.map((s) => `- ${s.name}: ${s.description}`);
  return [
    "## Skills",
    "",
    "Instruction sets available in this workspace. Only the names and descriptions",
    "are loaded - the instructions themselves are not in your context yet.",
    "",
    ...lines,
    "",
    "Rules:",
    "- Default to NOT loading a skill. Most messages need none.",
    "- Never load one for a greeting, a thank-you, a question about yourself, or",
    "  small talk. If the user says \"hi\", just say hi back.",
    "- Load one only when the user has asked for work that a description above",
    "  actually covers. Match on the description, not on a word in the name.",
    "- A message that starts with /<name> is an explicit request for that skill:",
    "  read_skill it first, then treat the rest of the message as the task.",
    "- Never guess a skill's contents. Reading it is one cheap call; inventing",
    "  its instructions produces work that looks right and is not.",
    "- read_skill also lists the skill's bundled files. Read those with read_file",
    "  only when the instructions send you to them.",
    "- One skill at a time, and never more than one per turn.",
  ].join("\n");
}
