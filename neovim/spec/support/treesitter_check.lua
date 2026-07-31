-- Installs every parser declared in config.treesitter and asserts that opening a
-- buffer of the matching filetype attaches a highlighter. Run headless; writes
-- one line per language and exits non-zero on the first failure.

local failures = {}

local function fail(fmt, ...)
  local message = string.format(fmt, ...)
  table.insert(failures, message)
  io.stderr:write("FAIL: " .. message .. "\n")
end

local function ok(fmt, ...)
  io.stdout:write("OK: " .. string.format(fmt, ...) .. "\n")
end

if vim.fn.executable("tree-sitter") == 0 then
  fail("tree-sitter CLI not on $PATH; nvim-treesitter cannot build parsers")
else
  ok("tree-sitter CLI %s", vim.fn.system({ "tree-sitter", "--version" }):gsub("%s+$", ""))
end

local languages = require("config.treesitter").languages

require("nvim-treesitter").install(languages):wait(600000)

for _, lang in ipairs(languages) do
  local filetype = vim.treesitter.language.get_filetypes(lang)[1]
  if not filetype then
    fail("%s: no filetype registered", lang)
  else
    local buf = vim.api.nvim_create_buf(true, false)
    vim.api.nvim_set_option_value("filetype", filetype, { buf = buf })

    if vim.treesitter.highlighter.active[buf] then
      ok("%s: highlighting active for filetype %s", lang, filetype)
    else
      fail("%s: no highlighter attached to a %s buffer", lang, filetype)
    end
  end
end

if #failures > 0 then
  io.stderr:write(string.format("\n%d treesitter check(s) failed\n", #failures))
  vim.cmd("cquit 1")
end

vim.cmd("quit")
