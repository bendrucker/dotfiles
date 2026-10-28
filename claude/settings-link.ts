// herdr and moshi write ~/.claude/settings.json by replacing it, which leaves
// Claude reading a file the repo no longer reaches.

import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { canonicalJson } from "#jobs/json";
import type { Io } from "#io";
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
export function adoptReplacedSettings(out: Io, repoDir: string): void {
  // There the file is user-tier.ts's own output, regenerated on relink.
  if (!settingsReplaced() || managedOutranked()) return;
  const link = settingsLink();

  const working = join(repoDir, SETTINGS);
  const replaced = readText(link);
  const canonical = canonicalJson(out, replaced);
  if (canonical === undefined) {
    out.log("warn", "Discarding the replaced ~/.claude/settings.json: it is not readable JSON");
    return;
  }
  if (canonical === canonicalJson(out, readText(working))) return;

  // A status that could not run is read as dirty, since adopting overwrites.
  const status = out.read(["git", "status", "--porcelain", "--", SETTINGS], {
    cwd: repoDir,
    stdin: "ignore",
    stderr: "ignore",
  });
  if (status.status !== 0 || status.stdout !== "") {
    out.log("warn", `Discarding the replaced ~/.claude/settings.json: ${SETTINGS} already has local changes`);
    return;
  }

  out.log("warn", `Moving the replaced ~/.claude/settings.json into ${SETTINGS}`);
  try {
    writeFileSync(working, replaced);
  } catch (error) {
    out.log("warn", `Could not write ${SETTINGS}: ${String(error)}`);
  }
}

export function relinkClaudeHome(
  out: Io,
  repoDir: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const status = out.run(
    ["bash", "-c", '. "$1" && install_claude_symlinks', "bash", CLAUDE_INSTALL],
    { env: { ...env, CLAUDE_REPO_HOME: repoDir }, stdin: "ignore" },
  );
  if (status !== 0) {
    out.log("warn", "Could not relink ~/.claude");
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
