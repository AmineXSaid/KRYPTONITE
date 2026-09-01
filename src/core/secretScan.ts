/**
 * Finding credentials in configuration that is about to leave the machine.
 *
 * The offline bundle copies `.agent/` verbatim and then writes a README next
 * to it saying "no credential is in it". That sentence was a claim about a
 * CONVENTION - profiles are supposed to reference secrets as `${secret:…}` -
 * asserted as a fact about the bytes. Nothing enforced the convention:
 * `loadProfile` accepts a literal string in `auth.value` and it works, which
 * is exactly what someone does while getting a gateway to answer for the first
 * time. `.agent/mcp.json` is worse, because the documented shape for an MCP
 * server's credentials is an `env` block with the token written into it.
 *
 * So the bundle is scanned, and what it says afterwards is what was actually
 * found. This is not a security boundary - anyone can paste a key anywhere -
 * it is the difference between a folder you can hand to a colleague and a
 * folder that says you can.
 *
 * Deliberately biased towards false positives. A bundle that names one extra
 * line as suspicious costs its author ten seconds; a bundle that misses a real
 * key costs them a rotation and an incident.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** Where a secret was found, and enough to go and look at it. */
export interface SecretHit {
  /** Path relative to the bundle root, as the README will print it. */
  file: string;
  /** 1-based. */
  line: number;
  /** What matched, named for a human: "an AWS access key id". */
  what: string;
  /**
   * The line with the secret itself replaced.
   *
   * Kept so the report can show WHERE without reprinting the credential into
   * a file that is about to be mailed around - which would defeat the point.
   */
  redacted: string;
}

/**
 * Named shapes, in the order they are tried.
 *
 * Vendor prefixes first because they are unambiguous: a string starting `sk-`
 * or `ghp_` is a credential and nothing else. The generic assignment rule
 * comes last and is deliberately the weakest, because it is the one that
 * catches the case with no vendor at all - a corporate gateway's opaque token
 * pasted into `auth.value`.
 */
