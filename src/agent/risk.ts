/**
 * What a shell command is allowed to cost, decided before it runs.
 *
 * The allowlist this replaces keyed on the first WORD of a command. Approving
 * `git status` once with "always" stored the token `git`, and from then on
 * `git reset --hard`, `git push --force` and `git clean -fdx` ran with no
 * prompt, forever, persisted in workspace state. The grant the user saw was
 * "let this read the repo"; the grant they got was "let this rewrite it".
 *
 * Two things fix that, and both are here because they have to agree:
 *
 *   `classify`  how much a command can cost, so the worst kind never rides in
 *               on a grant made for the mildest.
 *   `signature` the key a grant is stored under, narrow enough that one
 *               command cannot unlock a different one.
 *
 * Both work on SEGMENTS rather than whole command lines. A rule that matched
 * the whole line would be defeated by `safe-thing && rm -rf ~`, which is the
 * single most important property in this file: every separator-delimited piece
 * is judged on its own, and the line is only as good as its worst piece.
 *
 * Everything here is pure and depends on nothing, so `test/risk.ts` can drive
 * it directly without a VS Code surface.
 */

export type Risk = "safe" | "write" | "destructive";

/** Ordered worst-last, so an index comparison ranks two verdicts. */
const RANK: Risk[] = ["safe", "write", "destructive"];

/**
 * The shell operators that end one command and begin another.
 *
 * `&` is included, and it is the easy one to forget: `rm -rf / &` is a
 * backgrounded removal, not an argument to whatever preceded it.
 */
const SEPARATORS = /&&|\|\||;|\||&|\n/;

/**
 * Patterns that only exist across a pipe, checked before the line is split.
 *
 * `curl … | sh` is the whole point. Split first and it becomes `curl …` and
 * `sh`, neither of which looks like anything on its own - the danger is
 * precisely the join. So the whole line is read once for the shapes that live
 * in the seam, and only then broken up.
 */
const DESTRUCTIVE_WHOLE: RegExp[] = [
  // Download cradle: fetch a script and feed it straight to an interpreter.
  /\b(curl|wget|fetch)\b[^|]*\|\s*(sudo\s+)?(ba|z|k|da)?sh\b/i,
  /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(python3?|perl|ruby|node)\b/i,
  // Fork bomb, in the classic form and with whitespace anywhere in it.
  /:\s*\(\s*\)\s*\{[^}]*\}\s*;?\s*:/,
  // Writing over a block device, however the redirect is spelled.
  />\s*\/dev\/(sd|hd|nvme|disk|vd)/i,
];

/**
 * Commands that can destroy work that is not recoverable from this process.
 *
 * The bar is "would the user lose something a checkpoint cannot give back":
 * uncommitted files, a published package, a remote branch, a running cluster.
 * A merely messy command - `npm install`, a build that writes a lot - is
 * `write`, not this. Overreach here is not free: a verdict of `destructive`
 * can never be auto-approved, so putting ordinary work in this list would
 * reintroduce the prompt fatigue the classification exists to remove.
 */
const DESTRUCTIVE_SEGMENT: RegExp[] = [
  // Recursive or forced removal. `rm file` alone is `write`.
  /^\s*(sudo\s+)?rm\b[^|]*\s-{1,2}[a-z-]*(r|f)/i,
  /^\s*(sudo\s+)?rm\b.*\s(-r|-f|--recursive|--force)\b/i,
  // Git, in the forms that discard or rewrite history rather than report it.
  /^\s*git\b.*\breset\b.*--hard\b/i,
  /^\s*git\b.*\bclean\b.*\s-[a-z]*f/i,
  /^\s*git\b.*\bpush\b.*--force(?!-with-lease)/i,
  /^\s*git\b.*\bpush\b.*\s-f\b/i,
  /^\s*git\b.*\bbranch\b.*\s-D\b/i,
  /^\s*git\b.*\bcheckout\b\s+--\s/i,
  /^\s*git\b.*\bfilter-branch\b/i,
  // Filesystem and device level.
  /^\s*(sudo\s+)?(mkfs\S*|dd|shred|fdisk|parted|wipefs)\b/i,
  /^\s*(sudo\s+)?(chmod|chown)\b.*\s(-R|--recursive)\b/i,
  // Publishing: outward-facing and effectively irreversible.
  /^\s*(npm|pnpm|yarn|bun)\b.*\b(un)?publish\b/i,
  /^\s*(twine|cargo|gem)\b.*\b(publish|upload)\b/i,
  // Infrastructure teardown.
  /^\s*docker\b.*\b(system\s+prune|volume\s+rm|rmi|rm)\b/i,
  /^\s*(kubectl|helm|terraform)\b.*\b(delete|destroy)\b/i,
  // The machine itself, and this process's own siblings.
  /^\s*(sudo\s+)?(shutdown|reboot|halt|poweroff|init\s+0)\b/i,
  /^\s*(sudo\s+)?(killall|pkill)\b/i,
  // Privilege escalation is never auto-approved, whatever follows it.
  /^\s*sudo\b/i,
];

