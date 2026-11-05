local terminal = "com.superlogical.terminal"
local config_dir = debug.getinfo(1, "S").source:match("^@?(.*)/")
local review_cli = config_dir .. "/review/review"
local review_blocks = os.getenv("HOME") .. "/.local/state/rex-review/blocks/"

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
local function review_argv(args)
  local argv = { "/bin/zsh", "-c", 'exec "$@"', "review", review_cli }
  for _, arg in ipairs(args) do
    argv[#argv + 1] = arg
  end
  return argv
end

local function review(ctx, args)
  local r, err = rex.exec(review_argv(args), { env = { REX_SESSION = ctx.session_id }, timeout = 25 })
  if r == nil then
    error(err, 0)
  end
  if not r.ok then
    error(r.stderr ~= "" and r.stderr or ("review exited " .. r.code), 0)
  end
  return (r.stdout:gsub("%s+$", ""))
end

local function in_review(block_id)
  local file = block_id and io.open(review_blocks .. block_id)
  if file then
    file:close()
    return true
  end
  return false
end

rex.action{
  name = "review_changes",
  title = "Review Changes",
  description = "Review an agent pane's changes in tuicr, split to its left. Send, Approve, or Dismiss hands the outcome to the agent.",
  category = "Git",
  keywords = "tuicr diff code review agent claude",
  args = { block = "string?", revisions = "string?" },
  run = function(ctx, args)
    local block = args.block or ctx.block_id
    local dir = block and block_dir(block)
    if dir == nil then
      error("the agent's pane reports no directory", 0)
    end
    local argv = { "open", block, "--cwd", dir }
    if args.revisions then
      argv[#argv + 1] = "--revisions"
      argv[#argv + 1] = args.revisions
    end
    review(ctx, argv)
  end,
}

rex.action{
  name = "review_send",
  title = "Review: Send",
  description = "Send the review's new comments to the agent, and bring the review back when its turn ends.",
  category = "Git",
  keywords = "tuicr review submit comments agent",
  run = function(ctx)
    local id = review(ctx, { "send", ctx.block_id })
    local waiter, err = rex.exec.start(review_argv({ "wait", id }), {
      env = { REX_SESSION = ctx.session_id },
      detach = true,
      stdout = false,
      stderr = false,
    })
    if waiter == nil then
      error(err, 0)
    end
  end,
}

rex.action{
  name = "review_approve",
  title = "Review: Approve",
  description = "Tell the agent the review approved its changes, and close the review.",
  category = "Git",
  keywords = "tuicr review approve lgtm agent",
  run = function(ctx)
    review(ctx, { "approve", ctx.block_id })
  end,
}

rex.action{
  name = "review_dismiss",
  title = "Review: Dismiss",
  description = "Close the review without feedback. The agent treats it as a success.",
  category = "Git",
  keywords = "tuicr review dismiss close agent",
  run = function(ctx)
    review(ctx, { "dismiss", ctx.block_id })
  end,
}

-- Run by the agent. The server runs the reviewer's CLI outside the agent's
-- sandbox, which can't write the reviewer's storage.
rex.action{
  name = "review_reply",
  title = "Review: Reply",
  description = "Answer a review comment from the agent's pane.",
  category = "Git",
  args = { id = "string", text = "string" },
  run = function(ctx, args)
    review(ctx, { "reply", ctx.block_id, args.id, args.text })
  end,
}

-- Outside a review's two panes, the key goes to the program.
local function bind_review(key, action)
  rex.bind(key, function(ctx)
    if not in_review(ctx.block_id) then
      return false
    end
    local _, err = rex.invoke(action)
    if err ~= nil then
      rex.log("warn", action .. ": " .. tostring(err))
    end
    return true
  end)
end

bind_review("cmd+s", "review_send")
bind_review("shift+cmd+a", "review_approve")
bind_review("shift+cmd+x", "review_dismiss")
