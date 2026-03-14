local lazypath = vim.fn.stdpath("data") .. "/lazy/lazy.nvim"
if not vim.loop.fs_stat(lazypath) then
  vim.fn.system({
    "git", "clone", "--filter=blob:none",
    "https://github.com/folke/lazy.nvim.git",
    "--branch=stable", lazypath,
  })
end
vim.opt.rtp:prepend(lazypath)

vim.g.mapleader = " "

require("lazy").setup({
  {
    "nvim-telescope/telescope.nvim",
    tag = "v0.2.1",    dependencies = {
      { "nvim-lua/plenary.nvim", tag = "v0.1.4" },    },
    keys = {
      { "<leader>f", "<cmd>Telescope find_files<cr>", desc = "Find files" },
      { "<leader>g", "<cmd>Telescope live_grep<cr>", desc = "Live grep" },
      { "<leader>b", "<cmd>Telescope buffers<cr>", desc = "Buffers" },
    },
  },

  {
    "nvim-treesitter/nvim-treesitter",
    tag = "v0.10.0",    build = ":TSUpdate",
    config = function()
      require("nvim-treesitter.configs").setup({
        ensure_installed = {
          "bash", "dockerfile", "go", "gomod",
          "hcl", "javascript", "json", "lua",
          "python", "rust", "terraform", "toml",
          "typescript", "tsx", "yaml",
        },
        highlight = { enable = true },
      })
    end,
  },

  {
    "neovim/nvim-lspconfig",
    tag = "v2.7.0",    config = function()
      local lspconfig = require("lspconfig")
      local servers = { "gopls", "ts_ls", "ty", "rust_analyzer", "terraformls" }
      for _, server in ipairs(servers) do
        lspconfig[server].setup({})
      end

      vim.api.nvim_create_autocmd("LspAttach", {
        callback = function(args)
          local opts = { buffer = args.buf }
          vim.keymap.set("n", "gd", vim.lsp.buf.definition, opts)
          vim.keymap.set("n", "K", vim.lsp.buf.hover, opts)
          vim.keymap.set("n", "gr", vim.lsp.buf.references, opts)
          vim.keymap.set("n", "<leader>r", vim.lsp.buf.rename, opts)
          vim.keymap.set("n", "<leader>a", vim.lsp.buf.code_action, opts)
        end,
      })
    end,
  },

  { "christoomey/vim-tmux-navigator", tag = "v1.0" },})
