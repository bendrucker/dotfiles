import type { Row } from "./rows";

export const WAKE_TEXT = [
  "[herdr-cleanup] Your PR needs work.",
  "Re-check CI, reviews, and merge conflicts, then continue toward merging. If blocked, say what you need from me.",
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

// The board's flags come from a wt list that can be minutes old, so the safety
// check reads the checkout again at the moment of removal, branch included. A
// read that fails becomes a flag of its own, which forces the confirmation.
export function current(row: Row, run: Runner): Row {
  const flags = row.live ? ["live"] : [];
  const status = run(["git", "-C", row.path, "status", "--porcelain", "--ignored"]);
  const lines = status.stdout.split("\n").filter(Boolean);
  const ignored = lines.filter((line) => line.startsWith("!! ")).map((line) => line.slice(3));
  // A merged branch's remote ref is usually deleted, but wt found its content
  // in the default branch, so only commits made since then are at risk.
  const base = row.step === "prune" && row.head ? [`${row.head}..HEAD`] : ["HEAD", "--not", "--remotes"];
  const ahead = run(["git", "-C", row.path, "rev-list", "--count", ...base]);
  const unpushed = Number.parseInt(ahead.stdout, 10);
  const branch = run(["git", "-C", row.path, "branch", "--show-current"]).stdout.trim();
  if (!status.ok || !ahead.ok || Number.isNaN(unpushed)) flags.push("unreadable");
  if (lines.some((line) => !line.startsWith("!! "))) flags.push("dirty");
  if (unpushed > 0) flags.push(`unpushed:${unpushed}`);
  if (ignored.length > 0) flags.push(`ignored:${ignored.length}`);
  return { ...row, branch, flags, ignored };
}

// The checkout goes to the Trash before Worktrunk sees it, so whatever it held
// stays recoverable, and `wt remove` only has a stale entry and a branch left.
// The workspace closes last: the board may be running inside it.
function remove(row: Row, run: Runner): Outcome {
  const trashed = run(["trash", row.path]);
  if (!trashed.ok) return fail(`could not move ${row.path} to the Trash, leaving it in place: ${reason(trashed)}`);
  const removed = run(["wt", "-C", row.repoRoot, "remove", row.branch, "--foreground", "--yes"]);
  if (!removed.ok) return fail(`${row.path} is in the Trash, but wt remove failed for ${row.branch}: ${reason(removed)}`);
  const closed = run(["herdr", "workspace", "close", row.workspaceId]);
  if (!closed.ok) return fail(`${row.label} is removed, but its workspace would not close: ${reason(closed)}`);
  return "done";
}

// The pull request on the row belongs to the branch the forge was asked about,
// so a checkout that has moved since then has none the board knows of.
function moved(row: Row, now: Row): string | undefined {
  if (now.branch === "") return `${row.label} has no branch checked out`;
  if (now.branch !== row.branch) return `${row.label} is on ${now.branch} now, not ${row.branch}, so press r first`;
  return undefined;
}

export function prune(row: Row, run: Runner): Outcome {
  if (row.step !== "prune") return fail(`${row.label} is not merged or closed (${row.reason}), so p leaves it alone`);
  const now = current(row, run);
  const why = moved(row, now);
  if (why) return fail(`${why}. Nothing was removed`);
  if (now.flags.length > 0) {
    if (!run(["gum", "confirm", "--default=false", confirmText(now)], { terminal: "all" }).ok) return "cancelled";
  }
  return remove(now, run);
}

export function close(row: Row, run: Runner): Outcome {
  if (row.pr === undefined) return fail(`${row.label} has no pull request to close`);
  if (row.forge === undefined) return fail(`${row.label}'s origin is neither GitHub nor GitLab, so ${row.pr.ref} can't be closed from here`);
  const now = current(row, run);
  const why = moved(row, now);
  if (why) return fail(`${why}. Nothing was closed`);
  const number = String(row.pr.number);
  const cmd = row.forge === "github" ? ["gh", "pr", "close", number] : ["glab", "mr", "close", number];
  const question = [`Close ${row.pr.ref} and prune ${row.label}?`];
  if (now.flags.length > 0) question.push("", confirmText(now));
  if (!run(["gum", "confirm", "--default=false", question.join("\n")], { terminal: "all" }).ok) return "cancelled";
  const closed = run(cmd, { cwd: row.path });
  if (!closed.ok) return fail(`could not close ${row.pr.ref}: ${reason(closed)}`);
  return remove(now, run);
}

export function wake(row: Row, run: Runner): Outcome {
  if (row.agentPane === undefined) return fail(`${row.label} has no agent pane to wake`);
  // At --width=0 gum stops wrapping and opens scrolled to the cursor at the end,
  // which hides the [herdr-cleanup] tag the prompt is meant to show.
  const width = Math.max(40, (process.stderr.columns ?? 80) - 4);
  const editor = ["gum", "write", `--width=${width}`, "--height=6", "--char-limit=0", `--value=${WAKE_TEXT}`];
  const edited = run(editor, { terminal: "stderr" });
  const text = edited.stdout.trim();
  if (!edited.ok || text === "") return "cancelled";
  const sent = run(["herdr", "agent", "prompt", row.agentPane, text]);
  return sent.ok ? "done" : fail(`herdr refused the prompt for ${row.label}: ${reason(sent)}`);
}
