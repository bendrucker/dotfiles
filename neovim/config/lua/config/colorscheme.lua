-- Drive catppuccin's "auto" flavour off the system appearance, the same source
-- the theme-sync watcher uses. This is deterministic, unlike relying on terminal
-- background detection, which is unreliable through tmux. When theme-flavor is
-- not on PATH, fall back to neovim's own background detection.
local function apply_system_background()
  if vim.fn.executable("theme-flavor") ~= 1 then
    return
  end
  local flavor = vim.trim(vim.fn.system({ "theme-flavor" }))
  if vim.v.shell_error == 0 and flavor ~= "" then
    vim.o.background = flavor == "latte" and "light" or "dark"
  end
end

apply_system_background()

-- The watcher sends SIGUSR1 on a system theme change; re-apply so running
-- instances flip live. catppuccin reloads on the resulting background change.
vim.api.nvim_create_autocmd("Signal", {
  pattern = "SIGUSR1",
  callback = apply_system_background,
})

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
