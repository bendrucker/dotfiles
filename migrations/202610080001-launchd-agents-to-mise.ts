// The LaunchAgents moved into mise, which labels them dev.mise.<name>. The old
// jobs are torn down here, before the topic installers load their replacements,
// so tailgate and aw-qt each run as a single copy throughout. A leftover plist
// would load again at next login, so each one is deleted as well.
//
// EXPIRES: 2027-04-08 every machine has run scripts/install since the move

import { rmSync } from "node:fs";
import { join } from "node:path";
import { log } from "#jobs/output";
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

// The nightly job is normally the process running this migration, and a bootout
// kills the job's whole process tree. Disabling it instead stops every later
// launch and leaves this run alive. launchd drops the job at next login, once
// its plist is gone.
export const RUNNING_JOB = "com.user.dotfiles-upgrade";

export function up(context: Context): void {
  const domain = `gui/${process.getuid?.() ?? 0}`;

  for (const label of [...RETIRED, RUNNING_JOB]) {
    const action = label === RUNNING_JOB ? "disable" : "bootout";
    context.out.read(["launchctl", action, `${domain}/${label}`]);

    const plist = join(context.home, "Library", "LaunchAgents", `${label}.plist`);
    if (!exists(plist)) continue;
    rmSync(plist);
    log(context.out, "info", `retired ${label}`);
  }
}
