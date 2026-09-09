// Find the migrations a machine has not run, run them in order, and record how
// far it got.
//
// The crux is what an absent state file means. A machine with no record of any
// migration is a fresh one: it was installed after every migration in the tree
// was written, so it has none of the legacy state they clean up. It stamps the
// latest version and runs nothing. Only a machine that was already installed
// here has transition work to do.
//
// "Already installed" is a question the state file cannot answer the first time
// this runs, since no machine has the file yet. The answer comes from the
// symlinks instead: a machine scripts/install has run on before carries links
// from its home directory into the installed tree, and a fresh one carries
// none. That reading is only available before scripts/install lays the links
// down, which is where the runner sits.

import { lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { log } from "#jobs/output";
import type { Context, Migration } from "#migrations/migration";

export const MIGRATIONS_DIR = "migrations";

// `YYYYMMDDNNNN-slug.ts`. The version orders the run and the slug names it in
// the log, so neither is repeated inside the file where it could disagree with
// where the file sorts. The pattern also decides what is a migration at all,
// which is what keeps the `.test.ts` sitting beside each one from being loaded
// and run as one: the extra dot does not match.
export const MIGRATION_FILENAME = /^(\d{12})-([a-z0-9-]+)\.ts$/;

export interface Found {
  version: number;
  name: string;
  file: string;
}

export function discover(root: string): Found[] {
  const dir = join(root, MIGRATIONS_DIR);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    // A tree with no migrations directory has no migrations, which is the same
    // answer as an empty one.
    return [];
  }

  const found: Found[] = [];
  for (const name of names) {
    const parsed = MIGRATION_FILENAME.exec(name);
    if (parsed === null) continue;
    found.push({ version: Number(parsed[1]), name: parsed[2] ?? "", file: join(dir, name) });
  }
  return found.sort((a, b) => a.version - b.version);
}

export function latestVersion(found: Found[]): number {
  return found.reduce((highest, migration) => Math.max(highest, migration.version), 0);
}

// Where the stamp lives on a real machine. The runner is handed the path
// rather than deriving it, so a case can point one at a sandbox without the
// XDG variables this machine happens to export reaching past it.
export function versionFile(home: string): string {
  return join(stateHome(home), "dotfiles", "migration-version");
}

export function stateHome(home: string): string {
  return process.env.XDG_STATE_HOME || join(home, ".local", "state");
}

export function configHome(home: string): string {
  return process.env.XDG_CONFIG_HOME || join(home, ".config");
}

export function dataHome(home: string): string {
  return process.env.XDG_DATA_HOME || join(home, ".local", "share");
}

// Absent is not zero. Zero would mean every migration is pending, and absent
// means nobody has asked this machine yet.
export function readVersion(path: string): number | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }

  const version = Number(text.trim());
  // A stamp nothing can read is worse than no stamp, because acting on it means
  // guessing what already ran. The caller stops rather than choosing.
  if (!Number.isInteger(version) || version < 0) throw new Error(`unreadable version in ${path}`);
  return version;
}

// Written after each migration rather than once at the end, so a run that
// breaks part way keeps the ones that finished and retries only the rest.
// Never backwards: deleting the newest migration lowers the latest version, and
// a machine already past it has not un-run anything.
export function stampVersion(path: string, version: number, current: number | undefined): void {
  if (current !== undefined && version <= current) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${version}\n`);
}

// Whether scripts/install has run on this machine before, read off the links it
// leaves in the home directory. `installed` is the tree those links point into
// (~/.dotfiles), which is not necessarily the tree this code was loaded from: a
// hand run out of a worktree is still asking about the machine.
//
// A link to the tree's own root is what bootstrap makes when ~/.dotfiles is a
// symlink to a checkout, and it exists before any topic is linked, so only a
// link to something inside the tree counts.
export function previouslyInstalled(home: string, config: string, installed: string): boolean {
  return [home, config].some((root) => linksInto(root, installed));
}

function linksInto(dir: string, installed: string): boolean {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return false;
  }

  for (const name of names) {
    const path = join(dir, name);
    if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() !== true) continue;

    let target: string;
    try {
      target = readlinkSync(path);
    } catch {
      continue;
    }

    const resolved = isAbsolute(target) ? target : resolve(dir, target);
    const inside = relative(installed, resolved);
    if (inside !== "" && !inside.startsWith("..") && !isAbsolute(inside)) return true;
  }
  return false;
}

export interface RunOptions {
  // The tree the migrations are read from.
  root: string;
  // The tree the machine has installed, which is what says whether it is fresh.
  installed: string;
  // The file recording how far this machine has got.
  version: string;
  context: Context;
}

export async function load(found: Found): Promise<Migration> {
  const module = (await import(found.file)) as Partial<Migration>;
  if (typeof module.up !== "function") throw new Error(`${found.file} exports no up()`);
  return { up: module.up, platform: module.platform };
}

export async function run(options: RunOptions): Promise<number> {
  const context = options.context;
  const { home, out } = context;
  const found = discover(options.root);
  const file = options.version;

  let current: number | undefined;
  try {
    current = readVersion(file);
  } catch (error) {
    log(out, "error", message(error));
    return 1;
  }

  if (current === undefined) {
    if (!previouslyInstalled(home, context.config, options.installed)) {
      const latest = latestVersion(found);
      stampVersion(file, latest, current);
      log(out, "info", `fresh machine, stamping migrations at ${latest}`);
      return 0;
    }
    // Installed before, but from a tree that predates the runner. Everything
    // written so far is pending, which is the whole point of shipping it.
    current = 0;
  }

  const pending = found.filter((migration) => migration.version > current);
  if (pending.length === 0) return 0;

  for (const entry of pending) {
    let migration: Migration;
    try {
      migration = await load(entry);
    } catch (error) {
      log(out, "error", `migration ${entry.version} ${entry.name}: ${message(error)}`);
      return 1;
    }

    // A migration this platform will never run is stamped rather than left
    // pending, or every later run would reconsider it forever.
    if (migration.platform !== undefined && migration.platform !== context.platform) {
      stampVersion(file, entry.version, current);
      current = entry.version;
      continue;
    }

    log(out, "info", `running migration ${entry.version} ${entry.name}`);
    try {
      await migration.up(context);
    } catch (error) {
      // The stamp stays where it was, so the next install retries this one and
      // the ones behind it. Stopping rather than carrying on keeps the order a
      // promise: a later migration may assume this one finished.
      log(out, "error", `migration ${entry.version} ${entry.name} failed: ${message(error)}`);
      return 1;
    }

    stampVersion(file, entry.version, current);
    current = entry.version;
  }

  return 0;
}

export function defaultHome(): string {
  return process.env.HOME || homedir();
}

export function installedRoot(home: string): string {
  return process.env.DOTFILES_HOME || join(home, ".dotfiles");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
