// mise now lays the config links, through ~/.config/mise/conf.d, and treats a
// link that already resolves to the right file as applied. The links
// install-symlinks made point straight into a tree, so a dev switch, which only
// repoints conf.d, would leave them behind. This reroutes each through conf.d,
// and removes the ones whose file is gone, which install-symlinks used to prune.
//
// EXPIRES: 2027-04-12 every machine has run scripts/install since the move

import { existsSync, lstatSync, readdirSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { join, relative } from "node:path";
import { log } from "#jobs/output";
import { type Context, contains, linkTarget } from "#migrations/migration";

export function up(context: Context): void {
  const confd = join(context.config, "mise", "conf.d");

  for (const link of candidates(context)) {
    const target = linkTarget(link);
    if (target === undefined) continue;
    const tree = context.installed.find((root) => contains(root, target));
    if (tree === undefined) continue;

    if (!existsSync(target)) {
      rmSync(link);
      log(context.out, "info", `removed ${link}, whose ${target} is gone`);
      continue;
    }

    // Renamed over the old link, so the file is never missing in between.
    const next = `${link}.dotfiles-migrate`;
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

function walk(dir: string): string[] {
  return list(dir).flatMap((path) => (lstatSync(path).isDirectory() ? walk(path) : [path]));
}