const RULES: Array<{ what: string; re: RegExp }> = [
  { what: "an OpenAI-style API key", re: /\bsk-[A-Za-z0-9_-]{16,}/ },
  { what: "an Anthropic API key", re: /\bsk-ant-[A-Za-z0-9_-]{16,}/ },
  { what: "a GitHub token", re: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}/ },
  { what: "a Slack token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { what: "a Google API key", re: /\bAIza[A-Za-z0-9_-]{30,}/ },
  { what: "an AWS access key id", re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { what: "an Azure or Google OAuth client secret", re: /\b[A-Za-z0-9_~.-]{3}8Q~[A-Za-z0-9_~.-]{30,}/ },
  { what: "a JSON Web Token", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { what: "a private key block", re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  {
    // `token: abc123…`, `"api_key": "…"`, `PASSWORD=…`.
    // Requires a credential-ish key AND a value long enough to be one, so
    // `token: ${secret:GATEWAY}` and `password: ""` both pass.
    what: "a credential written into the file",
    re: /\b(?:api[_-]?key|apikey|secret|token|password|passwd|credential|client[_-]?secret|authorization|auth[_-]?value)\b\s*[:=]\s*["']?([A-Za-z0-9_+/=.~-]{16,})["']?/i,
  },
];

/**
 * The bare `value:` key, which is where a Genesis profile's credential goes.
 *
 * Its own rule because it needs its own judgement. `auth.value` in a profile
 * YAML is written as an indented `value:` with no other word near it, so the
 * credential-name rule above misses the single most important case in the
 * product - and adding `value` to that list would flag every `value:` in every
 * skill and instructions file in the bundle.
 *
 * Narrowed two ways instead: only in files that hold configuration, and only
 * when what follows looks like a key rather than like a word. See
 * `looksOpaque`.
 */
const VALUE_RULE = {
  what: "a credential in an auth value",
  re: /^\s*(?:"?value"?)\s*[:=]\s*["']?([A-Za-z0-9_+/=.~-]{20,})["']?\s*,?\s*$/i,
};

/** Where a bare `value:` is worth judging at all. */
const CONFIG_EXT = /\.(ya?ml|jsonc?)$/i;

/**
 * Does this look like a key rather than like a word someone wrote?
 *
 * A credential is a run of characters with no structure: no spaces, no path
 * separators, and a mix of letters and digits. `claude-sonnet-4-5` has the mix
 * but reads as a name; `8f4c1e77d0b94a2f9e6a5c3b1d8f0a2e` does not. The
 * discriminator that separates them cheaply is whether the string is mostly
 * one long unbroken run - a name is hyphenated into short pieces.
 */
function looksOpaque(value: string): boolean {
  if (!/[0-9]/.test(value) || !/[A-Za-z]/.test(value)) return false;
  const longestRun = Math.max(...value.split(/[-_.]/).map((p) => p.length));
  return longestRun >= 16;
}

/**
 * The one shape that is explicitly NOT a secret.
 *
 * `${secret:NAME}`, `${env:NAME}` and `${file:path}` are the indirections the
 * whole design rests on, and every one of them would otherwise trip the
 * generic assignment rule above. Checked against the matched VALUE rather than
 * the whole line, so `token: ${env:X}  # was sk-abc…` is still caught.
 */
const INDIRECTION = /^\$\{(?:env|secret|file):[^}]*\}$/;

/**
 * Placeholders people write while a profile is still a draft.
 *
 * These reach a bundle constantly - the template in the docs uses one - and
 * reporting them trains the author to ignore the report, which is the failure
 * mode that matters most here.
 */
const PLACEHOLDER =
  /^(?:x{3,}|\.{3,}|<[^>]*>|your[_-]?\w*|changeme|placeholder|todo|replace[_-]?me|example|dummy|redacted|null|none|undefined|0+|1234\d*)$/i;

/** Mask a secret to its shape: enough to recognise, not enough to use. */
function mask(secret: string): string {
  if (secret.length <= 8) return "*".repeat(secret.length);
  return `${secret.slice(0, 4)}${"*".repeat(Math.min(secret.length - 8, 24))}${secret.slice(-4)}`;
}

/** What replaces a secret in a file that is about to be handed to someone. */
export const REDACTED = "REDACTED";

/**
 * Extensions worth reading.
 *
 * A bundle carries YAML, JSON, Markdown and the occasional transform. Reading
 * a font or a screenshot that happened to be bundled with a skill and running
 * eleven regexes over its bytes is pure cost, and a binary is not where a
 * credential a person typed ends up.
 */
const TEXTUAL = new Set([
  ".yaml", ".yml", ".json", ".jsonc", ".md", ".txt", ".js", ".mjs", ".cjs",
  ".ts", ".env", ".ini", ".conf", ".toml", ".sh", ".ps1", ".xml", ".properties",
]);

/** Files bigger than this are data, not configuration someone hand-edited. */
const MAX_BYTES = 2 * 1024 * 1024;

/**
 * Scan one file's text.
 *
 * Line by line, because a report that says "somewhere in this file" is a
 * report nobody can act on, and because it bounds what any one rule can chew
 * through.
 */
export function scanText(text: string, file: string): SecretHit[] {
  const hits: SecretHit[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // A long line is far more likely to be minified data than configuration
    // with a credential in it, and running a dozen regexes over it is the kind
    // of thing that hangs an extension host.
    if (line.length > 4000) continue;
    const found = matchLine(line, file);
    if (!found) continue;
    hits.push({
      file,
      line: i + 1,
      what: found.what,
      redacted: line.replace(found.value, mask(found.value)).trim().slice(0, 200),
    });
  }
  return hits;
}

/**
 * The one credential on a line, if there is one.
 *
 * Shared by the scan and the rewrite so the two cannot disagree about what
 * counts - a mismatch there would report a line as redacted and leave the
 * value in the file.
 */
function matchLine(line: string, file: string): { what: string; value: string } | undefined {
  for (const rule of RULES) {
    const m = rule.re.exec(line);
    if (!m) continue;
    // Group 1 when the rule has one (the generic assignment), else the whole
    // match: the assignment rule's own text includes the key name, which is
    // not the part to judge or to mask.
    const value = m[1] ?? m[0];
    if (INDIRECTION.test(value) || PLACEHOLDER.test(value)) continue;
    return { what: rule.what, value };
  }
  if (CONFIG_EXT.test(file)) {
    const m = VALUE_RULE.re.exec(line);
    const value = m?.[1];
    if (value && !INDIRECTION.test(value) && !PLACEHOLDER.test(value) && looksOpaque(value)) {
      return { what: VALUE_RULE.what, value };
    }
  }
  return undefined;
}

/**
 * Scan every text file under `dir`, replace what is found, and report it.
 *
 * REDACTS IN PLACE, which is the whole design. Refusing to export at all would
 * leave the user with no bundle and a problem to solve first; shipping the
 * file untouched with a warning would put the credential on the far machine
 * anyway. Replacing the value keeps the shape of the configuration - the
 * receiving user can see there IS an `auth.value` and what field it sits in -
 * while the secret itself stays behind.
 *
 * `reportRoot` is what paths are made relative to, so the README names files
 * the way the person opening the folder will see them.
 */
export function redactSecretsUnder(dir: string, reportRoot: string): SecretHit[] {
  const found: SecretHit[] = [];
  const stack: string[] = [dir];

  while (stack.length) {
    const at = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(at, { withFileTypes: true });
    } catch {
      continue; // an unreadable directory is not a reason to abandon the scan
    }
    for (const e of entries) {
      const abs = path.join(at, e.name);
      if (e.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (!e.isFile()) continue;
      if (!TEXTUAL.has(path.extname(e.name).toLowerCase())) continue;

      let text: string;
      try {
        if (fs.statSync(abs).size > MAX_BYTES) continue;
        text = fs.readFileSync(abs, "utf8");
      } catch {
        continue;
      }

      const rel = path.relative(reportRoot, abs).split(path.sep).join("/");
      const hits = scanText(text, rel);
      if (!hits.length) continue;

      // Rewrite the lines that matched, through the SAME matcher the scan
      // used. Re-deriving the value rather than trusting the report keeps the
      // two from ever disagreeing - a disagreement here would announce a line
      // as redacted and leave the credential in the file.
      const lines = text.split("\n");
      for (const hit of hits) {
        const i = hit.line - 1;
        const found = matchLine(lines[i], rel);
        if (found) lines[i] = lines[i].split(found.value).join(REDACTED);
      }
      try {
        fs.writeFileSync(abs, lines.join("\n"), "utf8");
      } catch {
        // If it cannot be rewritten it must not be reported as redacted, and
        // it must not ship: an unwritable file in a directory this function
        // just created is close to impossible, but silently exporting the
        // original is the one outcome that must not happen.
        try { fs.rmSync(abs); } catch { /* nothing else to try */ }
      }
      found.push(...hits);
    }
  }
  return found;
}
