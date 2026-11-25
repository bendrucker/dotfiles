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

rex.action{
  name = "claude_attach",
  title = "Attach Claude Session",
  description = "Pick a Claude session, waiting ones first, and go to its pane, or attach it in a new tab of its repo's session.",
  category = "Claude",
  keywords = "claude agents background bg attach session pick",
  run = function(ctx)
    -- With several apps connected, the script brings the pick up in the one
    -- that ran this action. A pane or float goes beside the pane focused when
    -- the action ran, not the picker's own.
    local _, err = rex.session.new_layer{
      bounds = { 0.2, 0.25, 0.6, 0.5 },
      focus = true,
      layout = rex.layout.block{
        flavor = "com.superlogical.terminal.shell",
        options = {
          command = zsh_argv(
            '[[ -n $1 ]] && export REX_CLIENT=$1; rex-claude-attach --pick --beside "$2" || read -sk "?Press any key to close"',
            "rex-claude-attach",
            { ctx.client_id or "", ctx.block_id or "" }
          ),
        },
      },
    }
    if err ~= nil then
      error(err, 0)
    end
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
-- the Inbox's text about twice its usual size. A helper beside it presses the
-- zoom-out shortcut until a CSS pixel is about two device pixels, as on a
-- Retina display. A new tab stays 80x24 until an app draws it, so the script
-- waits for the drawn size first. The Inbox's port can change when it
-- restarts, so the URL is read at launch.
local inbox_title = "Plannotator Inbox"
local inbox_script = [=[
for _ in {1..30}; do [[ $(stty size) != "24 80" ]] && break; sleep 0.1; done
url=$(plannotator inbox --background 2>/dev/null) || { read -sk "?Press any key to close"; exit 1; }
{
  for _ in {1..50}; do
    ratio=$(terminal-browser action -- eval devicePixelRatio) && break
    sleep 0.2
  done
  for _ in {1..8}; do
    (( ${ratio:-0} > 2.2 )) || break
    rex send-key -b "$REX_BLOCK" 'ctrl+[Minus]'
    sleep 0.3
    ratio=$(terminal-browser action -- eval devicePixelRatio)
  done
} &>/dev/null &!
exec terminal-browser open "$url" --no-merge
]=]

rex.action{
  name = "plannotator_inbox",
  title = "Plannotator Inbox",
  description = "Open the Plannotator Inbox in terminal-browser in a new tab, or go to the tab already showing it.",
  category = "Browser",
  keywords = "plannotator inbox messages questions agents browser tab",
  run = function(ctx)
    local view, err = rex.session.view{ session_id = ctx.session_id }
    if view == nil then
      error(err, 0)
    end
    for _, window in ipairs(view.windows or {}) do
      if window.label == inbox_title then
        local _, focus_err = rex.session.focus_window{ session_id = ctx.session_id, window_id = window.window_id }
        if focus_err ~= nil then
          error(focus_err, 0)
        end
        return
      end
    end
    local _, new_err = rex.session.new_window{
      session_id = ctx.session_id,
      window_label = inbox_title,
      layout = rex.layout.block{
        flavor = "com.superlogical.terminal.shell",
        options = { command = zsh_argv(inbox_script, "plannotator-inbox", {}) },
      },
    }
    if new_err ~= nil then
      error(new_err, 0)
    end
  end,
}

rex.bind("ctrl+cmd+i", "plannotator_inbox")

dofile(config_dir .. "/review/init.lua")
