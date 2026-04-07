require("nvim-treesitter.configs").setup({
  ensure_installed = {
    "bash", "dockerfile", "go", "gomod",
    "hcl", "javascript", "json", "lua",
    "python", "rust", "terraform", "toml",
    "typescript", "tsx", "yaml",
  },
  highlight = { enable = true },
})
