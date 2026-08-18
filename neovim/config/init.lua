vim.g.mapleader = " "

vim.pack.add({
  "https://github.com/catppuccin/nvim",
  "https://github.com/nvim-telescope/telescope.nvim",
  "https://github.com/nvim-lua/plenary.nvim",
  "https://github.com/nvim-treesitter/nvim-treesitter",
  "https://github.com/christoomey/vim-tmux-navigator",
  "https://github.com/nvim-lualine/lualine.nvim",
  "https://github.com/lewis6991/gitsigns.nvim",
  "https://github.com/ChmaraX/herdr-nvim",
  "https://github.com/folke/which-key.nvim",
})

require("config.options")
require("config.colorscheme")
require("config.statusline")
require("config.gitsigns")
require("config.keymaps")
require("config.whichkey")
require("config.prose")
require("config.herdr")
require("config.treesitter")
require("config.lsp")
require("config.completion")
require("config.diagnostics")
