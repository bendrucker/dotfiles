// Rex resumes Claude Code after a server restart through its own hook and the
// Program Resume Protocol, which replaces rex-agent-resume's clone and state.
//
// EXPIRES: 2027-05-27 every machine has run scripts/install since the removal

import { join } from "node:path";
import { type Context, removeTree } from "#migrations/migration";

export const platform = "darwin";

export async function up(context: Context): Promise<void> {
  await removeTree(context, join(context.data, "rex-agent-resume"));
  await removeTree(context, join(context.home, ".local", "state", "rex-agent-resume"));
}
