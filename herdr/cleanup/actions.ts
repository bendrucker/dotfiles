import type { Row } from "./rows";

export const WAKE_TEXT = [
  "[herdr-cleanup] PR state may be stale.",
  "Re-check CI, reviews, and merge status, then continue toward merging. If blocked, say what you need from me.",
].join("\n");

export type Outcome = "done" | "cancelled" | "failed";

export interface Result {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Runs a command. `terminal: "all"` hands it the terminal. `terminal: "stderr"`
 * is for a gum prompt that draws on stderr and answers on stdout.
 */
export type Runner = (cmd: string[], options?: { cwd?: string; terminal?: "all" | "stderr" }) => Result;

export const spawn: Runner = (cmd, options = {}) => {
  try {
    const child = Bun.spawnSync({
      cmd,
      cwd: options.cwd,
      env: process.env,
      stdin: "inherit",
      stdout: options.terminal === "all" ? "inherit" : "pipe",
      stderr: options.terminal === undefined ? "pipe" : "inherit",
    });
    return { ok: child.exitCode === 0, stdout: child.stdout?.toString() ?? "", stderr: child.stderr?.toString() ?? "" };
  } catch (error) {
    return { ok: false, stdout: "", stderr: String(error) };
  }
};

function fail(message: string): Outcome {
  console.error(`herdr-cleanup: ${message}`);
  return "failed";
}

// Codes from herdr's JSON error that a user reads better in plain words.
const HERDR_REASONS: Record<string, string> = {
  agent_not_ready: "the agent isn't at its prompt, nothing was sent",
  agent_not_found: "no agent is running there any more, nothing was sent",
};

// herdr reports a refused request as one JSON object on stderr.
function reason(result: Result): string {
  const text = result.stderr.trim();
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && "error" in parsed) {
      const { error } = parsed;
      if (typeof error === "object" && error !== null) {
        if ("code" in error && typeof error.code === "string" && error.code in HERDR_REASONS) return HERDR_REASONS[error.code] ?? "";
        if ("message" in error && typeof error.message === "string") return error.message;
      }
    }
  } catch {
    // Not JSON, so the raw text is the best there is.
  }
  return text.split("\n").at(-1) || "no reason given";
}

export function go(row: Row, run: Runner): Outcome {
  if (row.agentPane !== undefined && run(["herdr", "agent", "focus", row.agentPane]).ok) return "done";
  const focused = run(["herdr", "workspace", "focus", row.workspaceId]);
  return focused.ok ? "done" : fail(`could not focus ${row.label}: ${reason(focused)}`);
}

export function confirmText(row: Row): string {
  const lines = [`Prune ${row.label}? ${row.flags.join(", ")}`];
  const shown = row.ignored.slice(0, 10);
  if (shown.length > 0) lines.push("", "Ignored files that go to the Trash with it:", ...shown.map((p) => `  ${p}`));
  if (row.ignored.length > shown.length) lines.push(`  …and ${row.ignored.length - shown.length} more`);
  return lines.join("\n");
}

// The checkout goes to the Trash before Worktrunk sees it, so whatever it held
// stays recoverable, and `wt remove` only has a stale entry and a branch left.
export function prune(row: Row, run: Runner): Outcome {
  if (row.flags.length > 0) {
    if (!run(["gum", "confirm", "--default=false", confirmText(row)], { terminal: "all" }).ok) return "cancelled";
  }
  run(["herdr", "workspace", "close", row.workspaceId]);
  const trashed = run(["trash", row.path]);
  if (!trashed.ok) return fail(`could not move ${row.path} to the Trash, leaving it in place: ${reason(trashed)}`);
  const removed = run(["wt", "-C", row.repoRoot, "remove", row.branch, "--foreground", "--yes"]);
  if (!removed.ok) return fail(`${row.path} is in the Trash, but wt remove failed for ${row.branch}: ${reason(removed)}`);
  return "done";
}

export function close(row: Row, run: Runner): Outcome {
  if (row.pr === undefined) return fail(`${row.label} has no pull request to close`);
  if (row.pr.state !== "OPEN") return fail(`${row.pr.ref} is already ${row.pr.state.toLowerCase()}, so press p to prune`);
  if (row.forge === undefined) return fail(`${row.label}'s origin is neither GitHub nor GitLab, so ${row.pr.ref} can't be closed from here`);
  const number = String(row.pr.number);
  const cmd = row.forge === "github" ? ["gh", "pr", "close", number] : ["glab", "mr", "close", number];
  const question = [`Close ${row.pr.ref} and prune ${row.label}?`];
  if (row.flags.length > 0) question.push("", confirmText(row));
  if (!run(["gum", "confirm", "--default=false", question.join("\n")], { terminal: "all" }).ok) return "cancelled";
  const closed = run(cmd, { cwd: row.path });
  if (!closed.ok) return fail(`could not close ${row.pr.ref}: ${reason(closed)}`);
  return prune({ ...row, flags: [] }, run);
}

export function wake(row: Row, run: Runner): Outcome {
  if (row.agentPane === undefined) return fail(`${row.label} has no agent pane to wake`);
  const edited = run(["gum", "write", "--width=0", "--height=6", `--value=${WAKE_TEXT}`], { terminal: "stderr" });
  const text = edited.stdout.trim();
  if (!edited.ok || text === "") return "cancelled";
  const sent = run(["herdr", "agent", "prompt", row.agentPane, text]);
  return sent.ok ? "done" : fail(`herdr refused the prompt for ${row.label}: ${reason(sent)}`);
}
