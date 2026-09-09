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

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { log } from "#jobs/output";
import { contains, type Context, linkTarget, type Migration, type Platform } from "#migrations/migration";

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
  } catch (error) {
    // A tree with no migrations directory has no migrations, which is the same
    // answer as an empty one. Any other failure is a directory that exists and
    // could not be read, where an empty answer would silently skip the pending
    // cleanup rather than report it.
    if (!missing(error)) throw error;
    return [];
  }

  const found: Found[] = [];
  const seen = new Map<number, string>();
  for (const name of names) {
    const parsed = MIGRATION_FILENAME.exec(name);
    if (parsed === null) continue;

    const version = Number(parsed[1]);
    // Two migrations at one version cannot both be recorded, since the stamp is
    // a single number. Stamping the first would mark the second done without
    // running it, so the collision is refused rather than resolved.
    const clash = seen.get(version);
    if (clash !== undefined) throw new Error(`${name} and ${clash} share version ${version}`);
    seen.set(version, name);

    found.push({ version, name: parsed[2] ?? "", file: join(dir, name) });
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
  } catch (error) {
    // Only an absent file. A stamp that exists and cannot be read would
    // otherwise pass for absent, and an installed machine reading as unstamped
    // re-runs every migration it has already run.
    if (!missing(error)) throw error;
    return undefined;
  }

  // Checked before Number(), which reads a blank file as zero. A write cut
  // short by a crash or a full disk leaves exactly that, and zero would say
  // every migration is pending on a machine that has run them all.
  const trimmed = text.trim();
  const version = Number(trimmed);
  // A stamp nothing can read is worse than no stamp, because acting on it means
  // guessing what already ran. The caller stops rather than choosing.
  if (trimmed === "" || !Number.isInteger(version) || version < 0) {
    throw new Error(`unreadable version in ${path}`);
  }
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
// leaves in the home directory. `installed` holds every tree those links may
// point into, which is not just the tree this code was loaded from: ~/.dotfiles
// is the usual answer, and `dotfiles dev enable` repoints every link at a
// development worktree, so a machine in dev mode carries links into that
// worktree and none into ~/.dotfiles. Reading only one of them would take an
// installed machine for a fresh one and stamp past every pending cleanup.
//
// A link to a tree's own root is what bootstrap makes when ~/.dotfiles is a
// symlink to a checkout, and it exists before any topic is linked, so only a
// link to something inside a tree counts.
export function previouslyInstalled(home: string, config: string, installed: string[]): boolean {
  return [home, config].some((dir) => linksInto(dir, installed));
}

// Each directory is listed once and each link resolved once, then checked
// against every candidate root, rather than re-walking the directory per root.
// This runs on every machine every night whether or not anything is pending.
function linksInto(dir: string, installed: string[]): boolean {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    // Only an absent directory means no links. A directory that exists and
    // cannot be read would otherwise answer the same as a fresh machine, and
    // the stamp that follows would skip every pending cleanup for good.
    if (!missing(error)) throw error;
    return false;
  }

  for (const name of names) {
    const target = linkTarget(join(dir, name));
    if (target === undefined) continue;
    if (installed.some((root) => contains(root, target))) return true;
  }
  return false;
}

export interface RunOptions {
  // The tree the migrations are read from.
  root: string;
  // The file recording how far this machine has got.
  version: string;
  context: Context;
}

const PLATFORMS: Platform[] = ["darwin", "linux"];

function isPlatform(value: unknown): value is Platform {
  return PLATFORMS.some((platform) => platform === value);
}

export async function load(found: Found): Promise<Migration> {
  const module: Record<string, unknown> = await import(found.file);
  const up = module.up;
  if (typeof up !== "function") throw new Error(`${found.file} exports no up()`);

  // Anything but the two names would compare unequal to every platform and be
  // stamped past everywhere, so a typo would retire the migration on every
  // machine without running it once.
  const platform = module.platform;
  if (platform !== undefined && !isPlatform(platform)) {
    throw new Error(`${found.file} exports platform ${JSON.stringify(platform)}, not one of ${PLATFORMS.join(", ")}`);
  }

  return { up: up as Migration["up"], platform };
}

// Every failure leaves the stamp where it was, so nothing is recorded as done
// that did not run. The status is what scripts/install downgrades to a warning.
export async function run(options: RunOptions): Promise<number> {
  try {
    return await migrate(options);
  } catch (error) {
    log(options.context.out, "error", message(error));
    return 1;
  }
}

async function migrate(options: RunOptions): Promise<number> {
  const context = options.context;
  const { home, out } = context;
  const file = options.version;

  const found = discover(options.root);
  let current = readVersion(file);

  if (current === undefined) {
    if (!previouslyInstalled(home, context.config, context.installed)) {
      const latest = latestVersion(found);
      stampVersion(file, latest, current);
      log(out, "info", `fresh machine, stamping migrations at ${latest}`);
      return 0;
    }
    // Installed before, but from a tree that predates the runner. Everything
    // written so far is pending.
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

// The tree `dotfiles dev enable` repointed the symlinks at, read from the flag
// file zsh/active-root.zsh writes and reads. Without it a dev-enabled machine
// carries no link into ~/.dotfiles and would read as fresh, stamping past every
// pending cleanup. The running tree is not a substitute: the nightly job runs
// scripts/install out of ~/.dotfiles while the links still point at the
// worktree.
export function devRoot(home: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(join(home, ".dotfiles-dev-mode"), "utf8");
  } catch {
    return undefined;
  }
  return text.trim() || undefined;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
