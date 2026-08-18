-- Buffers this config exists to edit: the markdown drafts an agent writes into a
-- split for review, and the commit messages that follow them.
--
-- spelllang is "en" rather than "en_us" because en.utf-8.spl ships in
-- $VIMRUNTIME. A regional variant prompts to download one on first open.
vim.api.nvim_create_autocmd("FileType", {
  pattern = { "markdown", "gitcommit" },
  callback = function()
    vim.opt_local.spell = true
    vim.opt_local.spelllang = "en"

    -- Don't flag the halves of identifiers that turn up in technical prose.
    vim.opt_local.spelloptions:append("camel")
  end,
})
