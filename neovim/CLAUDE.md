# Neovim

## Plugins

`neovim/config/nvim-pack-lock.json` pins every plugin that `neovim/config/init.lua` declares with `vim.pack.add`. `vim.pack` takes revisions from the lockfile and ignores `version`, so declare plugins without one.

Update plugins by hand. Run `:lua vim.pack.update()`, review the confirmation buffer, `:write` to apply, then commit the lockfile diff. Renovate cannot track them, because nvim-treesitter has no tags on `main` and lualine has no version tags.

Treesitter parsers break when nvim-treesitter moves past the revision they were built against. A `PackChanged` autocommand in `neovim/config/lua/config/treesitter.lua` rebuilds them on every plugin change, and `neovim/neovim.integration.test.ts` checks each declared language gets a working highlighter.
