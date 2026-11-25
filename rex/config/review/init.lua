-- Review an agent pane's changes in a split beside it, and hand the outcome
-- back to the agent. plannotator-tui is the default app and sends feedback
-- itself. The `review` CLI beside this file couples Hunk to the agent. Rex
-- config loads it with:
--
--   dofile(config_dir .. "/review/init.lua")

local TERMINAL = "com.superlogical.terminal"
local DIR = debug.getinfo(1, "S").source:match("^@?(.*)/")
local CLI = DIR .. "/review"
local BLOCKS = os.getenv("HOME") .. "/.local/state/rex-review/blocks/"

-- The foreground program's cwd follows an agent into a worktree it switched
-- to, which the shell's last reported directory doesn't.
local function pane_dir(block_id)
  local process = rex.block.call(TERMINAL, "process", { block_id = block_id })
  local foreground = process and process.foreground
  if foreground and foreground.cwd then
    return foreground.cwd
  end
  local reported = rex.block.call(TERMINAL, "pwd", { block_id = block_id })
  local pwd = reported and reported.pwd
  return pwd and (pwd:match("^file://[^/]*(/.*)$") or pwd)
end

-- The server's PATH lacks Homebrew and bun. zsh reads ~/.zshenv, which sets them.
local function zsh(program, args)
  local list = { "/bin/zsh", "-c", 'exec "$@"', "review", program }
  for _, arg in ipairs(args) do
    list[#list + 1] = arg
  end
  return list
end

local function argv(args)
  return zsh(CLI, args)
end

local function trimmed(text)
  return (text:gsub("%s+$", ""))
end

local function run(ctx, list)
  local r, err = rex.exec(list, { env = { REX_SESSION = ctx.session_id }, timeout = 25 })
  if r == nil then
    error(err, 0)
  end
  if not r.ok then
    error(r.stderr ~= "" and r.stderr or (list[5] .. " exited " .. r.code), 0)
  end
  return trimmed(r.stdout)
end

local function cli(ctx, args)
  return run(ctx, argv(args))
end

local function git(dir, ...)
  local r = rex.exec({ "git", "-C", dir, ... }, { timeout = 5 })
  if r == nil or not r.ok then
    return nil
  end
  return trimmed(r.stdout)
end

-- The commit this branch left its base at. Commits the base gained since
-- stay out of the review.
local function branch_base(dir)
  local base = git(dir, "rev-parse", "--abbrev-ref", "origin/HEAD") or "origin/main"
  local fork = git(dir, "merge-base", "HEAD", base)
  if fork == nil then
    error("this branch shares no history with " .. base, 0)
  end
  return fork
end

-- `base` computes the base ref from the pane's directory.
local function open(ctx, args, base)
  local block = args.block or ctx.block_id
  local dir = block and pane_dir(block)
  if dir == nil then
    error("the agent's pane reports no directory", 0)
  end
  local ref = base and base(dir) or args.base
  if args.app == "hunk" then
    local list = { "open", block, "--cwd", dir }
    for flag, value in pairs({ base = ref, mode = args.mode }) do
      list[#list + 1] = "--" .. flag
      list[#list + 1] = value
    end
    return cli(ctx, list)
  end
  if args.app ~= nil and args.app ~= "plannotator" then
    error("app is hunk or plannotator", 0)
  end
  local list = { "rex", "review" }
  if args.doc then
    list = { "rex", "open", args.doc:sub(1, 1) == "/" and args.doc or (dir .. "/" .. args.doc), "--gate" }
  elseif ref then
    list[#list + 1] = "--base"
    list[#list + 1] = ref
  end
  for _, arg in ipairs({ "--block", block, "--session", ctx.session_id, "--placement", "split" }) do
    list[#list + 1] = arg
  end
  run(ctx, zsh("plannotator-tui", list))
end

local function in_review(block_id)
  local file = block_id and io.open(BLOCKS .. block_id)
  if file then
    file:close()
    return true
  end
  return false
end

rex.action{
  name = "review_changes",
  title = "Review Changes",
  description = "Review an agent pane's uncommitted changes in plannotator-tui, or Hunk with app=hunk, split to its right. doc=FILE reviews a document with an Approve gate.",
  category = "Review",
  keywords = "plannotator hunk diff code review agent claude uncommitted",
  args = { block = "string?", base = "string?", mode = "string?", app = "string?", doc = "string?" },
  run = function(ctx, args)
    open(ctx, args)
  end,
}

rex.action{
  name = "review_branch",
  title = "Review Branch",
  description = "Review everything the agent pane's branch changed since it left the default branch, plus uncommitted changes.",
  category = "Review",
  keywords = "plannotator diff code review agent branch pull request pr",
  args = { block = "string?", mode = "string?", app = "string?" },
  run = function(ctx, args)
    open(ctx, args, branch_base)
  end,
}

rex.action{
  name = "review_commit",
  title = "Review Last Commit",
  description = "Review the agent pane's last commit, plus uncommitted changes.",
  category = "Review",
  keywords = "plannotator diff code review agent commit head",
  args = { block = "string?", mode = "string?", app = "string?" },
  run = function(ctx, args)
    open(ctx, args, function() return "HEAD~1" end)
  end,
}

rex.action{
  name = "review_send",
  title = "Review: Send",
  description = "Send the review's new comments to the agent, and bring the review back when its turn ends.",
  category = "Review",
  keywords = "hunk review submit comments agent",
  run = function(ctx)
    local id = cli(ctx, { "send", ctx.block_id })
    local waiter, err = rex.exec.start(argv({ "wait", id }), {
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
  category = "Review",
  keywords = "hunk review approve lgtm agent",
  run = function(ctx)
    cli(ctx, { "approve", ctx.block_id })
  end,
}

rex.action{
  name = "review_dismiss",
  title = "Review: Dismiss",
  description = "Close the review without feedback. The agent treats it as a success.",
  category = "Review",
  keywords = "hunk review dismiss close agent",
  run = function(ctx)
    cli(ctx, { "dismiss", ctx.block_id })
  end,
}

-- Run by the agent. The server runs the app's CLI outside the agent's
-- sandbox, which can't reach the app's storage.
rex.action{
  name = "review_reply",
  title = "Review: Reply",
  description = "Answer a Hunk review comment by its id, from the agent's pane.",
  category = "Review",
  args = { id = "string", text = "string" },
  run = function(ctx, args)
    cli(ctx, { "reply", ctx.block_id, args.id, args.text })
  end,
}

-- Outside a review's two panes, the key goes to the program.
local function bind(key, action)
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

bind("cmd+s", "review_send")
bind("shift+cmd+a", "review_approve")
bind("shift+cmd+x", "review_dismiss")
