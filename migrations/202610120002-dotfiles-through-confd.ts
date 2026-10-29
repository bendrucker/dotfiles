// mise now lays the config links, through ~/.config/mise/conf.d, and treats a
// link that already resolves to the right file as applied. The links
// install-symlinks made point straight into a tree, so a dev switch, which only
// repoints conf.d, would leave them behind. This reroutes each through conf.d,
// and removes the ones whose file is gone, which install-symlinks used to prune.
//
// EXPIRES: 2027-04-12 every machine has run scripts/install since the move

import { existsSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { log } from "#gum";
import { type Context, contains, exists, linkTarget } from "#migrations/migration";

export async function up(context: Context): Promise<void> {
  const confd = join(context.config, "mise", "conf.d");
  // Laid here rather than left to install-symlinks, so a link rerouted below
  // still resolves if that step fails tonight.
  if (!exists(confd)) {
    mkdirSync(dirname(confd), { recursive: true });
    symlinkSync(context.root, confd);
  }
  // A conf.d pointing at a removed worktree leaves nothing to reroute through.
  const linked = resolved(confd);
  if (linked === undefined) return;

  for (const link of candidates(context)) {
    const target = linkTarget(link);
    if (target === undefined) continue;
    // Only a tree conf.d resolves to, so a rerouted link opens the same file.
    // A link already through conf.d is done.
    const tree = context.installed.find((root) => root !== confd && contains(root, target) && resolved(root) === linked);
    if (tree === undefined) continue;

    if (!existsSync(target)) {
      rmSync(link);
      await log("info", `removed ${link}, whose ${target} is gone`);
      continue;
    }

    // Renamed over the old link, so the file is never missing in between.
    const next = `${link}.dotfiles-migrate`;
    rmSync(next, { force: true });
    symlinkSync(join(confd, relative(tree, target)), next);
    renameSync(next, link);
  }
}

// Where install-symlinks looked: dotfiles directly under the home directory,
// ~/.ssh, and everything under the config directory without following a link.
function candidates(context: Context): string[] {
  const home = list(context.home).filter((path) => path.startsWith(join(context.home, ".")));
  return [...home, ...list(join(context.home, ".ssh")), ...walk(context.config)];
}

function list(dir: string): string[] {
  try {
    return readdirSync(dir).map((name) => join(dir, name));
  } catch {
    return [];
  }
}

// Dirent types come from lstat, so a linked directory is never descended.
function walk(dir: string): string[] {
  try {
    return readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isSymbolicLink())
      .map((entry) => join(entry.parentPath, entry.name));
  } catch {
    return [];
  }
}

function resolved(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}
