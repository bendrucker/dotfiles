-- The nvim half of the herdr-nvim plugin: comment lines like a code review,
-- then send the batch to any agent in the workspace with file:line and git
-- context. The herdr half (sidebar, file picker) is installed by herdr-lazy
-- from herdr/plugins.list and keyed in herdr/config.toml.
--
-- Comments live in memory and clear on a successful send, which is why the
-- lualine statusline carries the pending count.
require("herdr-nvim").setup({})
