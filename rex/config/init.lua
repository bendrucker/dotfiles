local terminal = "com.superlogical.terminal"
local config_dir = debug.getinfo(1, "S").source:match("^@?(.*)/")

-- The server's config path is fixed at startup, so `mise run rex:try` swaps
-- configs by naming another init.lua here.
local function tried_config()
  local pointer = io.open(os.getenv("HOME") .. "/.local/state/rex-try/config")
  if not pointer then return nil end
  local path = pointer:read("*l")
  pointer:close()
  if not path or path == config_dir .. "/init.lua" then return nil end
  local file = io.open(path)
  if not file then return nil end
  file:close()
  return path
end

local tried = tried_config()
if tried then return dofile(tried) end
-- The foreground program's cwd follows an agent into a worktree it switched
-- to, which the shell's last reported directory doesn't.
local function block_dir(block_id)
  local process = rex.block.call(terminal, "process", { block_id = block_id })
  local foreground = process and process.foreground
  if foreground and foreground.cwd then
    return foreground.cwd
  end
  local reported = rex.block.call(terminal, "pwd", { block_id = block_id })
  local pwd = reported and reported.pwd
  return pwd and (pwd:match("^file://[^/]*(/.*)$") or pwd)
end

-- The server's PATH lacks Homebrew and bun. zsh reads ~/.zshenv, which sets them.
local function zsh_argv(script, name, args)
  local argv = { "/bin/zsh", "-c", script, name }
  for _, arg in ipairs(args) do
    argv[#argv + 1] = arg
  end
  return argv
end

rex.action{
  name = "claude_agents",
  title = "Claude Agents",
  description = "Manage background Claude sessions in a narrow floating pane on the right. Quitting the agent view closes it.",
  category = "Claude",
  keywords = "claude agents background bg attach daemon float",
  run = function(ctx)
    -- New sessions dispatched from the view start in the focused pane's
    -- directory.
    local dir = ctx.block_id and block_dir(ctx.block_id)

    local _, err = rex.session.new_layer{
      bounds = { 0.73, 0.1, 0.25, 0.8 },
      focus = true,
      layout = rex.layout.block{
        flavor = "com.superlogical.terminal.shell",
        options = {
          cwd = dir,
          command = { "claude", "agents" },
        },
      },
    }
    if err ~= nil then
      error(err, 0)
    end
  end,
}

-- A prompt's answer, or nil when the person cancelled it.
local function answered(value, why, detail)
  if value == nil and why ~= "cancelled" then
    error("no answer: " .. tostring(why) .. (detail and (" " .. detail) or ""), 0)
  end
  return value
end

local attach_filters = {
  { id = "filter:waiting", title = "Only sessions needing input", icon = "person", keep = function(item) return item.group == "waiting" end },
  { id = "filter:active", title = "Hide finished sessions", icon = "clock", keep = function(item) return item.group ~= "done" end },
  { id = "filter:all", title = "Show all sessions", icon = "star", keep = function() return true end },
}

local attach_placements = {
  { id = "tab", title = "Tab", subtitle = "A new tab in the Rex session for its repo", icon = "plus" },
  { id = "pane", title = "Split", subtitle = "A pane to the right of the current pane", icon = "terminal" },
  { id = "float", title = "Float", subtitle = "A floating pane over the current tab", icon = "link" },
}

-- REX_CLIENT routes the script's focus and select calls to the app that ran the action.
local function claude_attach(ctx, args)
  local argv = zsh_argv('exec rex-claude-attach "$@"', "rex-claude-attach", args)
  local r, err = rex.exec(argv, { env = { REX_CLIENT = ctx.client_id }, timeout = 30 })
  if r == nil then
    error(err, 0)
  end
  if not r.ok then
    error(r.stderr ~= "" and r.stderr or ("rex-claude-attach exited " .. r.code), 0)
  end
  return r.stdout
end

-- The picked session, or nil when the person cancelled. Picking a filter shows the list again through it.
local function pick_session(sessions)
  local filter = attach_filters[3]
  while true do
    local items, by_id = {}, {}
    for _, session in ipairs(sessions) do
      if filter.keep(session) then
        items[#items + 1] = {
          id = session.id,
          title = session.title,
          subtitle = session.subtitle,
          detail = session.detail,
          icon = session.group == "waiting" and "person" or "terminal",
        }
        by_id[session.id] = session
      end
    end
    for _, other in ipairs(attach_filters) do
      if other ~= filter then
        items[#items + 1] = { id = other.id, title = other.title, icon = other.icon }
      end
    end
    local id = answered(rex.ui.pick{ title = "Attach Claude Session", placeholder = "Filter sessions", items = items })
    if id == nil then return nil end
    if by_id[id] then return by_id[id] end
    for _, other in ipairs(attach_filters) do
      if other.id == id then filter = other end
    end
  end
end

rex.action{
  name = "claude_attach",
  title = "Attach Claude Session",
  description = "Pick a Claude session, waiting ones first, and go to its pane, or attach it in a new tab, split, or float.",
  category = "Claude",
  keywords = "claude agents background bg attach session pick",
  run = function(ctx)
    local sessions, bad = rex.json.decode(claude_attach(ctx, { "--list" }))
    if sessions == nil then
      error("rex-claude-attach --list: " .. bad, 0)
    end
    if #sessions == 0 then
      error("no Claude sessions to attach", 0)
    end
    local session = pick_session(sessions)
    if session == nil then return end
    -- A session a pane already shows gets that pane's focus, wherever it is.
    local placement = "tab"
    if not session.shown then
      placement = answered(rex.ui.pick{ title = "Open " .. session.title .. " in", items = attach_placements })
      if placement == nil then return end
    end
    claude_attach(ctx, { session.id, "--as", placement, "--beside", ctx.block_id or "" })
  end,
}

-- The server runs commands without its own directory on PATH, where
-- terminal-browser would otherwise look for rex.
local rex_bin_dir = os.getenv("HOME")
  .. "/Library/Application Support/com.superlogical.rex/RexServer/Versions/Current/Rex Server.app/Contents/MacOS"

-- terminal-browser splits the block itself, which lets it open a tab in a
-- browser already beside the block instead of a second browser.
rex.action{
  name = "terminal_browser",
  title = "Open Browser",
  description = "Open terminal-browser in a split to the right of the focused pane, or a new tab in the browser already there.",
  category = "Browser",
  keywords = "terminal-browser web browser url html preview split",
  run = function(ctx)
    if ctx.block_id == nil then
      error("no focused pane to split", 0)
    end
    local r, err = rex.exec(zsh_argv('exec terminal-browser open --split right', "terminal-browser", {}), {
      env = { REX_BLOCK = ctx.block_id, REX_SESSION = ctx.session_id, REX_BIN_DIR = rex_bin_dir },
      timeout = 25,
    })
    if r == nil then
      error(err, 0)
    end
    if not r.ok then
      error(r.stderr ~= "" and r.stderr or ("terminal-browser exited " .. r.code), 0)
    end
  end,
}

dofile(config_dir .. "/review/init.lua")