/**
 * Commands that only report, and so never need a prompt.
 *
 * Deliberately the set Claude Code publishes as its built-in read-only list,
 * rather than one invented here: it is a list that has already survived
 * contact with the ways a "read-only" command turns out not to be.
 *
 * Anchored at the start and specific about subcommands, because the whole
 * failure being fixed was a rule that matched a program and ignored what it
 * was being asked to do.
 */
const SAFE_SEGMENT: RegExp[] = [
  /^\s*git\s+(status|log|diff|show|blame|branch|remote|describe|rev-parse|ls-files|shortlog|tag|stash\s+list|config\s+--get)\b/i,
  /^\s*(ls|pwd|cat|head|tail|wc|stat|file|du|df|which|whoami|date|uptime|hostname|uname)\b/i,
  /^\s*(echo|printf|true|false|test)\b/i,
  /^\s*(rg|grep|egrep|fgrep|find|fd|jq|yq|diff|cmp|tree|realpath|basename|dirname)\b/i,
  /^\s*(node|npm|pnpm|yarn|bun|python3?|go|cargo|tsc|deno)\s+(-v|--version)\s*$/i,
  /^\s*cd\b/i,
];

/**
 * A flag that lets an otherwise read-only command write, execute, or reach a
 * host the user did not name.
 *
 * `find` reads until it is handed `-delete` or `-exec`; `grep` reads until it
 * is pointed at a file list it will open. Matching the program name alone and
 * calling it safe is how a read-only list becomes a write primitive, so a
 * segment carrying one of these drops out of `safe` even when its program is
 * on the list above.
 */
const ESCAPE_FLAGS = /\s(-delete|-exec|-execdir|-ok|-fprint|--output|-o\s|--files-from|-m\b|--magic-file)/i;

/**
 * An unquoted glob in a segment whose program accepts an escape flag.
 *
 * `find . -name '*.ts'` is fine; `find . *` can expand to `-delete` if a file
 * in the directory is named that. The glob itself is not the danger - what it
 * might expand into is - so this only downgrades programs that would act on
 * the result.
 */
const GLOB_RISK_PROGRAMS = /^\s*(find|sed|sort|git|xargs|tar|rsync)\b/i;

/** Redirection that creates or truncates a file makes a reader into a writer. */
const REDIRECT_WRITE = /(^|[^0-9<>])>{1,2}(?!\s*\/dev\/null)/;

/**
 * Break a command line into the pieces the shell would run separately.
 *
 * Quoting is not parsed. A separator inside a quoted string - `echo "a && b"` -
 * therefore splits into pieces that were never really commands, and those
 * pieces fall through to `write` because they match nothing. That is the
 * direction to be wrong in: the cost is one prompt for a command that did not
 * need it, where the opposite error hands out a grant that was never asked
 * for. A real parser can replace this without changing any caller.
 */
