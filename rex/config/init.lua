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

-- terminal-browser scales pages from the terminal's cell size, which renders
-- the Inbox's text about twice its usual size, and it resets its own zoom when
-- the pane is first drawn. A helper beside it sets a CSS zoom that makes a CSS
-- pixel two device pixels, as on a Retina display, and fits it again whenever
-- the pane's device size changes. A resize from the browser's own zoom keeps
-- the device size, so a manual zoom stays. A reload drops the CSS zoom. A new
-- tab stays 80x24 until an app draws it, so the script waits for the drawn
-- size first. The Inbox's port can change when it restarts, so the URL is read
-- at launch.
local inbox_title = "Plannotator Inbox"
local inbox_script = [=[
for _ in {1..30}; do [[ $(stty size) != "24 80" ]] && break; sleep 0.1; done
url=$(plannotator inbox --background 2>/dev/null) || { read -sk "?Press any key to close"; exit 1; }
fit='new Promise((loaded) => document.readyState === "complete" ? loaded() : addEventListener("load", loaded)).then(() => {
  let device = 0;
  const fit = () => {
    if (innerWidth * devicePixelRatio === device) return;
    device = innerWidth * devicePixelRatio;
    document.documentElement.style.zoom = String(2 / devicePixelRatio);
  };
  fit();
  addEventListener("resize", fit);
  return true;
})'
{
  for _ in {1..50}; do
    terminal-browser action -- eval "$fit" && break
    sleep 0.2
  done
} &>/dev/null &!
# The app evens out a new split shortly after it appears, whatever ratio it
# was given, so the border moves after that, twice in case the app is slow.
if [[ -n $2 ]]; then
  {
    for delay in 0.3 1.2; do
      sleep $delay
      rex do -e 'rex.session.resize_pane{ session_id = rex.args.session, direction = "horizontal", before_block_id = rex.args.anchor, after_block_id = rex.args.inbox, ratio = 0.6 }' \
        session="$1" anchor="$2" inbox="$REX_BLOCK"
    done
  } &>/dev/null &!
fi
exec terminal-browser open "$url" --no-merge
]=]

-- Given a session and the block it split, the script moves the border so the
-- Inbox takes the right 40%.
local function inbox_layout(split_args)
  return rex.layout.block{
    flavor = "com.superlogical.terminal.shell",
    label = inbox_title,
    options = { command = zsh_argv(inbox_script, "plannotator-inbox", split_args or {}) },
  }
end

-- Focuses the session's Inbox block, if one is open, and reports whether it did.
local function focus_inbox(session_id)
  local view, err = rex.session.view{ session_id = session_id }
  if view == nil then
    error(err, 0)
  end
  for _, window in ipairs(view.windows or {}) do
    for _, layer in ipairs(window.layers or {}) do
      for _, block in ipairs(layer.blocks or {}) do
        if block.label == inbox_title then
          local _, focus_err = rex.session.focus_block{ session_id = session_id, block_id = block.block_id }
          if focus_err ~= nil then
            error(focus_err, 0)
          end
          return true
        end
      end
    end
  end
  return false
end

rex.action{
  name = "plannotator_inbox",
  title = "Plannotator Inbox",
  description = "Open the Plannotator Inbox in a pane to the right of the focused pane, or go to the pane already showing it.",
  category = "Browser",
  keywords = "plannotator inbox messages questions agents browser pane split",
  run = function(ctx)
    if focus_inbox(ctx.session_id) then
      return
    end
    if ctx.block_id == nil then
      error("no focused pane to split", 0)
    end
    local _, err = rex.session.new_split{
      session_id = ctx.session_id,
      anchor_id = ctx.block_id,
      direction = "horizontal",
      side = "after",
      focus = false,
      layout = inbox_layout({ ctx.session_id, ctx.block_id }),
    }
    if err ~= nil then
      error(err, 0)
    end
  end,
}

rex.action{
  name = "plannotator_inbox_tab",
  title = "Plannotator Inbox in New Tab",
  description = "Open the Plannotator Inbox in a new tab, or go to the pane already showing it.",
  category = "Browser",
  keywords = "plannotator inbox messages questions agents browser tab",
  run = function(ctx)
    if focus_inbox(ctx.session_id) then
      return
    end
    local _, err = rex.session.new_window{
      session_id = ctx.session_id,
      window_label = inbox_title,
      layout = inbox_layout(),
    }
    if err ~= nil then
      error(err, 0)
    end
  end,
}

dofile(config_dir .. "/review/init.lua")
