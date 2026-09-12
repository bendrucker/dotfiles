// vim-tmux-navigator left neovim/config/init.lua with the tmux topic, but
// nothing uninstalled it. vim.pack reconciles the lockfile against the plugin
// directory on every startup: a directory with no lock entry is repaired back
// in, and a lock entry with no directory is reinstalled, so removing either
// half alone puts the plugin back.
//
// The repair rewrote the lockfile, which is tracked and lands in the repo
// through the neovim/config symlink, and the sync gate skipped every night on
// the dirty tree.
//
// EXPIRES: 2027-03-11 every machine has run scripts/install since the tmux removal

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "#jobs/output";
import { type Context, removeTree } from "#migrations/migration";

const PLUGIN = "vim-tmux-navigator";

export function up(context: Context): void {
  removeTree(context, join(context.data, "nvim", "site", "pack", "core", "opt", PLUGIN));
  removeLockEntry(context, join(context.config, "nvim", "nvim-pack-lock.json"));
}

// Written back the way vim.pack writes it - keys sorted at every depth,
// two-space indent, trailing newline - so a lockfile differing from the tracked
// one only by this entry comes back byte-identical to it.
function removeLockEntry(context: Context, path: string): void {
  const lock = readLock(path);
  if (lock === undefined) return;

  const plugins = lock.plugins;
  if (!isObject(plugins) || !(PLUGIN in plugins)) return;

  delete plugins[PLUGIN];
  log(context.out, "info", `removing ${PLUGIN} from ${path}`);
  writeFileSync(path, `${JSON.stringify(sortKeys(lock), null, 2)}\n`);
}

// A lockfile that does not parse is left for nvim to repair. Rewriting it from
// what little we could read would drop the revisions it exists to pin.
function readLock(path: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
  return isObject(parsed) ? parsed : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
}
