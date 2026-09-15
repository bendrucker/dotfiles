-- A parser installed during this session lands on disk but stays invisible to
-- vim.treesitter.language.add(): neovim caches runtime file lookups, and that
-- cache was warmed before the parser directory existed. Resetting 'runtimepath'
-- invalidates it. Without that reset the check only passes when some earlier
-- nvim happened to finish installing the parsers first, which is a race against
-- the fire-and-forget install in config.treesitter.

-- A healthy install of every language completes in under a minute. Bounding
-- each attempt separately caps what one stalled download can consume, leaving
-- the rest of the budget for the retries.
local INSTALL_BUDGET_MS = 300000
local ATTEMPT_TIMEOUT_MS = 120000

-- Backoff seconds. A 504 from the tarball host clears within seconds, which
-- outlasts back-to-back retries. curl's own --retry does not cover it: the 504
-- arrives mid-transfer and surfaces as exit 56 rather than an HTTP status,
-- which is outside curl's transient-error set.
local BACKOFF_S = { 5, 10, 20, 40 }
local ATTEMPTS = #BACKOFF_S + 1

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
local ts_config = require("nvim-treesitter.config")
local parser_dir = ts_config.get_install_dir("parser")

-- get_installed() with no argument also counts a language whose queries linked
-- but whose parser build failed. "parsers" asks only about the shared objects.
local function not_installed(langs)
  local have = {}
  for _, lang in ipairs(ts_config.get_installed("parsers")) do
    have[lang] = true
  end
  return vim.tbl_filter(function(lang)
    return not have[lang]
  end, langs)
end

-- Retries cover a parser whose source download failed transiently. Retries force
-- because nvim-treesitter treats a language as installed when *either* its parser
-- or its queries are present, so a build that failed after the queries were
-- linked would otherwise never be attempted again.
local started = vim.uv.hrtime()
local pending = languages
local attempts_made = 0
for attempt = 1, ATTEMPTS do
  local budget = INSTALL_BUDGET_MS - (vim.uv.hrtime() - started) / 1e6
  local remaining = math.floor(math.min(ATTEMPT_TIMEOUT_MS, budget))
  if remaining <= 0 then
    note("install budget of %ds exhausted after %d attempt(s)", math.floor(INSTALL_BUDGET_MS / 1000), attempt - 1)
    break
  end

  attempts_made = attempt
  -- pwait, because wait() raises on timeout, replacing the FAIL: lines with a
  -- traceback.
  local finished, reason =
    require("nvim-treesitter").install(pending, { force = attempt > 1 }):pwait(remaining)
  pending = not_installed(pending)
  if #pending == 0 then
    break
  end
  if not finished then
    -- The task is still running, and a second install() writes the same
    -- download cache.
    note("attempt %d stopped after %ds: %s", attempt, math.floor(remaining / 1000), tostring(reason))
    break
  end
  if attempt < ATTEMPTS then
    note("attempt %d left %d parser(s) uninstalled, retrying in %ds: %s",
      attempt, #pending, BACKOFF_S[attempt], table.concat(pending, ", "))
    vim.uv.sleep(BACKOFF_S[attempt] * 1000)
  end
end

-- A language reported here is not asserted on again below, so one broken parser
-- yields one FAIL line rather than a second, vaguer one from diagnose().
local unavailable = {}
for _, lang in ipairs(pending) do
  unavailable[lang] = true
  fail("%s: parser missing from %s after %d install attempt(s)", lang, parser_dir, attempts_made)
end

-- Make the parsers installed above visible to language.add() in this session.
vim.o.runtimepath = vim.o.runtimepath

local function diagnose(lang)
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
  if not unavailable[lang] then
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
end

if #failures > 0 then
  io.stderr:write(string.format("\n%d treesitter check(s) failed\n", #failures))
  vim.cmd("cquit 1")
end

vim.cmd("quit")
