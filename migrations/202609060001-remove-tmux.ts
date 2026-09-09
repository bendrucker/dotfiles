// herdr replaced tmux as the terminal workspace manager in `rm tmux` (#715).
// That commit deleted the topic, which stopped declaring tmux and sesh and
// stopped linking the config, but nothing uninstalls a formula a Brewfile no
// longer names or removes what a deleted install.sh created. Left alone, the
// packages surface every night through scripts/brew-drift as a decision the
// removal commit had already made.
//
// Each path here traces to a line that commit deleted: `mkdir -p "$HOME/.tmux"`
// and the TPM clone under XDG_DATA_HOME from tmux/install.sh, and
// `.:$XDG_CONFIG_HOME/tmux` from tmux/symlinks.conf.
//
// EXPIRES: 2027-03-06 every machine has run scripts/install since the tmux removal

import { lstatSync } from "node:fs";
import { join } from "node:path";
import { type Context, exists, removeFormula, removeTree } from "#migrations/migration";

export function up(context: Context): void {
  removeFormula(context, "tmux");
  removeFormula(context, "sesh");

  removeTree(context, join(context.data, "tmux"));
  removeTree(context, join(context.home, ".tmux"));

  // Only while it is still the link install-symlinks made. A directory here is
  // something someone put back by hand, and this migration has no business
  // deciding that was a mistake.
  const config = join(context.config, "tmux");
  if (exists(config) && lstatSync(config).isSymbolicLink()) removeTree(context, config);
}
