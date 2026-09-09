// What a migration is and what it is handed.
//
// A migration is transition work, not convergence. Convergence code describes
// the state every machine should be in and runs on every machine forever. A
// migration describes work only a machine that predates a change has left to
// do, so it runs once and is then deleted. Putting a one-time cleanup in the
// install path because it happens to be idempotent leaves the install
// describing a machine nobody has any more.
//
// A migration module exports `up` and, when the work only makes sense on one
// operating system, `platform`. Its version and its name come from its
// filename, so there is no constant to disagree with where the file sorts.

import { lstatSync, rmSync } from "node:fs";
import { relative, resolve } from "node:path";
import type { Output } from "#jobs/output";
import { log } from "#jobs/output";

// node:os platform values, which is what `process.platform` reports.
export type Platform = "darwin" | "linux";

// Every directory a migration reaches for arrives here rather than being read
// out of the environment, which is what lets a test hand one a sandbox and know
// nothing escaped it.
export interface Context {
  // The dotfiles tree the migration file came from.
  root: string;
  home: string;
  // $XDG_CONFIG_HOME and $XDG_DATA_HOME, already defaulted.
  config: string;
  data: string;
  platform: Platform;
  // Where the migration's own output goes, so it lands in the install log.
  out: Output;
}

export interface Migration {
  up(context: Context): void | Promise<void>;
  // Absent means every platform.
  platform?: Platform;
}

// A 3am `brew uninstall` that first spends a minute updating Homebrew is a
// minute the nightly job holds open for nothing.
const HOMEBREW_ENV = { HOMEBREW_NO_AUTO_UPDATE: "1", HOMEBREW_NO_ENV_HINTS: "1" };

// Uninstall a formula a Brewfile stopped declaring. Silent where brew is not
// installed or the formula already isn't, which is every machine but the one
// this migration exists for.
export function removeFormula(context: Context, name: string): void {
  const brew = Bun.which("brew", { PATH: process.env.PATH });
  if (brew === null) return;

  const env = { ...process.env, ...HOMEBREW_ENV };
  // --versions rather than plain `list`, which prints every file the formula
  // owns and would bury the log it shares with the rest of the install.
  if (context.out.read([brew, "list", "--versions", name], { env, stdin: "ignore" }).status !== 0) {
    return;
  }

  log(context.out, "info", `uninstalling ${name}`);
  if (context.out.run([brew, "uninstall", name], { env, stdin: "ignore" }) !== 0) {
    throw new Error(`brew uninstall ${name} failed`);
  }
}

// Remove a path a retired topic's installer created, if it is still there.
//
// Confined to the home directory the context names. This runs unattended as the
// user, so a migration that means to reach outside it says so by calling
// node:fs itself rather than by getting there through a typo here.
export function removeTree(context: Context, path: string): void {
  const target = resolve(path);
  const inside = relative(context.home, target);
  if (inside === "" || inside.startsWith("..") || resolve(context.home, inside) !== target) {
    throw new Error(`${target} is outside ${context.home}`);
  }

  if (!exists(target)) return;
  log(context.out, "info", `removing ${target}`);
  rmSync(target, { recursive: true, force: true });
}

// lstat rather than stat: a dangling symlink a retired topic left behind is
// still something to remove, and stat reports it as missing.
export function exists(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
}
