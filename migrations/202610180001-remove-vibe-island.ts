// Vibe Island is retired: Moshi carries remote attention, and native
// notifications cover everything else. Its bridge and cache live under
// ~/.vibe-island.
//
// EXPIRES: 2027-01-18 every machine has run scripts/install since the removal

import { join } from "node:path";
import { type Context, removeCask, removeTree } from "#migrations/migration";

export const platform = "darwin";

// The cask goes first so a running app is quit before its tree is removed.
export function up(context: Context): void {
  removeCask(context, "vibe-island");
  removeTree(context, join(context.home, ".vibe-island"));
}
