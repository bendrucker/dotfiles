// ~/.config/mise/conf.d became one link to the dotfiles root, and
// install-symlinks refuses to replace a real directory with a link. This clears
// the per-topic fragment links the directory used to hold. Anything else in it
// is moved aside rather than deleted, since it is config someone put there.
//
// EXPIRES: 2027-04-12 every machine has run scripts/install since the move

import { readdirSync, renameSync, rmdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { log } from "#gum";
import { type Context, exists, isEmpty, linkTarget, ownedLink } from "#migrations/migration";

export async function up(context: Context): Promise<void> {
  const confd = join(context.config, "mise", "conf.d");
  if (!exists(confd) || linkTarget(confd) !== undefined) return;

  for (const name of readdirSync(confd)) {
    const fragment = join(confd, name);
    if (ownedLink(context, fragment)) rmSync(fragment);
  }

  if (isEmpty(confd)) {
    rmdirSync(confd);
    return;
  }

  // An earlier move's backup is never overwritten.
  let aside = `${confd}.pre-link`;
  if (exists(aside)) aside = `${aside}-${Date.now()}`;
  renameSync(confd, aside);
  await log("warn", `moved ${confd} to ${aside}; it held config this repo did not link`);
}
