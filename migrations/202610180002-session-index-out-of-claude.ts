// The observability plugin's session index moves out of ~/.claude, where the
// desktop app refuses to grant a cloud thread access, to $XDG_DATA_HOME, which
// it can grant. claude/install.sh keeps the plugin's data path linked to it.
//
// EXPIRES: 2027-01-18 every machine has run scripts/install since the move

import { mkdirSync, renameSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { log } from "#jobs/output";
import { type Context, exists, linkTarget } from "#migrations/migration";

export function up(context: Context): void {
  const source = join(context.home, ".claude", "plugins", "data", "observability-bendrucker");
  const target = join(context.data, "session-index");
  if (!exists(source) || linkTarget(source) !== undefined) return;

  // Two indexes would mean picking one to lose, which is not this migration's call.
  if (exists(target)) {
    log(context.out, "warn", `${source} and ${target} both exist; merge or remove one by hand`);
    return;
  }

  mkdirSync(dirname(target), { recursive: true });
  renameSync(source, target);
  symlinkSync(target, source);
  log(context.out, "info", `moved ${source} to ${target}`);
}
