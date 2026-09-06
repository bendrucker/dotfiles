vim.keymap.set("n", "<leader>f", "<cmd>Telescope find_files<cr>", { desc = "Find files" })
vim.keymap.set("n", "<leader>g", "<cmd>Telescope live_grep<cr>", { desc = "Live grep" })
vim.keymap.set("n", "<leader>b", "<cmd>Telescope buffers<cr>", { desc = "Buffers" })

-- j and k move by what's on screen rather than by logical line, so a wrapped
-- paragraph steps a row at a time. Guarding on v:count keeps 5j counting real
-- lines, which is what the relative number column is showing.
vim.keymap.set({ "n", "x" }, "j", "v:count == 0 ? 'gj' : 'j'", { expr = true, desc = "Down by display line" })
vim.keymap.set({ "n", "x" }, "k", "v:count == 0 ? 'gk' : 'k'", { expr = true, desc = "Up by display line" })

vim.keymap.set("n", "<Esc>", "<cmd>nohlsearch<cr>", { desc = "Clear search highlight" })

-- Visual P leaves the register alone where p replaces it with whatever was
-- selected, so the same text can be pasted over several places in a row.
vim.keymap.set("x", "p", "P", { desc = "Paste over selection" })

-- Only yanks reach the + register (see config.clipboard), so reading the system
-- clipboard back is explicit. Insert-mode Cmd-V still works through the terminal.
vim.keymap.set({ "n", "x" }, "<leader>p", '"+p', { desc = "Paste from clipboard" })

-- Split navigation, previously supplied by vim-tmux-navigator. That plugin's
-- draw was crossing the multiplexer boundary: the same chord moved between nvim
-- splits and tmux panes. herdr has no counterpart, so these move within nvim
-- only, and leaving a split for a neighbouring pane goes through herdr's prefix.
for _, key in ipairs({ "h", "j", "k", "l" }) do
  vim.keymap.set("n", "<C-" .. key .. ">", "<C-w>" .. key, { desc = "Go to the split " .. key })
end
