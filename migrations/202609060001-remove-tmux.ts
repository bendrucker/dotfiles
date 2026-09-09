// herdr replaced tmux as the terminal workspace manager. Removing the topic
// stopped declaring tmux and sesh and stopped linking the config, but nothing
// uninstalls a formula a Brewfile no longer names or removes what a deleted
// install.sh created. Left alone, the packages surface every night through
// scripts/brew-drift as a decision already made.
//
// Each path below is one the deleted topic created: `mkdir -p "$HOME/.tmux"`
// and the TPM clone under XDG_DATA_HOME from its install.sh, and the config
// link from its symlinks.conf.
//
// EXPIRES: 2027-03-06 every machine has run scripts/install since the tmux removal

import { join } from "node:path";
import { type Context, isEmpty, ownedLink, removeFormula, removeTree } from "#migrations/migration";

export function up(context: Context): void {
  removeFormula(context, "tmux");
  removeFormula(context, "sesh");

  // Everything under here is a plugin repo TPM cloned, since install.sh pointed
  // TMUX_PLUGIN_MANAGER_PATH at it and nothing else ever wrote there.
  removeTree(context, join(context.data, "tmux"));

  // `mkdir -p` is all that made this, so an empty one is the directory the
  // installer left and anything else is someone's own.
  const home = join(context.home, ".tmux");
  if (isEmpty(home)) removeTree(context, home);

  // Only while it still resolves into a dotfiles tree. A directory here, or a
  // link someone repointed at config of their own, is not this migration's to
  // decide about.
  const config = join(context.config, "tmux");
  if (ownedLink(context, config)) removeTree(context, config);
}
