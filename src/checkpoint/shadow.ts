import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pexec = promisify(execFile);

/**
 * A second git repository whose work tree is the user's workspace and whose
 * .git lives elsewhere. Snapshots every agent turn without touching the real
 * repo, its index, its history, or its hooks.
 */
export class ShadowRepo {
  private git: string;
  private ready = false;

  constructor(private root: string, storage: string) {
    this.git = path.join(storage, "shadow", encodeURIComponent(root));
  }

  private async run(args: string[]): Promise<string> {
    const { stdout } = await pexec(
      "git",
      ["--git-dir", this.git, "--work-tree", this.root, ...args],
      { cwd: this.root, maxBuffer: 32 * 1024 * 1024 }
    );
    return stdout;
  }

  async init(): Promise<void> {
    if (this.ready) return;
    if (!fs.existsSync(this.git)) {
      fs.mkdirSync(this.git, { recursive: true });
      await pexec("git", ["--git-dir", this.git, "init", "--bare"]);
      await this.run(["config", "core.excludesFile", ""]);
      await this.run(["config", "user.email", "kryptonite@localhost"]);
      await this.run(["config", "user.name", "Kryptonite"]);
      // Respect the user's .gitignore so we don't snapshot node_modules.
      const info = path.join(this.git, "info");
      fs.mkdirSync(info, { recursive: true });
      fs.writeFileSync(path.join(info, "exclude"), "node_modules/\ndist/\nout/\n.venv/\n");
    }
    this.ready = true;
  }

  async snapshot(label: string): Promise<string | undefined> {
    await this.init();
    await this.run(["add", "-A"]);
    try {
      await this.run(["commit", "-m", label, "--allow-empty"]);
    } catch {
      return undefined;
    }
    return (await this.run(["rev-parse", "HEAD"])).trim();
  }

  async list(limit = 30): Promise<{ hash: string; label: string; when: string }[]> {
    await this.init();
    let out: string;
    try {
      out = await this.run(["log", `-${limit}`, "--format=%H%x00%s%x00%ar"]);
    } catch {
      return [];
    }
    return out
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [hash, label, when] = l.split("\0");
        return { hash, label, when };
      });
  }

  /** What a restore would change, so the user can see before committing to it. */
  async diff(hash: string): Promise<string> {
    await this.init();
    return this.run(["diff", "--stat", hash]);
  }

  async restore(hash: string): Promise<void> {
    await this.init();
    await this.run(["checkout", hash, "--", "."]);
  }

  // CHANGED: added. Per-file line counts since `from`, used to label each
  // diff card. Binary files report `-` for both columns in numstat; they
  // become 0/0 rather than NaN.
  async numstat(from: string): Promise<{ file: string; added: number; removed: number }[]> {
    await this.init();
    let out: string;
    try {
      out = await this.run(["diff", "--numstat", from]);
    } catch {
      return [];
    }
    const rows: { file: string; added: number; removed: number }[] = [];
    for (const line of out.split("\n")) {
      if (!line.trim()) continue;
      const parts = line.split("\t");
      if (parts.length < 3) continue;
      const [a, r, ...rest] = parts;
      rows.push({
        // A rename shows as `old => new`; the last tab-separated field is the
        // path git would act on, which is what the diff card needs.
        file: rest.join("\t"),
        added: a === "-" ? 0 : Number(a) || 0,
        removed: r === "-" ? 0 : Number(r) || 0,
      });
    }
    return rows;
  }

  // CHANGED: added. Restores one file to its state at `from`, leaving every
  // other change in the turn intact. Throws when the path did not exist at
  // `from` — the caller treats that as "the agent created it" and deletes it.
  async restoreFile(from: string, relPath: string): Promise<void> {
    await this.init();
    await this.run(["checkout", from, "--", relPath]);
  }

  // CHANGED: added. Raw unified patch for one file, shown inside its diff card.
  async fileDiff(from: string, relPath: string): Promise<string> {
    await this.init();
    try {
      return await this.run(["diff", from, "--", relPath]);
    } catch {
      return "";
    }
  }
}
