/**
 * Applying the Genesis palette to VS Code's integrated terminal.
 *
 * The palette itself lives in `palette.ts` and knows nothing about VS Code;
 * this file is the part that touches settings, and it is separate for one
 * reason: writing into somebody's `settings.json` is the half that can do
 * damage, so it is small, and every decision in it is about not doing any.
 */
import * as fs from "node:fs";
import * as vscode from "vscode";
import { buildPalette, colorCustomizations, FONT_SETTINGS } from "./palette";

/** Where the previous values are parked so `revert` can put them back. */
const BACKUP_KEY = "genesis.terminalTheme.backup";

interface Backup {
  /** Colour ids we set, mapped to what was there before - or null if unset. */
  colors: Record<string, string | null>;
  /** Same, for the `terminal.integrated.*` settings. */
  fonts: Record<string, unknown>;
}

/** Read the shipped tokens out of the extension directory. */
function readTokens(extensionUri: vscode.Uri): string {
  const uri = vscode.Uri.joinPath(extensionUri, "media", "webview", "tokens.css");
  return fs.readFileSync(uri.fsPath, "utf8");
}

/**
 * Apply the palette and the font settings.
 *
 * TWO THINGS THIS IS CAREFUL ABOUT
 *
 * MERGE, DO NOT REPLACE. `workbench.colorCustomizations` is one object shared
 * by every extension and by the user's own overrides. Writing a fresh object
 * would silently delete whatever else was in it - somebody's editor
 * background, their bracket colours - and they would have no idea what did it
 * or how to get it back.
 *
 * RECORD WHAT WAS THERE. Only the keys this writes are recorded, and a key
 * that was unset is recorded as null rather than omitted, so revert can tell
 * "it was this colour" from "it was not set at all" and remove rather than
 * restore. Without that distinction reverting leaves debris behind.
 *
 * Global scope, not Workspace: a terminal theme is a preference about how the
 * editor looks, which follows the person rather than the project. Same choice
 * as `caBundlePath` in core/app.ts.
 */
export async function applyTerminalTheme(
  context: vscode.ExtensionContext
): Promise<{ colors: number; fonts: number }> {
  const palette = buildPalette(readTokens(context.extensionUri));
  const colors = colorCustomizations(palette);

  const wb = vscode.workspace.getConfiguration("workbench");
  const current = { ...(wb.get<Record<string, string>>("colorCustomizations") ?? {}) };

  const backup: Backup = { colors: {}, fonts: {} };
  for (const key of Object.keys(colors)) {
    backup.colors[key] = Object.prototype.hasOwnProperty.call(current, key)
      ? current[key]
      : null;
  }

  const term = vscode.workspace.getConfiguration();
  for (const key of Object.keys(FONT_SETTINGS)) {
    // `inspect` rather than `get`, so a setting the user never touched is
    // recorded as unset instead of as its default. Restoring a default into
    // settings.json is not restoring - it is leaving a new line behind.
    const seen = term.inspect(key);
    backup.fonts[key] = seen?.globalValue;
  }

  await context.globalState.update(BACKUP_KEY, backup);
  await wb.update(
    "colorCustomizations",
    { ...current, ...colors },
    vscode.ConfigurationTarget.Global
  );
  for (const [key, value] of Object.entries(FONT_SETTINGS)) {
    await term.update(key, value, vscode.ConfigurationTarget.Global);
  }
  return { colors: Object.keys(colors).length, fonts: Object.keys(FONT_SETTINGS).length };
}

/**
 * Put back exactly what was there.
 *
 * Returns false when there is nothing to undo, so the command can say so
 * rather than silently doing nothing - "I pressed it and nothing happened" is
 * the same experience as a broken button.
 */
export async function revertTerminalTheme(
  context: vscode.ExtensionContext
): Promise<boolean> {
  const backup = context.globalState.get<Backup>(BACKUP_KEY);
  if (!backup) return false;

  const wb = vscode.workspace.getConfiguration("workbench");
  const current = { ...(wb.get<Record<string, string>>("colorCustomizations") ?? {}) };
  for (const [key, was] of Object.entries(backup.colors)) {
    // null meant "not set before", so the key is removed rather than written
    // back as the string "null".
    if (was === null) delete current[key];
    else current[key] = was;
  }
  await wb.update("colorCustomizations", current, vscode.ConfigurationTarget.Global);

  const cfg = vscode.workspace.getConfiguration();
  for (const [key, was] of Object.entries(backup.fonts)) {
    // `undefined` clears the setting, which is what VS Code's own "reset
    // setting" does and is different from writing the default value.
    await cfg.update(key, was, vscode.ConfigurationTarget.Global);
  }

  await context.globalState.update(BACKUP_KEY, undefined);
  return true;
}
