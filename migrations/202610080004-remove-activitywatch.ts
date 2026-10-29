// Nothing prunes a mise LaunchAgent whose module stops loading, and nothing
// prunes the config links under Application Support, so both go here. The
// captured history in that directory stays, since deleting it cannot be undone.
//
// EXPIRES: 2027-04-08 every machine has run scripts/install since the removal

import { $ } from "bun";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { log } from "#gum";
import { type Context, exists, ownedLink, removeCask } from "#migrations/migration";

export const platform = "darwin";

export const AGENTS = ["dev.mise.activitywatch", "dev.mise.aw-import-screentime"];

export const LINKS = [
  join("aw-qt", "aw-qt.toml"),
  join("aw-import-screentime", "aw-import-screentime.toml"),
];

// The agents go first: aw-qt is KeepAlive, so it would respawn under a cask
// that is mid-uninstall. The cask goes last because removeCask throws.
export async function up(context: Context): Promise<void> {
  await retireAgents(context);
  removeLinks(context);
  await removeImporter(context);
  await removeCask("activitywatch");
}

async function retireAgents(context: Context): Promise<void> {
  const domain = `gui/${process.getuid?.() ?? 0}`;

  for (const label of AGENTS) {
    const target = `${domain}/${label}`;
    await $`launchctl bootout ${target} 2> ${Bun.stderr}`.nothrow().quiet();

    const plist = join(context.home, "Library", "LaunchAgents", `${label}.plist`);
    if (!exists(plist)) continue;
    rmSync(plist);
    await log("info", `retired ${label}`);
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

async function removeImporter(context: Context): Promise<void> {
  if (!exists(join(context.data, "uv", "tools", "aw-import-screentime"))) return;

  const uv = Bun.which("uv", { PATH: process.env.PATH });
  if (uv === null) return;

  if ((await $`${uv} tool uninstall aw-import-screentime 2> ${Bun.stderr}`.nothrow().quiet()).exitCode === 0) {
    await log("info", "uninstalled aw-import-screentime");
  } else {
    await log("warn", "could not uninstall aw-import-screentime: uv tool uninstall aw-import-screentime");
  }
}
