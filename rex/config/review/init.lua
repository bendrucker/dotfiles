-- Review an agent pane's changes in a split beside it, and hand the outcome
-- back to the agent. plannotator-tui is the default app. The `review` CLI
-- beside this file runs the loop. Rex config loads it with:
--
--   dofile(config_dir .. "/review/init.lua").setup()
--
-- `setup{ keys = { send = ..., approve = ..., dismiss = ... } }` rebinds the
-- round's keys. A key set to false stays unbound.

local M = {}

local TERMINAL = "com.superlogical.terminal"
local DIR = debug.getinfo(1, "S").source:match("^@?(.*)/")
local CLI = DIR .. "/review"
local BLOCKS = os.getenv("HOME") .. "/.local/state/rex-review/blocks/"

local KEYS = { send = "cmd+s", approve = "shift+cmd+a", dismiss = "shift+cmd+x" }

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
local function argv(args)
  local list = { "/bin/zsh", "-c", 'exec "$@"', "review", CLI }
  for _, arg in ipairs(args) do
    list[#list + 1] = arg
  end
  return list
end

local function trimmed(text)
  return (text:gsub("%s+$", ""))
end

local function cli(ctx, args)
  local r, err = rex.exec(argv(args), { env = { REX_SESSION = ctx.session_id }, timeout = 25 })
  if r == nil then
    error(err, 0)
  end
  if not r.ok then
    error(r.stderr ~= "" and r.stderr or ("review exited " .. r.code), 0)
  end
  return trimmed(r.stdout)
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

local function open(ctx, args, revisions)
  local block = args.block or ctx.block_id
  local dir = block and pane_dir(block)
  if dir == nil then
    error("the agent's pane reports no directory", 0)
  end
  local list = { "open", block, "--cwd", dir }
  revisions = revisions and revisions(dir) or args.revisions
  if revisions then
    list[#list + 1] = "--revisions"
    list[#list + 1] = revisions
  end
  for _, flag in ipairs({ "mode", "app", "doc" }) do
    if args[flag] then
      list[#list + 1] = "--" .. flag
      list[#list + 1] = args[flag]
    end
  end
  cli(ctx, list)
end

local function in_review(block_id)
  local file = block_id and io.open(BLOCKS .. block_id)
  if file then
    file:close()
    return true
  end
  return false
end

local OPEN_ARGS = { block = "string?", mode = "string?", app = "string?" }

local function with(extra)
  local args = {}
  for k, v in pairs(OPEN_ARGS) do
    args[k] = v
  end
  for k, v in pairs(extra or {}) do
    args[k] = v
  end
  return args
end

local function actions()
  rex.action{
    name = "review_changes",
    title = "Review Changes",
    description = "Review an agent pane's uncommitted changes in plannotator-tui, or Hunk with app=hunk, split to its right. Send, Approve, or Dismiss hands the outcome to the agent.",
    category = "Review",
    keywords = "plannotator hunk diff code review agent claude uncommitted",
    args = with({ revisions = "string?", doc = "string?" }),
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
    args = with(),
    run = function(ctx, args)
      open(ctx, args, function(dir) return branch_base(dir) .. "..HEAD" end)
    end,
  }

  rex.action{
    name = "review_commit",
    title = "Review Last Commit",
    description = "Review the agent pane's last commit, plus uncommitted changes.",
    category = "Review",
    keywords = "plannotator diff code review agent commit head",
    args = with(),
    run = function(ctx, args)
      open(ctx, args, function() return "HEAD~1..HEAD" end)
    end,
  }

  rex.action{
    name = "review_send",
    title = "Review: Send",
    description = "Send the review's new comments to the agent, and bring the review back when its turn ends.",
    category = "Review",
    keywords = "plannotator hunk review submit comments agent",
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
    keywords = "plannotator hunk review approve lgtm agent",
    run = function(ctx)
      cli(ctx, { "approve", ctx.block_id })
    end,
  }

  rex.action{
    name = "review_dismiss",
    title = "Review: Dismiss",
    description = "Close the review without feedback. The agent treats it as a success.",
    category = "Review",
    keywords = "plannotator hunk review dismiss close agent",
    run = function(ctx)
      cli(ctx, { "dismiss", ctx.block_id })
    end,
  }

  -- Run by the agent. The server runs the app's CLI outside the agent's
  -- sandbox, which can't reach the app's storage.
  rex.action{
    name = "review_reply",
    title = "Review: Reply",
    description = "Answer a review comment from the agent's pane.",
    category = "Review",
    args = { id = "string", text = "string" },
    run = function(ctx, args)
      cli(ctx, { "reply", ctx.block_id, args.id, args.text })
    end,
  }

  -- Run by the agent's watcher, from inside a sandbox that can't write the
  -- review's state.
  rex.action{
    name = "review_claim",
    title = "Review: Claim",
    description = "Print the review's undelivered comments, one line each, and mark them delivered.",
    category = "Review",
    run = function(ctx)
      return cli(ctx, { "claim", ctx.block_id })
    end,
  }
end

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

function M.setup(opts)
  local keys = {}
  for name, key in pairs(KEYS) do
    keys[name] = key
  end
  for name, key in pairs((opts or {}).keys or {}) do
    keys[name] = key
  end
  actions()
  for name, key in pairs(keys) do
    if key then
      bind(key, "review_" .. name)
    end
  end
end

return M
