// The LaunchAgents moved into mise, which labels them dev.mise.<name>. The old
// jobs are torn down here, before the topic installers load their replacements,
// so tailgate and aw-qt each run as a single copy throughout. A leftover plist
// would load again at next login, so each one is deleted as well.
//
// EXPIRES: 2027-04-08 every machine has run scripts/install since the move

import { $ } from "bun";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { log } from "#gum";
import { type Context, exists } from "#migrations/migration";

export const platform = "darwin";

export const RETIRED = [
  "com.user.theme-sync",
  "com.user.activitywatch",
  "com.user.aw-import-screentime",
  "com.user.claude-sync",
  "com.user.worktree-prune",
  "me.bendrucker.tailgate",
  // Renamed before this move, and still cleaned up by the install path until now.
  "com.user.dotfiles-sync",
  "com.user.claude-upgrade",
];

export async function up(context: Context): Promise<void> {
  const domain = `gui/${process.getuid?.() ?? 0}`;

  for (const label of RETIRED) {
    const target = `${domain}/${label}`;
    await $`launchctl bootout ${target} 2> ${Bun.stderr}`.nothrow().quiet();

    const plist = join(context.home, "Library", "LaunchAgents", `${label}.plist`);
    if (!exists(plist)) continue;
    rmSync(plist);
    await log("info", `retired ${label}`);
  }
}
