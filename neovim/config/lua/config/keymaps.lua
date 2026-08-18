vim.keymap.set("n", "<leader>f", "<cmd>Telescope find_files<cr>", { desc = "Find files" })
vim.keymap.set("n", "<leader>g", "<cmd>Telescope live_grep<cr>", { desc = "Live grep" })
vim.keymap.set("n", "<leader>b", "<cmd>Telescope buffers<cr>", { desc = "Buffers" })

-- j and k move by what's on screen rather than by logical line, so a wrapped
-- paragraph steps a row at a time. Guarding on v:count keeps 5j counting real
-- lines, which is what the relative number column is showing.
local function by_display_line(key)
  return function()
    return vim.v.count == 0 and ("g" .. key) or key
  end
end

vim.keymap.set({ "n", "x" }, "j", by_display_line("j"), { expr = true, desc = "Down by display line" })
vim.keymap.set({ "n", "x" }, "k", by_display_line("k"), { expr = true, desc = "Up by display line" })

vim.keymap.set("n", "<Esc>", "<cmd>nohlsearch<cr>", { desc = "Clear search highlight" })

-- Visual P leaves the register alone where p replaces it with whatever was
-- selected. With clipboard=unnamedplus that difference is the system clipboard.
vim.keymap.set("x", "p", "P", { desc = "Paste over selection" })
