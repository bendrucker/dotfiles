vim.g.mapleader = " "

vim.pack.add({
  "https://github.com/catppuccin/nvim",
  "https://github.com/nvim-telescope/telescope.nvim",
  "https://github.com/nvim-lua/plenary.nvim",
  "https://github.com/nvim-treesitter/nvim-treesitter",
  "https://github.com/christoomey/vim-tmux-navigator",
})

require("config.colorscheme")
require("config.keymaps")
require("config.treesitter")
require("config.lsp")
require("config.completion")
require("config.diagnostics")
