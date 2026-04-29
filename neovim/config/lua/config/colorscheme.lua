require("catppuccin").setup({
  flavour = "auto",
  background = { light = "latte", dark = "mocha" },
  styles = {
    comments = { "italic" },
    conditionals = { "italic" },
    keywords = { "italic" },
  },
  integrations = {
    treesitter = true,
    telescope = { enabled = true },
    native_lsp = {
      enabled = true,
      underlines = {
        errors = { "undercurl" },
        hints = { "undercurl" },
        warnings = { "undercurl" },
        information = { "undercurl" },
      },
    },
    gitsigns = true,
    cmp = true,
    mini = { enabled = true },
  },
})

vim.cmd.colorscheme("catppuccin")
