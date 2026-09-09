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

import { lstatSync, readdirSync, readlinkSync, rmSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
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
  // The dotfiles trees this machine's symlinks may point into. The runner reads
  // these to tell a fresh machine from an installed one, and a migration reads
  // them to tell a link this repo made from one someone else did.
  installed: string[];
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
// Confined to the directories the context names, which is every directory this
// repo installs into. XDG_CONFIG_HOME and XDG_DATA_HOME are allowed to sit
// outside the home directory, so confining to home alone would reject a path a
// migration legitimately owns and strand every migration behind it. This runs
// unattended as the user, so a migration meaning to reach anywhere else says so
// by calling node:fs itself rather than getting there through a typo here.
export function removeTree(context: Context, path: string): void {
  const target = resolve(path);
  const roots = [context.home, context.config, context.data];
  // Refused separately from the containment test below, because the roots may
  // nest: an XDG variable pointing at an ancestor of the home directory would
  // otherwise make the home directory itself a legal target.
  if (roots.some((root) => resolve(root) === target)) {
    throw new Error(`${target} is one of ${roots.join(", ")}`);
  }
  if (!roots.some((root) => contains(root, target))) {
    throw new Error(`${target} is outside ${roots.join(", ")}`);
  }

  if (!exists(target)) return;
  log(context.out, "info", `removing ${target}`);
  rmSync(target, { recursive: true, force: true });
}

// Strictly under, so a root can never remove itself.
export function contains(root: string, target: string): boolean {
  const inside = relative(root, target);
  return inside !== "" && !inside.startsWith("..") && !isAbsolute(inside);
}

// Where a symlink points, absolute, or undefined if it is not a symlink. A
// relative target resolves against the directory holding the link rather than
// the working directory.
export function linkTarget(path: string): string | undefined {
  let target: string;
  try {
    target = readlinkSync(path);
  } catch {
    return undefined;
  }

  return isAbsolute(target) ? target : resolve(dirname(path), target);
}

// Whether a path is a symlink this repo made, rather than one someone else
// pointed somewhere of their own. A retired topic's link is only this
// migration's to remove while it still resolves into a dotfiles tree.
export function ownedLink(context: Context, path: string): boolean {
  const target = linkTarget(path);
  if (target === undefined) return false;
  return context.installed.some((root) => contains(root, target));
}

// A directory a `mkdir -p` left behind holds nothing. Anything in it arrived
// some other way, and removing it would take work this migration never made.
export function isEmpty(path: string): boolean {
  try {
    return readdirSync(path).length === 0;
  } catch {
    return false;
  }
}

// lstat rather than stat: a dangling symlink a retired topic left behind is
// still something to remove, and stat reports it as missing.
export function exists(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
}
