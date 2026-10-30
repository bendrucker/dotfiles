local terminal = "com.superlogical.terminal"
local config_dir = debug.getinfo(1, "S").source:match("^@?(.*)/")

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

rex.action{
  name = "review_changes",
  title = "Review Changes",
  description = "Review the focused pane's uncommitted changes in tuicr to its left. Exporting with y pastes the review back into the pane.",
  category = "Git",
  keywords = "tuicr diff code review agent claude",
  run = function(ctx)
    local dir = ctx.block_id and block_dir(ctx.block_id)
    if dir == nil then
      error("the focused pane reports no directory", 0)
    end

    local _, err = rex.session.new_split{
      anchor_id = ctx.block_id,
      direction = "horizontal",
      side = "before",
      ratio = 2 / 3,
      focus = true,
      layout = rex.layout.block{
        flavor = "com.superlogical.terminal.shell",
        options = {
          cwd = dir,
          command = { config_dir .. "/review-pane", ctx.block_id, "--working-tree" },
        },
      },
    }
    if err ~= nil then
      error(err, 0)
    end
  end,
}
