require("catppuccin").setup({
  flavour = "auto",
  background = { light = "latte", dark = "mocha" },
  integrations = {
    treesitter = true,
    telescope = { enabled = true },
    native_lsp = { enabled = true },
  },
})

vim.cmd.colorscheme("catppuccin")
