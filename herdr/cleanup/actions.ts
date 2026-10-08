import type { Row } from "./rows";

export const WAKE_TEXT = [
  "[herdr-cleanup] PR state may be stale.",
  "Re-check CI, reviews, and merge status, then continue toward merging. If blocked, say what you need from me.",
].join("\n");

export interface Result {
  ok: boolean;
  stdout: string;
}

/** Runs a command. `interactive` hands it the terminal, for gum. */
export type Runner = (cmd: string[], options?: { cwd?: string; interactive?: boolean }) => Result;

export const spawn: Runner = (cmd, options = {}) => {
  try {
    const child = Bun.spawnSync({
      cmd,
      cwd: options.cwd,
      env: process.env,
      stdin: "inherit",
      stdout: options.interactive ? "inherit" : "pipe",
      stderr: "inherit",
    });
    return { ok: child.exitCode === 0, stdout: child.stdout?.toString() ?? "" };
  } catch {
    return { ok: false, stdout: "" };
  }
};

function say(message: string): void {
  console.error(`herdr-cleanup: ${message}`);
}

export function go(row: Row, run: Runner): boolean {
  if (row.agentPane !== undefined && run(["herdr", "agent", "focus", row.agentPane]).ok) return true;
  return run(["herdr", "workspace", "focus", row.workspaceId]).ok;
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
export function prune(row: Row, run: Runner): boolean {
  if (row.flags.length > 0) {
    if (!run(["gum", "confirm", "--default=false", confirmText(row)], { interactive: true }).ok) return false;
  }
  run(["herdr", "workspace", "close", row.workspaceId]);
  if (!run(["trash", row.path]).ok) {
    say(`could not move ${row.path} to the Trash, leaving it in place`);
    return false;
  }
  if (!run(["wt", "-C", row.repoRoot, "remove", row.branch, "--foreground", "--yes"]).ok) {
    say(`${row.path} is in the Trash, but wt remove failed for ${row.branch}`);
    return false;
  }
  return true;
}

export function close(row: Row, run: Runner): boolean {
  if (row.pr === undefined || row.forge === undefined) {
    say(`${row.label} has no pull request to close`);
    return false;
  }
  const number = String(row.pr.number);
  const cmd = row.forge === "github" ? ["gh", "pr", "close", number] : ["glab", "mr", "close", number];
  const question = [`Close ${row.pr.ref} and prune ${row.label}?`];
  if (row.flags.length > 0) question.push("", confirmText(row));
  if (!run(["gum", "confirm", "--default=false", question.join("\n")], { interactive: true }).ok) return false;
  if (!run(cmd, { cwd: row.path }).ok) {
    say(`could not close ${row.pr.ref}`);
    return false;
  }
  return prune({ ...row, flags: [] }, run);
}

export function wake(row: Row, run: Runner): boolean {
  if (row.agentPane === undefined) {
    say(`${row.label} has no agent pane to wake`);
    return false;
  }
  const edited = run(["gum", "write", "--width=80", "--height=6", `--value=${WAKE_TEXT}`], { interactive: false });
  const text = edited.stdout.trim();
  if (!edited.ok || text === "") return false;
  if (!run(["herdr", "agent", "prompt", row.agentPane, text]).ok) {
    say(`herdr refused the prompt for ${row.label}; a blocked agent takes no prompt until it is answered`);
    return false;
  }
  return true;
}
