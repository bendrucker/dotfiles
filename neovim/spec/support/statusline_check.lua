-- Asserts that the theme name configured in config.statusline actually resolves.
-- lualine wraps its theme load in pcall and degrades to `auto`/`gruvbox` through
-- vim.notify, so a renamed or misspelled theme leaves startup clean and only
-- shows up as the wrong statusline colors. Run headless; exits non-zero on
-- failure.

local failures = {}

local function fail(fmt, ...)
  local message = string.format(fmt, ...)
  table.insert(failures, message)
  io.stderr:write("FAIL: " .. message .. "\n")
end

local function ok(fmt, ...)
  io.stdout:write("OK: " .. string.format(fmt, ...) .. "\n")
end

local theme = require("lualine").get_config().options.theme

if type(theme) ~= "string" then
  ok("theme is a %s, nothing to resolve by name", type(theme))
else
  local resolved, err = pcall(require("lualine.utils.loader").load_theme, theme)
  if resolved then
    ok("theme %s resolves", theme)
  else
    fail("theme %s does not resolve, lualine falls back: %s", theme, err)
  end
end

-- A resolved theme still has to reach the statusline, and create_highlight_groups
-- is what puts it there.
local normal = vim.api.nvim_get_hl(0, { name = "lualine_a_normal" })
if next(normal) == nil then
  fail("lualine_a_normal is undefined; no theme highlights were created")
else
  ok("lualine_a_normal is defined")
end

if #failures > 0 then
  io.stderr:write(string.format("\n%d statusline check(s) failed\n", #failures))
  vim.cmd("cquit 1")
end

vim.cmd("quit")
