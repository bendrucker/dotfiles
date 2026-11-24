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

dofile(config_dir .. "/review/init.lua").setup()
