// herdr and moshi write ~/.claude/settings.json by replacing it, which leaves
// Claude reading a file the repo no longer reaches.

import { $ } from "bun";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "#gum";
import { canonicalJson } from "#jobs/json";
import { managedOutranked } from "./user-tier";

export const SETTINGS = "user/settings.json";

const CLAUDE_INSTALL = join(import.meta.dir, "install.sh");

function settingsLink(): string {
  return join(process.env.HOME || homedir(), ".claude", "settings.json");
}

// A file that is not a symlink, which is what a replace-and-rename leaves.
export function settingsReplaced(): boolean {
  return isRegularFile(settingsLink());
}

function isRegularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

// What the replacement changed goes into the working copy, where the gate and
// the reverts can see it, before relinking discards the file. A working copy
// that already differs from HEAD is not overwritten.
export async function adoptReplacedSettings(repoDir: string): Promise<void> {
  // There the file is user-tier.ts's own output, regenerated on relink.
  if (!settingsReplaced() || managedOutranked()) return;
  const link = settingsLink();

  const working = join(repoDir, SETTINGS);
  const replaced = readText(link);
  const canonical = await canonicalJson(replaced);
  if (canonical === undefined) {
    await log("warn", "Discarding the replaced ~/.claude/settings.json: it is not readable JSON");
    return;
  }
  if (canonical === (await canonicalJson(readText(working)))) return;

  // A status that could not run is read as dirty, since adopting overwrites.
  const status = await $`git status --porcelain -- ${SETTINGS} < /dev/null`.cwd(repoDir).nothrow().quiet();
  if (status.exitCode !== 0 || status.stdout.toString() !== "") {
    await log("warn", `Discarding the replaced ~/.claude/settings.json: ${SETTINGS} already has local changes`);
    return;
  }

  await log("warn", `Moving the replaced ~/.claude/settings.json into ${SETTINGS}`);
  try {
    writeFileSync(working, replaced);
  } catch (error) {
    await log("warn", `Could not write ${SETTINGS}: ${String(error)}`);
  }
}

export async function relinkClaudeHome(
  repoDir: string,
  env: Record<string, string | undefined> = process.env,
): Promise<boolean> {
  const status = await $`bash -c ${'. "$1" && install_claude_symlinks'} bash ${CLAUDE_INSTALL} < /dev/null`
    .env({ ...env, CLAUDE_REPO_HOME: repoDir })
    .nothrow();
  if (status.exitCode !== 0) {
    await log("warn", "Could not relink ~/.claude");
    return false;
  }
  return true;
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}