export function segments(command: string): string[] {
  return command
    .split(SEPARATORS)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** How much one already-split piece can cost. */
function classifySegment(seg: string): Risk {
  if (DESTRUCTIVE_SEGMENT.some((re) => re.test(seg))) return "destructive";

  if (SAFE_SEGMENT.some((re) => re.test(seg))) {
    // A reader that has been handed the means to write is not a reader.
    if (ESCAPE_FLAGS.test(seg)) return "write";
    if (REDIRECT_WRITE.test(seg)) return "write";
    if (GLOB_RISK_PROGRAMS.test(seg) && /(^|\s)[^'"\s]*\*/.test(seg)) return "write";
    return "safe";
  }

  // Unrecognised is `write`, never `safe`. The list of things that can damage a
  // workspace is open-ended and the list of things that cannot is not, so the
  // unknown belongs with the side that asks.
  return "write";
}

/**
 * How much a whole command line can cost: the worst of its pieces.
 *
 * A line longer than 10,000 characters is `write` at minimum however it reads,
 * because at that length the regexes above are no longer a reliable account of
 * what it does, and a confident `safe` is worth less than an honest prompt.
 */
export function classify(command: string): Risk {
  const line = command.trim();
  if (!line) return "safe";

  if (DESTRUCTIVE_WHOLE.some((re) => re.test(line))) return "destructive";

  let worst: Risk = "safe";
  for (const seg of segments(line)) {
    const risk = classifySegment(seg);
    if (risk === "destructive") return "destructive";
    if (RANK.indexOf(risk) > RANK.indexOf(worst)) worst = risk;
  }

  if (worst === "safe" && line.length > 10_000) return "write";
  return worst;
}

/** Split a segment into words, keeping quoted runs together. */
function words(seg: string): string[] {
  return seg.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
}

/**
 * The key one grant is stored under.
 *
 * Program, the first word that says what the program is being asked to do, and
 * the flags it was given - sorted, so that flag order cannot mint a second key
 * for the same command. The argument VALUES are dropped: a grant for
 * `npm run build` covers `npm run test`, matching the `Bash(npm run *)` shape
 * users already expect, and one for `git status` covers `git status src/`.
 *
 * What it must never do is let one command stand in for another, and that is
 * the whole difference from the first-word key it replaces:
 *
 *   git status        -> "git status"
 *   git reset --hard  -> "git reset --hard"
 *
 * Two keys. Approving the first grants nothing about the second.
 *
 * Pass ONE segment. A compound line has one signature per piece - see
 * `grantSignatures`.
 */
export function signature(segment: string): string {
  const parts = words(segment.trim());
  if (!parts.length) return "";
  const [bin, ...rest] = parts;
  const sub = rest.find((a) => !a.startsWith("-")) ?? "";
  const flags = rest.filter((a) => a.startsWith("-")).sort();
  return [bin, sub, ...flags].filter(Boolean).join(" ");
}

/**
 * How many grants one "always" may create.
 *
 * A long compound line should not be able to spend a single click on an
 * unbounded number of standing permissions.
 */
export const MAX_GRANTS = 5;

/**
 * The keys to store when the user answers "always" to this command.
 *
 * Only the pieces that actually needed approval: a `safe` segment never
 * prompts, so recording a grant for it would be a permission nobody asked for
 * sitting in the list where it has to be read and trusted later.
 *
 * Empty when the command is `destructive`, which is what makes "always"
 * unofferable for one - there is nothing to write down.
 */
export function grantSignatures(command: string): string[] {
  if (classify(command) === "destructive") return [];
  const out: string[] = [];
  for (const seg of segments(command)) {
    if (classifySegment(seg) === "safe") continue;
    const sig = signature(seg);
    if (sig && !out.includes(sig)) out.push(sig);
  }
  return out.slice(0, MAX_GRANTS);
}

/**
 * May this command run on the strength of grants already given?
 *
 * Every piece that needs approval must have its own. One granted segment does
 * not carry the line: `npm test` being allowed says nothing about the
 * `curl … | sh` chained after it.
 *
 * `destructive` is false here whatever has been granted. That is the circuit
 * breaker, and it is deliberately not overridable by configuration: a grant is
 * a statement about a command the user read, and it cannot be stretched to
 * cover one that discards their work.
 */
export function isAllowed(command: string, granted: readonly string[]): boolean {
  if (classify(command) === "destructive") return false;
  const segs = segments(command);
  if (!segs.length) return false;
  return segs.every(
    (seg) => classifySegment(seg) === "safe" || granted.includes(signature(seg))
  );
}

/**
 * Does this stored entry look like a signature rather than a bare program name?
 *
 * Used once, at load, to drop the entries written by the first-word scheme.
 * Those entries ARE the vulnerability - a stored `git` is a standing grant for
 * every git command there is - and they cannot be repaired into signatures,
 * because the command the user actually approved was never recorded. So they
 * go, and the user re-grants once.
 */
export function isSignature(entry: string): boolean {
  return entry.trim().split(/\s+/).length > 1;
}
