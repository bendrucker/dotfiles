// Nothing prunes a mise LaunchAgent whose module stops loading, and nothing
// prunes the config links under Application Support, so both go here. The
// captured history in that directory stays, since deleting it cannot be undone.
//
// EXPIRES: 2027-04-08 every machine has run scripts/install since the removal

import { rmSync } from "node:fs";
import { join } from "node:path";
import { type Context, exists, ownedLink, removeCask } from "#migrations/migration";

export const platform = "darwin";

export const AGENTS = ["dev.mise.activitywatch", "dev.mise.aw-import-screentime"];

export const LINKS = [
  join("aw-qt", "aw-qt.toml"),
  join("aw-import-screentime", "aw-import-screentime.toml"),
];

// The agents go first: aw-qt is KeepAlive, so it would respawn under a cask
// that is mid-uninstall. The cask goes last because removeCask throws.
export function up(context: Context): void {
  retireAgents(context);
  removeLinks(context);
  removeImporter(context);
  removeCask(context, "activitywatch");
}

function retireAgents(context: Context): void {
  const domain = `gui/${process.getuid?.() ?? 0}`;

  for (const label of AGENTS) {
    context.io.read(["launchctl", "bootout", `${domain}/${label}`]);

    const plist = join(context.home, "Library", "LaunchAgents", `${label}.plist`);
    if (!exists(plist)) continue;
    rmSync(plist);
    context.io.log("info", `retired ${label}`);
  }
}

function removeLinks(context: Context): void {
  const support = join(context.home, "Library", "Application Support", "activitywatch");

  for (const link of LINKS) {
    const path = join(support, link);
    if (!ownedLink(context, path)) continue;
    rmSync(path);
  }
}

function removeImporter(context: Context): void {
  if (!exists(join(context.data, "uv", "tools", "aw-import-screentime"))) return;

  const uv = Bun.which("uv", { PATH: process.env.PATH });
  if (uv === null) return;

  if (context.io.read([uv, "tool", "uninstall", "aw-import-screentime"]).status === 0) {
    context.io.log("info", "uninstalled aw-import-screentime");
  } else {
    context.io.log("warn", "could not uninstall aw-import-screentime: uv tool uninstall aw-import-screentime");
  }
}
