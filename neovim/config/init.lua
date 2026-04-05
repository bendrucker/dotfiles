vim.g.mapleader = " "

vim.pack.add({
  "https://github.com/nvim-telescope/telescope.nvim",
  "https://github.com/nvim-lua/plenary.nvim",
  "https://github.com/nvim-treesitter/nvim-treesitter",
  "https://github.com/christoomey/vim-tmux-navigator",
})

vim.keymap.set("n", "<leader>f", "<cmd>Telescope find_files<cr>", { desc = "Find files" })
vim.keymap.set("n", "<leader>g", "<cmd>Telescope live_grep<cr>", { desc = "Live grep" })
vim.keymap.set("n", "<leader>b", "<cmd>Telescope buffers<cr>", { desc = "Buffers" })

require("nvim-treesitter.configs").setup({
  ensure_installed = {
    "bash", "dockerfile", "go", "gomod",
    "hcl", "javascript", "json", "lua",
    "python", "rust", "terraform", "toml",
    "typescript", "tsx", "yaml",
  },
  highlight = { enable = true },
})

local servers = {
  gopls = { filetypes = { "go", "gomod" } },
  ts_ls = { filetypes = { "javascript", "javascriptreact", "typescript", "typescriptreact" } },
  ty = { filetypes = { "python" } },
  rust_analyzer = { filetypes = { "rust" } },
  terraformls = { filetypes = { "terraform", "terraform-vars" } },
}

for name, config in pairs(servers) do
  vim.lsp.config[name] = {
    cmd = { name },
    filetypes = config.filetypes,
    root_markers = { ".git" },
  }
  vim.lsp.enable(name)
end

vim.o.autocomplete = true
vim.o.pumborder = "rounded"
vim.o.completeopt = "menu,menuone,noselect,nearest"

vim.diagnostic.config({
  severity_sort = true,
  virtual_text = { spacing = 2 },
  signs = {
    text = {
      [vim.diagnostic.severity.ERROR] = "E",
      [vim.diagnostic.severity.WARN] = "W",
      [vim.diagnostic.severity.INFO] = "I",
      [vim.diagnostic.severity.HINT] = "H",
    },
  },
})
