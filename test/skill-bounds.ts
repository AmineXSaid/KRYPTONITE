/**
 * Guards the two things that let one `read_skill` call bury a conversation:
 * an unbounded skill body, and a system-prompt index that invites loading a
 * skill for "hi".
 *
 * Run: npx esbuild test/skill-bounds.ts --bundle --outfile=dist/sb.cjs \
 *        --format=cjs --platform=node --target=node20 && node dist/sb.cjs
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadSkills, skillIndex } from "../src/skills/loader";
import { runTool, type ToolContext } from "../src/agent/tools";

let pass = 0;
let fail = 0;
function ck(ok: boolean, label: string, detail = "") {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
}

const ROOT = path.join(os.tmpdir(), "kx-skill-bounds-" + Date.now());
const SKILLS = path.join(ROOT, "skills");

function writeSkill(name: string, desc: string, body: string, files: Record<string, string> = {}) {
  const dir = path.join(SKILLS, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${desc}\n---\n\n${body}`, "utf8");
  for (const [f, c] of Object.entries(files)) {
    const p = path.join(dir, f);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, c, "utf8");
  }
}

async function main() {
  fs.mkdirSync(SKILLS, { recursive: true });

  // A body the size of the real claude-api skill, which is what caused this.
  const huge = "HEAD-MARKER\n" + "x".repeat(72_000) + "\nTAIL-MARKER";
  writeSkill("huge-skill", "A very large reference.", huge, { "refs/a.md": "a" });
  writeSkill("small-skill", "A small one.", "Just a short instruction.\n");

  const { skills, warnings } = loadSkills(SKILLS);
  ck(skills.length === 2, "both skills load", String(skills.length));
  ck(warnings.some((w) => /crowd a small context/.test(w)), "the oversize body is warned about");

  const ctx = {
    root: ROOT,
    skills,
    approve: async () => true,
    onFileTouched: () => {},
  } as unknown as ToolContext;

  console.log("\n──── read_skill is bounded ────");
  const big = await runTool("read_skill", { name: "huge-skill" }, ctx);
  ck(!big.isError, "large skill still returns successfully");
  ck(big.content.length < 14_000, "result is capped well under the source size",
    `${big.content.length} chars from ${huge.length}`);
  ck(big.content.includes("HEAD-MARKER"), "the head — the routing section — is kept");
  ck(!big.content.includes("TAIL-MARKER"), "the tail is cut");
  ck(/Truncated: showing the first/.test(big.content), "truncation is stated in-band");
  ck(/72,\d\d\d characters/.test(big.content), "and names the true size", (big.content.match(/of [\d,]+ characters/) || [""])[0]);
  ck(/SKILL\.md.*read_file/s.test(big.content), "points at read_file for the rest");
  ck(/refs\/a\.md/.test(big.content), "bundled files still listed");

  const small = await runTool("read_skill", { name: "small-skill" }, ctx);
  ck(!/Truncated/.test(small.content), "a small skill is not truncated");
  ck(small.content.includes("Just a short instruction."), "and comes back whole");

  console.log("\n──── unknown skill ────");
  const missing = await runTool("read_skill", { name: "nope" }, ctx);
  ck(missing.isError === true, "unknown skill is an error");
  ck(/huge-skill/.test(missing.content) && /small-skill/.test(missing.content),
    "and lists what does exist");

  console.log("\n──── the index discourages loading for small talk ────");
  const idx = skillIndex(skills);
  ck(/Default to NOT loading/i.test(idx), "states a do-not-load default");
  ck(/greeting/i.test(idx), "names greetings explicitly");
  ck(/say hi back/i.test(idx), "gives the concrete instruction for \"hi\"");
  ck(/never more than one per turn/i.test(idx), "caps loads per turn");
  ck(idx.includes("huge-skill: A very large reference."), "still lists name and description");
  ck(!idx.includes("HEAD-MARKER"), "but never the body — the index stays level 1");
  ck(idx.length < 2000, "index stays small", `${idx.length} chars`);

  console.log("\n──── index scales with count, not body size ────");
  for (let i = 0; i < 20; i++) writeSkill(`s${i}`, `Skill number ${i}.`, "x".repeat(50_000));
  const many = loadSkills(SKILLS);
  const idx2 = skillIndex(many.skills);
  ck(many.skills.length === 22, "22 skills load", String(many.skills.length));
  ck(idx2.length < 2500, "index of 22 skills is still small", `${idx2.length} chars`);
  const totalBodies = many.skills.reduce((n, s) => n + s.body.length, 0);
  ck(totalBodies > 1_000_000 && idx2.length < 2500,
    "over 1MB of bodies costs nothing until a skill is opened",
    `${(totalBodies / 1024).toFixed(0)} KB of bodies, ${idx2.length} chars of index`);

  console.log("\n──── two folders cannot claim one skill name ────");
  await duplicates();

  console.log(`\n──── ${pass} passed, ${fail} failed ────`);
  try {
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* temp dir */
  }
  process.exit(fail ? 1 : 0);
}


/* ── duplicate names ─────────────────────────────────────────────────────
   A skill's NAME is its identity: it is what the prompt index lists, what
   read_skill is called with, and what an agent's `skills:` allowlist names.
   Two folders claiming one name are one name with two bodies, and the loser
   used to be dropped without a word - so editing the wrong folder changed
   nothing and said nothing. */
async function duplicates() {
  const DUP = path.join(ROOT, "dupes");
  const mk = (folder: string, declared: string, body: string) => {
    const dir = path.join(DUP, folder);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"),
      `---\nname: ${declared}\ndescription: d\n---\n\n${body}`, "utf8");
  };
  // Two folders, one declared name. The folder names differ, so nothing but
  // the frontmatter reveals the collision.
  mk("alpha", "review", "FIRST-BODY");
  mk("beta", "review", "SECOND-BODY");
  mk("gamma", "unique", "OWN-BODY");

  const { skills, warnings } = loadSkills(DUP);
  ck(skills.filter((s) => s.name === "review").length === 1,
    "only one skill is stored for a duplicated name",
    skills.map((s) => s.name).join(", "));
  ck(skills.length === 2, "and the unrelated skill still loads", String(skills.length));

  const first = skills.find((s) => s.name === "review");
  ck(!!first && first.body.includes("FIRST-BODY"),
    "the first folder in directory order wins",
    first ? first.body.slice(0, 20) : "(none)");

  const w = warnings.join(" | ");
  ck(/both named "review"/.test(w), "the collision is reported", w);
  ck(/alpha/.test(w) && /beta/.test(w),
    "and names BOTH folders, because 'review is a duplicate' is not actionable", w);

  // The folder name is not the identity - two folders can collide through
  // frontmatter alone, which is the case a folder-name check would miss.
  const DUP2 = path.join(ROOT, "dupes2");
  fs.mkdirSync(DUP2, { recursive: true });
  const d1 = path.join(DUP2, "totally-different-folder");
  const d2 = path.join(DUP2, "another-folder-entirely");
  for (const d of [d1, d2]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d1, "SKILL.md"), "---\nname: shared\ndescription: a\n---\n\nA", "utf8");
  fs.writeFileSync(path.join(d2, "SKILL.md"), "---\nname: shared\ndescription: b\n---\n\nB", "utf8");
  const two = loadSkills(DUP2);
  ck(two.skills.length === 1,
    "a collision declared only in frontmatter is caught too",
    two.skills.map((s) => s.name).join(", "));
}

main().catch((e) => {
  console.error("THREW", e);
  process.exit(1);
});
