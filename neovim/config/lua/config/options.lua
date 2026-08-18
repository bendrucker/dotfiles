vim.o.number = true
vim.o.relativenumber = true
vim.o.cursorline = true
vim.o.signcolumn = "yes"
vim.o.scrolloff = 8
vim.o.termguicolors = true
vim.o.showmode = false
vim.o.laststatus = 3

-- Treesitter supplies folds; open files with all of them expanded.
vim.o.foldlevelstart = 99

-- Wrapping defaults assume code. These are for the markdown drafts this config
-- actually opens, usually in a split narrow enough that every paragraph wraps.
vim.o.linebreak = true
vim.o.breakindent = true
vim.o.showbreak = "↪ "

vim.o.ignorecase = true
vim.o.smartcase = true

-- Undo survives closing the file, which is the whole session for a draft that
-- gets opened, edited, and closed again on the next round.
vim.o.undofile = true

-- Turns E37 on :q into a save/discard/cancel prompt.
vim.o.confirm = true

vim.o.splitright = true
vim.o.splitbelow = true
