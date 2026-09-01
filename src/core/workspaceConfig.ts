import * as fs from "node:fs";
import * as path from "node:path";
import {
  loadAllProfiles,
  ProfileError,
  type EndpointProfile,
} from "../endpoints/profile";
import { loadSkills, type Skill } from "../skills/loader";
import { loadAgents, type Agent } from "../agents/loader";

/**
 * Everything the workspace declares, loaded and reconciled.
 *
 * This was ~170 lines in the middle of `App.reloadNow`, interleaved with
 * closing HTTP clients, restarting MCP servers, priming the secret cache,
 * updating the status bar and broadcasting four messages to the panel. Two
 * different jobs sharing one function: deciding what the configuration IS, and
 * telling everything else that it changed.
 *
 * They are worth separating because the first one is pure. Given a root and a
 * few settings it reads files and returns a value - no vscode, no side
 * effects, no ordering constraints - which means the rules that actually bite
 * (a duplicate endpoint name, a workspace skill shadowing a bundled one, a
 * global CA bundle merging into every profile) can be tested directly instead
 * of only through a booted extension host. `App` keeps the orchestration,
 * which is where the side effects belong.
 */

export interface WorkspaceSources {
  /** Absolute workspace root. */
  root: string;
  /** `genesis.profileDirectory`, workspace-relative. */
  profileDir: string;
  /** `genesis.skillsDirectory`, workspace-relative. */
  skillsDir: string;
  /** Where the agent definitions live, absolute. */
  agentsDir: string;
  /** The extension's own bundled skills directory, absolute. */
  bundledSkillsDir: string;
  /** `genesis.caBundlePath`, merged into every profile when set. */
  globalCaBundle: string;
}

export interface LoadedWorkspace {
  profiles: EndpointProfile[];
  profileErrors: ProfileError[];
  /** Names that appeared in more than one file, so the panel can say so. */
  duplicateProfileNames: string[];
  skills: Skill[];
  skillWarnings: string[];
  agents: Agent[];
  agentWarnings: string[];
}

/** What a workspace with nothing configured - or no folder open - looks like. */
export function emptyWorkspace(): LoadedWorkspace {
  return {
    profiles: [],
    profileErrors: [],
    duplicateProfileNames: [],
    skills: [],
    skillWarnings: [],
    agents: [],
    agentWarnings: [],
  };
}

/**
 * A global CA bundle is a workspace-wide fact, so it merges into every profile
 * rather than being repeated in each YAML.
 */
function mergeGlobalCa(profiles: EndpointProfile[], globalCa: string): void {
  if (!globalCa) return;
  for (const p of profiles) {
    const tls = p.tls ?? {};
    const existing = tls.caBundle
      ? Array.isArray(tls.caBundle)
        ? [...tls.caBundle]
        : [tls.caBundle]
      : [];
    if (!existing.includes(globalCa)) existing.push(globalCa);
    p.tls = { ...tls, caBundle: existing };
  }
}

/**
 * Refuse duplicate endpoint names, and sort what is left.
 *
 * TWO PROFILES WITH THE SAME `name:` IS NOT A COSMETIC PROBLEM. `clientFor`
 * pools clients by `profile.name`, so the second file's baseUrl, TLS material
 * and credential were silently never used - every request went out on the
 * first one's client. The agents loader and the skills loader both refuse
 * duplicate names already; the one place where a collision decides WHERE
 * REQUESTS GO did not check at all.
 *
 * Sorted as well, so `profiles[0]` - the fallback when the configured active
 * profile is missing - is the same profile on every machine rather than
 * whatever the filesystem happened to list first.
 */
function dedupeProfiles(
  profiles: EndpointProfile[],
  errors: ProfileError[]
): { kept: EndpointProfile[]; duplicates: string[] } {
  profiles.sort((a, b) => a.name.localeCompare(b.name));
  const byName = new Map<string, EndpointProfile>();
  const dupes: string[] = [];
  for (const p of profiles) {
    const first = byName.get(p.name);
    if (first) {
      dupes.push(p.name);
      errors.push(
        new ProfileError(
          `Another profile is already called "${p.name}" (${path.basename(first.sourceFile ?? "")}). ` +
            `Endpoint names have to be unique - requests are routed by them - so this file was not loaded.`,
          p.sourceFile
        )
      );
      continue;
    }
    byName.set(p.name, p);
  }
  return { kept: [...byName.values()], duplicates: [...new Set(dupes)] };
}

/**
 * Merge the workspace's skills over the bundled ones.
 *
 * Workspace wins name collisions - a repo's own version of a skill is the one
 * its authors intended. That is deliberate, but it was also SILENT: the only
 * visible effect was that the bundled skill's body stopped being the one that
 * loaded. Intentional behaviour still has to be legible, so the shadowing is
 * reported. Duplicates WITHIN either directory are refused outright by
 * `loadSkills` - see the note there.
 */
function mergeSkills(
  workspace: { skills: Skill[]; warnings: string[] },
  bundled: { skills: Skill[]; warnings: string[] }
): { skills: Skill[]; warnings: string[] } {
  const merged = new Map<string, Skill>();
  for (const s of bundled.skills) merged.set(s.name, s);
  const shadowed: string[] = [];
  for (const s of workspace.skills) {
    if (merged.has(s.name)) shadowed.push(s.name);
    merged.set(s.name, s);
  }
  const warnings = [...workspace.warnings, ...bundled.warnings];
  if (shadowed.length) {
    warnings.push(
      `Your workspace overrides ${shadowed.length === 1 ? "a bundled skill" : "bundled skills"}: ` +
        `${shadowed.join(", ")}. The workspace copy is the one that loads.`
    );
  }
  return { skills: [...merged.values()], warnings };
}

/** Read every declaration this workspace makes. No side effects beyond the reads. */
export function loadWorkspace(src: WorkspaceSources): LoadedWorkspace {
  const { profiles, errors } = loadAllProfiles(path.join(src.root, src.profileDir));
  mergeGlobalCa(profiles, src.globalCaBundle.trim());
  const { kept, duplicates } = dedupeProfiles(profiles, errors);

  const bundled = fs.existsSync(src.bundledSkillsDir)
    ? loadSkills(src.bundledSkillsDir)
    : { skills: [] as Skill[], warnings: [] as string[] };
  const skills = mergeSkills(loadSkills(path.join(src.root, src.skillsDir)), bundled);

  const agents = loadAgents(src.agentsDir);

  return {
    profiles: kept,
    profileErrors: errors,
    duplicateProfileNames: duplicates,
    skills: skills.skills,
    skillWarnings: skills.warnings,
    agents: agents.agents,
    agentWarnings: agents.warnings,
  };
}

/**
 * Whether `.agent/mcp.json` has changed since the servers were last started.
 *
 * A stamp rather than a watcher because the answer is needed inside a reload
 * that several unrelated edits can trigger. MCP servers are child processes,
 * and restarting them because a SKILL.md was saved kills them under a running
 * turn - which is what the unconditional restart here used to do.
 */
export class McpConfigStamp {
  private stamp = "";
  private loaded = false;

  /** True once, on the first call, and thereafter only when the file changes. */
  changed(file: string): boolean {
    const next = fileStamp(file);
    if (this.loaded && next === this.stamp) return false;
    this.stamp = next;
    this.loaded = true;
    return true;
  }
}

/** Cheap change detector for a single config file. Absent reads as "". */
function fileStamp(file: string): string {
  try {
    const st = fs.statSync(file);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "";
  }
}
