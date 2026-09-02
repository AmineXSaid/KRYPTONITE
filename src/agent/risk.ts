/**
 * How much a shell command can cost, decided before it runs.
 *
 * This does NOT decide whether a command is allowed. `App.commandIsAlwaysAllowed`
 * owns that, by exact match on the whole normalised line and never when the
 * line holds a shell metacharacter, and it is stricter than anything here.
 * This answers the question that sits above it: some commands must be asked
 * about however the modes and grants read, and some are not worth asking about
 * at all.
 *
 * Both halves matter, and they are the same idea seen from two ends. A
 * `destructive` verdict cannot be auto-approved, because a permission mode
 * expresses how much the user wants to be interrupted and that is not an
 * opinion about whether their uncommitted work should survive. A `safe` one is
 * never asked about, because prompts that fire on `git status` are exactly what
 * train someone to approve without reading, and the prompt that then goes
 * unread is the one on `git reset --hard`.
 *
 * The judgement is made on SEGMENTS rather than whole lines. That is the single
 * most important property in this file: a rule reading a whole line is defeated
 * by appending to it, so every separator-delimited piece is judged on its own
 * and the line is only as good as its worst piece.
 *
 * Pure, and depends on nothing, so `test/risk.ts` drives it directly.
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
  /^\s*git\b.*\bfilter-branch\b/i,
  /* Discarding the working tree, which is the case most often missed.
   *
   * `git checkout .` and `git restore .` throw away every uncommitted change
   * in one word and print nothing on the way. They were `write` until this
   * line, which meant full-auto ran them silently - the same loss as
   * `reset --hard` with none of the vocabulary that makes it look dangerous.
   *
   * `restore --staged` alone only unstages, so it is spared; `restore` with a
   * worktree target is not. `stash drop` and `stash clear` delete the very
   * thing a cautious person made to avoid this. */
  /^\s*git\b.*\bcheckout\b\s+(--\s|\.|\*)/i,
  /^\s*git\b.*\bcheckout\b\s+(-f|--force)\b/i,
  /^\s*git\b.*\brestore\b(?!.*--staged\s*$)/i,
  /^\s*git\b.*\bstash\b\s+(drop|clear)\b/i,
  /^\s*git\b.*\brm\b/i,
  // Emptying a file in place. No flag reads as dangerous, and the content is
  // gone the moment it returns.
  /^\s*truncate\b.*\s-s\s*0\b/i,
  /^\s*(cp|mv)\b.*\s(-f|--force)\b/i,
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
 * A removal aimed somewhere nothing should be removed from.
 *
 * The patterns above ask what FLAGS a command carries, and that is the wrong
 * question for this case: `rmdir /usr` and `rm ~/.ssh/id_rsa` carry no `-rf`
 * and were classified `write`, which in full-auto means they ran with no card.
 * The danger is in the target, not the spelling.
 *
 * So this asks where the removal points, and treats these as critical:
 *
 *   /                     the filesystem root
 *   /usr, /etc, /data …   any direct child of it
 *   ~ and everything      the home directory
 *   under it
 *   C:\ , C:\Windows      a Windows drive root and its top level
 *   .. and beyond         climbing out of the working directory
 *
 * The first, second, fourth and fifth mirror the rule Claude Code lets no
 * allow-rule and no hook override, for the reason it states: a circuit breaker
 * against the model being wrong, not a judgement about the user.
 *
 * The home rule is deliberately WIDER here than there, and the difference is
 * Genesis's own recovery model. `ShadowRepo` snapshots the workspace, so a
 * removal inside it has something to be restored from and a removal in `~` has
 * nothing. `rm ~/notes.md` is one word, looks like nothing, and is final. When
 * the workspace itself lives under `~` this costs a prompt on a file that was
 * recoverable after all, which is the cheap side of the trade.
 *
 * Nothing is expanded or resolved: `~` is home whatever the shell would make
 * of it, and a path is read as written. Guessing is not required - anything
 * unrecognised stays `write` and simply asks.
 */
const CRITICAL_TARGET = [
  // Absolute: the root itself, or one segment below it. `/usr/local/lib` is
  // deep enough to be ordinary; `/usr` is not.
  /^\/?$/,
  /^\/[^/]+\/?$/,
  // Home, and anything at all beneath it. See the note above on why this is
  // wider than the rest: outside the workspace there is no checkpoint.
  /^~($|[\\/])/,
  /^\$HOME($|[\\/])/i,
  // A Windows drive root and its top level.
  /^[a-z]:[\\/]?$/i,
  /^[a-z]:[\\/][^\\/]+[\\/]?$/i,
  // Climbing out of the workspace. `.` and `./x` stay ordinary; `..` does not.
  /^\.\.($|[\/\\])/,
];

/** Programs whose whole purpose is to remove what they are pointed at. */
const REMOVER = /^\s*(sudo\s+)?(rm|rmdir|unlink|shred|trash)\b/i;

/**
 * Does this segment remove something at a path nothing should be removed from?
 *
 * Flags are stripped before the targets are read, so `-rf` neither triggers
 * this nor hides from it - the question here is only where it points.
 */
function targetsCriticalPath(seg: string): boolean {
  if (!REMOVER.test(seg)) return false;
  const args = (seg.match(/"[^"]*"|'[^']*'|\S+/g) ?? [])
    .slice(1)
    .map((a) => a.replace(/^['"]|['"]$/g, ""))
    .filter((a) => a && !a.startsWith("-"));
  return args.some((a) => CRITICAL_TARGET.some((re) => re.test(a)));
}

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
  // Asked separately because it reads the TARGET rather than the flags, which
  // is the only way `rmdir /usr` is caught at all.
  if (targetsCriticalPath(seg)) return "destructive";

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
