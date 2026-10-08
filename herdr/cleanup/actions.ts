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

// The board's flags come from a cache that can be minutes old, so the safety
// check reads the checkout again at the moment of removal. A read that fails
// becomes a flag of its own, which forces the confirmation.
export function current(row: Row, run: Runner): Row {
  const flags = row.flags.filter((flag) => flag === "live");
  const status = run(["git", "-C", row.path, "status", "--porcelain", "--ignored"]);
  const lines = status.stdout.split("\n").filter(Boolean);
  const ignored = lines.filter((line) => line.startsWith("!! ")).map((line) => line.slice(3));
  // The forge's copy of the branch is the baseline, since a merged branch's
  // remote ref is usually deleted. Without one, any remote will do.
  const base = row.pr?.head ? [`${row.pr.head}..HEAD`] : ["HEAD", "--not", "--remotes"];
  const ahead = run(["git", "-C", row.path, "rev-list", "--count", ...base]);
  const unpushed = Number.parseInt(ahead.stdout, 10);
  if (!status.ok || !ahead.ok || Number.isNaN(unpushed)) flags.push("unreadable");
  if (lines.some((line) => !line.startsWith("!! "))) flags.push("dirty");
  if (unpushed > 0) flags.push(`unpushed:${unpushed}`);
  if (ignored.length > 0) flags.push(`ignored:${ignored.length}`);
  return { ...row, flags, ignored };
}

// The checkout goes to the Trash before Worktrunk sees it, so whatever it held
// stays recoverable, and `wt remove` only has a stale entry and a branch left.
function remove(row: Row, run: Runner): Outcome {
  const closed = run(["herdr", "workspace", "close", row.workspaceId]);
  if (!closed.ok) return fail(`could not close the ${row.label} workspace, leaving the checkout in place: ${reason(closed)}`);
  const trashed = run(["trash", row.path]);
  if (!trashed.ok) return fail(`could not move ${row.path} to the Trash, leaving it in place: ${reason(trashed)}`);
  const removed = run(["wt", "-C", row.repoRoot, "remove", row.branch, "--foreground", "--yes"]);
  if (!removed.ok) return fail(`${row.path} is in the Trash, but wt remove failed for ${row.branch}: ${reason(removed)}`);
  return "done";
}

export function prune(row: Row, run: Runner): Outcome {
  const now = current(row, run);
  if (now.flags.length > 0) {
    if (!run(["gum", "confirm", "--default=false", confirmText(now)], { terminal: "all" }).ok) return "cancelled";
  }
  return remove(now, run);
}

export function close(row: Row, run: Runner): Outcome {
  if (row.pr === undefined) return fail(`${row.label} has no pull request to close`);
  if (row.pr.state !== "OPEN") return fail(`${row.pr.ref} is already ${row.pr.state.toLowerCase()}, so press p to prune`);
  if (row.forge === undefined) return fail(`${row.label}'s origin is neither GitHub nor GitLab, so ${row.pr.ref} can't be closed from here`);
  const number = String(row.pr.number);
  const cmd = row.forge === "github" ? ["gh", "pr", "close", number] : ["glab", "mr", "close", number];
  const now = current(row, run);
  const question = [`Close ${row.pr.ref} and prune ${row.label}?`];
  if (now.flags.length > 0) question.push("", confirmText(now));
  if (!run(["gum", "confirm", "--default=false", question.join("\n")], { terminal: "all" }).ok) return "cancelled";
  const closed = run(cmd, { cwd: row.path });
  if (!closed.ok) return fail(`could not close ${row.pr.ref}: ${reason(closed)}`);
  return remove(now, run);
}

export function wake(row: Row, run: Runner): Outcome {
  if (row.agentPane === undefined) return fail(`${row.label} has no agent pane to wake`);
  const edited = run(["gum", "write", "--width=0", "--height=6", `--value=${WAKE_TEXT}`], { terminal: "stderr" });
  const text = edited.stdout.trim();
  if (!edited.ok || text === "") return "cancelled";
  const sent = run(["herdr", "agent", "prompt", row.agentPane, text]);
  return sent.ok ? "done" : fail(`herdr refused the prompt for ${row.label}: ${reason(sent)}`);
}
