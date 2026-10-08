// Vibe Island's SSH remote deploy rewrites the Claude hooks of the machine it
// deploys to, with no preference to stop it. Every hook event fails once that
// remote agent is gone, so bin/claude-sync discards the rewrite before its gate.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, parseJson } from "#jobs/json";
import { log, type Output } from "#jobs/output";
import { notify } from "#jobs/report";

const REMOTE_HOOK = "vibe-island/bin/vibe-island-hook";

// True only when every hook command the committed file lacks is Vibe Island's
// and nothing outside .hooks moved, so an edit of anyone else's rides along to
// the gate rather than being discarded with it.
export function isRemoteHookRewrite(committed: string, working: string): boolean {
  const known = new Set(hookCommands(parseJson(committed)));
  const added = hookCommands(parseJson(working)).filter((command) => !known.has(command));
  if (added.length === 0 || !added.every(isRemoteHook)) return false;

  const rest = canonicalJson(working, "del(.hooks)");
  return rest !== undefined && rest === canonicalJson(committed, "del(.hooks)");
}

// Restores `file` to HEAD when its working copy holds a remote hook rewrite.
export function revertRemoteHookRewrite(out: Output, repoDir: string, file: string, title: string): void {
  const committed = out.read(["git", "-C", repoDir, "show", `HEAD:${file}`]);
  if (committed.status !== 0) return;
  if (!isRemoteHookRewrite(committed.stdout, readText(join(repoDir, file)))) return;

  log(out, "warn", `Reverting Vibe Island's remote hook rewrite in ${file}`);
  if (out.run(["git", "-C", repoDir, "checkout", "HEAD", "--", file]) !== 0) {
    log(out, "warn", `Could not revert ${file}`);
    return;
  }
  notify(title, "Reverted Vibe Island's remote hook rewrite in settings.json");
}

function isRemoteHook(command: unknown): boolean {
  return typeof command === "string" && command.includes(REMOTE_HOOK);
}

function hookCommands(settings: unknown): unknown[] {
  if (!isRecord(settings)) return [];

  const commands: unknown[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (!isRecord(node)) return;
    if (node.command !== undefined) commands.push(node.command);
    for (const value of Object.values(node)) walk(value);
  };

  walk(settings.hooks);
  return commands;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}
