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
local function zsh_argv(script, name, args)
  local argv = { "/bin/zsh", "-c", script, name }
  for _, arg in ipairs(args) do
    argv[#argv + 1] = arg
  end
  return argv
end

local function review_argv(args)
  local argv = { review_cli }
  for _, arg in ipairs(args) do
    argv[#argv + 1] = arg
  end
  return zsh_argv('exec "$@"', "review", argv)
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

local review_reviewers = {
  { id = "hunk", title = "Hunk", subtitle = "Review a diff", icon = "code" },
  { id = "plannotator", title = "Plannotator", subtitle = "Review a diff in plannotator-tui", icon = "document" },
}

local review_modes = {
  { id = "batch", title = "Batch", subtitle = "Hold notes until Review: Send" },
  { id = "live", title = "Live", subtitle = "Deliver each note as you save it" },
}

-- From the palette, asks for each argument left out. Returns nil when cancelled.
local function ask_review(args)
  local asked = {}
  for key, value in pairs(args) do
    asked[key] = value
  end
  if asked.reviewer == nil and asked.doc == nil then
    asked.reviewer = answered(rex.ui.pick{ title = "Reviewer", items = review_reviewers })
    if asked.reviewer == nil then return nil end
  end
  if asked.revisions == nil and asked.doc == nil then
    local range = answered(rex.ui.input{
      title = "Revisions",
      placeholder = asked.reviewer == "plannotator" and "A base like main. Empty reviews uncommitted changes."
        or "A range like main..HEAD. Empty reviews uncommitted changes.",
      confirm = "Review",
    })
    if range == nil then return nil end
    asked.revisions = range:match("^%s*(.-)%s*$")
    if asked.revisions == "" then asked.revisions = nil end
  end
  if asked.mode == nil then
    asked.mode = answered(rex.ui.pick{ title = "Review mode", items = review_modes })
    if asked.mode == nil then return nil end
  end
  return asked
end

rex.action{
  name = "review_changes",
  title = "Review Changes",
  description = "Review an agent pane's changes in Hunk, split to its right. Send, Approve, or Dismiss hands the outcome to the agent.",
  category = "Git",
  keywords = "hunk diff code review agent claude",
  args = { block = "string?", revisions = "string?", mode = "string?", reviewer = "string?", doc = "string?" },
  run = function(ctx, args)
    -- An agent's `rex do` passes what it wants and must never wait on a prompt.
    if ctx.origin == "palette" then
      args = ask_review(args)
      if args == nil then return end
    end
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
    for _, flag in ipairs({ "mode", "reviewer", "doc" }) do
      if args[flag] then
        argv[#argv + 1] = "--" .. flag
        argv[#argv + 1] = args[flag]
      end
    end
    review(ctx, argv)
  end,
}

rex.action{
  name = "review_send",
  title = "Review: Send",
  description = "Send the review's new comments to the agent, and bring the review back when its turn ends.",
  category = "Git",
  keywords = "hunk review submit comments agent",
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
  keywords = "hunk review approve lgtm agent",
  run = function(ctx)
    review(ctx, { "approve", ctx.block_id })
  end,
}

rex.action{
  name = "review_dismiss",
  title = "Review: Dismiss",
  description = "Close the review without feedback. The agent treats it as a success.",
  category = "Git",
  keywords = "hunk review dismiss close agent",
  run = function(ctx)
    review(ctx, { "dismiss", ctx.block_id })
  end,
}

-- Run by the agent. The server runs the reviewer's CLI outside the agent's
-- sandbox, which can't write tuicr's storage.
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

-- Run by the agent's watcher, from inside a sandbox that can't write the
-- review's state.
rex.action{
  name = "review_claim",
  title = "Review: Claim",
  description = "Print the review's undelivered comments, one line each, and mark them delivered.",
  category = "Git",
  run = function(ctx)
    return review(ctx, { "claim", ctx.block_id })
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
