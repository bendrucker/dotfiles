-- A parser installed during this session lands on disk but stays invisible to
-- vim.treesitter.language.add(): neovim caches runtime file lookups, and that
-- cache was warmed before the parser directory existed. Resetting 'runtimepath'
-- invalidates it. Without that reset the check only passes when some earlier
-- nvim happened to finish installing the parsers first, which is a race against
-- the fire-and-forget install in config.treesitter.

local INSTALL_TIMEOUT_MS = 600000
local ATTEMPTS = 3

local failures = {}

local function fail(fmt, ...)
  local message = string.format(fmt, ...)
  table.insert(failures, message)
  io.stderr:write("FAIL: " .. message .. "\n")
end

local function ok(fmt, ...)
  io.stdout:write("OK: " .. string.format(fmt, ...) .. "\n")
end

local function note(fmt, ...)
  io.stdout:write("... " .. string.format(fmt, ...) .. "\n")
end

if vim.fn.executable("tree-sitter") == 0 then
  fail("tree-sitter CLI not on $PATH; nvim-treesitter cannot build parsers")
else
  ok("tree-sitter CLI %s", vim.fn.system({ "tree-sitter", "--version" }):gsub("%s+$", ""))
end

local languages = require("config.treesitter").languages
local parser_dir = vim.fs.joinpath(vim.fn.stdpath("data"), "site", "parser")

local function installed(lang)
  return vim.uv.fs_stat(vim.fs.joinpath(parser_dir, lang .. ".so")) ~= nil
end

local function not_installed(langs)
  return vim.tbl_filter(function(lang)
    return not installed(lang)
  end, langs)
end

-- Retries cover a parser whose source download failed transiently. Retries force
-- because nvim-treesitter treats a language as installed when *either* its parser
-- or its queries are present, so a build that failed after the queries were
-- linked would otherwise never be attempted again.
local pending = languages
for attempt = 1, ATTEMPTS do
  require("nvim-treesitter").install(pending, { force = attempt > 1 }):wait(INSTALL_TIMEOUT_MS)
  pending = not_installed(pending)
  if #pending == 0 then
    break
  end
  if attempt < ATTEMPTS then
    note("attempt %d left %d parser(s) uninstalled, retrying: %s",
      attempt, #pending, table.concat(pending, ", "))
  end
end

for _, lang in ipairs(pending) do
  fail("%s: parser missing from %s after %d install attempts", lang, parser_dir, ATTEMPTS)
end

-- Make the parsers installed above visible to language.add() in this session.
vim.o.runtimepath = vim.o.runtimepath

local function diagnose(lang)
  if not installed(lang) then
    return "parser missing from " .. parser_dir
  end

  local called, added, add_err = pcall(vim.treesitter.language.add, lang)
  if not called then
    return "language.add raised: " .. tostring(added)
  end
  if not added then
    return "language.add could not load the parser: " .. tostring(add_err)
  end
  if #vim.api.nvim_get_runtime_file("queries/" .. lang .. "/highlights.scm", false) == 0 then
    return "no highlights query on 'runtimepath'"
  end

  return "parser and queries present, but vim.treesitter.start did not attach"
end

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
      fail("%s: no highlighter attached to a %s buffer: %s", lang, filetype, diagnose(lang))
    end
  end
end

if #failures > 0 then
  io.stderr:write(string.format("\n%d treesitter check(s) failed\n", #failures))
  vim.cmd("cquit 1")
end

vim.cmd("quit")
