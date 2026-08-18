-- Yanks reach the system clipboard. Deletes do not.
--
-- clipboard=unnamedplus is the usual way to get the first half, but it routes
-- every register write, so dw, dd, and even a single-character x each land in
-- the macOS pasteboard. Anything keeping pasteboard history records all of
-- them, and the copy worth keeping is buried within a few keystrokes.
--
-- TextYankPost carries the operator that produced the write, so filtering on
-- "y" leaves d and c on the unnamed register where the rest of vim expects
-- them, and p inside the buffer still pastes what was just deleted.
vim.api.nvim_create_autocmd("TextYankPost", {
  callback = function()
    if vim.v.event.operator == "y" then
      vim.fn.setreg("+", vim.v.event.regcontents, vim.v.event.regtype)
    end
  end,
})
