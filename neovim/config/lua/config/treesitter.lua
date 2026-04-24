require("nvim-treesitter").install({
  "bash", "dockerfile", "go", "gomod",
  "hcl", "javascript", "json", "lua",
  "python", "rust", "terraform", "toml",
  "typescript", "tsx", "yaml",
})

vim.api.nvim_create_autocmd("FileType", {
  pattern = {
    "bash", "sh",
    "dockerfile",
    "go", "gomod",
    "hcl",
    "javascript", "javascriptreact",
    "json",
    "lua",
    "python",
    "rust",
    "terraform",
    "toml",
    "typescript", "typescriptreact",
    "yaml",
  },
  callback = function() vim.treesitter.start() end,
})
