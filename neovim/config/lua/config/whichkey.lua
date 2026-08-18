-- Pressing a prefix and waiting shows what's bound under it, reading the desc
-- field every keymap in config.keymaps already sets. This config is used in
-- bursts, so the leader map is easier to be reminded of than to memorize.
require("which-key").setup({
  preset = "helix",
})
