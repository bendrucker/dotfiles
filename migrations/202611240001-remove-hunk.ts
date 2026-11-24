// plannotator-tui replaced Hunk as the Rex diff reviewer. The deleted hunk
// topic declared the formula and linked one file into ~/.config/hunk.
//
// EXPIRES: 2027-05-24 every machine has run scripts/install since the hunk topic was removed

import { join } from "node:path";
import { type Context, isEmpty, ownedLink, removeFormula, removeTree } from "#migrations/migration";

export async function up(context: Context): Promise<void> {
  await removeFormula("hunk");

  const dir = join(context.config, "hunk");
  const link = join(dir, "config.toml");
  if (ownedLink(context, link)) await removeTree(context, link);
  if (isEmpty(dir)) await removeTree(context, dir);
}
