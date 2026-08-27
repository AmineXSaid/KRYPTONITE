/**
 * Writing the commit message from what is staged.
 *
 * Reached through the built-in Git extension's API rather than by shelling out
 * to `git`. Shelling out looks simpler and is wrong in the cases that matter:
 * it does not know which repository the user is looking at in a multi-root
 * workspace, it does not know about worktrees, and it cannot put text in the
 * commit box, which is the entire point.
 *
 * Staged changes only, deliberately. "Write a message for everything I have
 * touched" describes a commit the user has not decided to make yet, and the
 * moment they stage a subset the message would be wrong.
 */

import * as vscode from "vscode";
import type { App } from "../core/app";
import { capDiff, cleanCommitMessage } from "../agent/oneShot";
import { commitPrompt } from "../agent/editPrompts";

/** The slice of the git extension's API this uses. */
interface GitRepository {
  rootUri: vscode.Uri;
  inputBox: { value: string };
  state: { indexChanges: { uri: vscode.Uri }[] };
  diff(cached?: boolean): Promise<string>;
}
interface GitApi {
  repositories: GitRepository[];
}

function gitApi(): GitApi | undefined {
  const ext = vscode.extensions.getExtension<{ getAPI(v: number): GitApi }>("vscode.git");
  // `isActive` matters: the git extension activates lazily, and on a cold
  // window this runs before it has. `exports` is undefined until then.
  if (!ext) return undefined;
  try {
    return ext.isActive ? ext.exports.getAPI(1) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Which repository the message is for.
 *
 * The one the SCM view passed us, else the one holding the active file, else
 * the only one there is. Guessing in a multi-root workspace would write the
 * message into the wrong box, which is worse than asking.
 */
async function pickRepo(api: GitApi, hint?: any): Promise<GitRepository | undefined> {
  const repos = api.repositories;
  if (!repos.length) return undefined;

  const fromHint = hint?.rootUri
    ? repos.find((r) => r.rootUri.toString() === String(hint.rootUri))
    : undefined;
  if (fromHint) return fromHint;

  const active = vscode.window.activeTextEditor?.document.uri;
  if (active) {
    // Longest root wins, so a nested repository beats the parent that contains it.
    const inside = repos
      .filter((r) => active.toString().startsWith(r.rootUri.toString()))
      .sort((a, b) => b.rootUri.toString().length - a.rootUri.toString().length);
    if (inside[0]) return inside[0];
  }

  if (repos.length === 1) return repos[0];

  const pick = await vscode.window.showQuickPick(
    repos.map((r) => ({ label: vscode.workspace.asRelativePath(r.rootUri), repo: r })),
    { title: "Which repository?" }
  );
  return pick?.repo;
}

export function registerCommitMessage(app: App): vscode.Disposable {
  return vscode.commands.registerCommand("genesis.generateCommitMessage", async (hint?: any) => {
    const api = gitApi();
    if (!api) {
      void vscode.window.showWarningMessage(
        "Genesis: the built-in Git extension is not available in this window."
      );
      return;
    }

    const repo = await pickRepo(api, hint);
    if (!repo) {
      void vscode.window.showWarningMessage("Genesis: no Git repository here.");
      return;
    }

    const staged = repo.state.indexChanges ?? [];
    if (!staged.length) {
      // Naming the fix matters. "Nothing staged" reads as a bug to someone who
      // has 40 modified files in front of them.
      void vscode.window.showInformationMessage(
        "Genesis: nothing is staged. Stage the changes you want to commit first."
      );
      return;
    }

    const raw = await repo.diff(true);
    if (!raw.trim()) {
      void vscode.window.showInformationMessage("Genesis: the staged change has no diff to read.");
      return;
    }
    const capped = capDiff(raw);

    try {
      const answer = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.SourceControl, title: "Writing a commit message" },
        () =>
          app.oneShot(
            commitPrompt({
              diff: capped.text,
              files: staged.map((c) => vscode.workspace.asRelativePath(c.uri)),
              truncated: capped.truncated,
              dropped: capped.dropped,
            }),
            { maxTokens: 512 }
          )
      );

      const message = cleanCommitMessage(answer);
      if (!message) {
        void vscode.window.showWarningMessage("Genesis: the model returned an empty message.");
        return;
      }
      // Replacing rather than appending. A half-typed message the user wants to
      // keep is the argument for appending, but appending to an empty box leaves
      // a leading newline in every commit, and that is the common case.
      repo.inputBox.value = message;
    } catch (e: any) {
      void vscode.window.showErrorMessage(`Genesis: ${String(e?.message ?? e)}`);
    }
  });
}
