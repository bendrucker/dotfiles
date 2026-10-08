import { describe, expect, test } from "bun:test";
import { close, confirmText, go, prune, wake, WAKE_TEXT, type Outcome, type Runner } from "./actions";
import type { Row } from "./rows";

function makeRow(overrides: Partial<Row> = {}): Row {
  return {
    workspaceId: "w1",
    label: "topic",
    path: "/src/.worktrees/repo/topic",
    repoRoot: "/src/repo",
    repoName: "repo",
    branch: "topic",
    forge: "github",
    pr: { number: 7, state: "MERGED", ref: "repo#7" },
    agentPane: "w1:p2",
    step: "prune",
    reason: "merged",
    flags: [],
    ignored: [],
    ...overrides,
  };
}

// Records every command and fails the ones named in `failing`. `gum write`
// answers with whatever `written` holds.
function recorder(failing: string[] = [], written = WAKE_TEXT, refusal = ""): { run: Runner; calls: string[] } {
  const calls: string[] = [];
  const run: Runner = (cmd) => {
    const line = cmd.join(" ");
    calls.push(line);
    const ok = !failing.some((prefix) => line.startsWith(prefix));
    if (line.startsWith("gum write")) return { ok, stdout: written, stderr: "" };
    return { ok, stdout: "", stderr: ok ? "" : refusal };
  };
  return { run, calls };
}

describe("prune", () => {
  test("trashes the checkout before handing the stale entry to wt", () => {
    const { run, calls } = recorder();
    expect(prune(makeRow(), run)).toBe("done");
    expect(calls).toEqual([
      "herdr workspace close w1",
      "trash /src/.worktrees/repo/topic",
      "wt -C /src/repo remove topic --foreground --yes",
    ]);
  });

  test.each<{ name: string; failing: string[]; ran: number; outcome: Outcome }>([
    { name: "asks first and stops on no when a flag is set", failing: ["gum confirm"], ran: 1, outcome: "cancelled" },
    { name: "never calls wt when the Trash refuses", failing: ["trash"], ran: 3, outcome: "failed" },
  ])("$name", ({ failing, ran, outcome }) => {
    const { run, calls } = recorder(failing);
    expect(prune(makeRow({ flags: ["dirty"] }), run)).toBe(outcome);
    expect(calls).toHaveLength(ran);
    expect(calls.some((c) => c.startsWith("wt "))).toBe(false);
  });
});

test("the confirmation lists the flags and at most ten ignored paths", () => {
  const ignored = Array.from({ length: 12 }, (_, i) => `tmp/${i}.log`);
  expect(confirmText(makeRow({ label: "topic", flags: ["live", "ignored:12"], ignored }))).toMatchInlineSnapshot(`
    "Prune topic? live, ignored:12

    Ignored files that go to the Trash with it:
      tmp/0.log
      tmp/1.log
      tmp/2.log
      tmp/3.log
      tmp/4.log
      tmp/5.log
      tmp/6.log
      tmp/7.log
      tmp/8.log
      tmp/9.log
      …and 2 more"
  `);
});

describe("close", () => {
  test.each<{ forge: "github" | "gitlab"; command: string }>([
    { forge: "github", command: "gh pr close 7" },
    { forge: "gitlab", command: "glab mr close 7" },
  ])("closes on $forge and prunes without asking twice", ({ forge, command }) => {
    const { run, calls } = recorder();
    expect(close(makeRow({ forge, flags: ["dirty"] }), run)).toBe("done");
    expect(calls.filter((c) => c.startsWith("gum confirm"))).toHaveLength(1);
    expect(calls).toContain(command);
    expect(calls.at(-1)).toStartWith("wt -C");
  });

  test("leaves the worktree when the forge refuses", () => {
    const { run, calls } = recorder(["gh pr close"]);
    expect(close(makeRow(), run)).toBe("failed");
    expect(calls.some((c) => c.startsWith("trash"))).toBe(false);
  });
});

describe("wake", () => {
  test("sends the edited text to the agent pane", () => {
    const { run, calls } = recorder([], "[herdr-cleanup] rebase first\n");
    expect(wake(makeRow(), run)).toBe("done");
    expect(calls.at(-1)).toBe("herdr agent prompt w1:p2 [herdr-cleanup] rebase first");
  });

  test("reports why herdr refused the prompt", () => {
    const refusal = JSON.stringify({ error: { code: "agent_not_ready", message: "agent w1:p2 is blocked" } });
    const { run } = recorder(["herdr agent prompt"], WAKE_TEXT, refusal);
    const errors: string[] = [];
    const original = console.error;
    console.error = (message: string) => errors.push(message);
    try {
      expect(wake(makeRow(), run)).toBe("failed");
    } finally {
      console.error = original;
    }
    expect(errors).toEqual(["herdr-cleanup: herdr refused the prompt for topic: agent w1:p2 is blocked"]);
  });

  test.each<{ name: string; row: Partial<Row>; written: string; outcome: Outcome }>([
    { name: "a row with no agent pane", row: { agentPane: undefined }, written: WAKE_TEXT, outcome: "failed" },
    { name: "an emptied message", row: {}, written: "  \n", outcome: "cancelled" },
  ])("sends nothing for $name", ({ row, written, outcome }) => {
    const { run, calls } = recorder([], written);
    expect(wake(makeRow(row), run)).toBe(outcome);
    expect(calls.some((c) => c.startsWith("herdr agent prompt"))).toBe(false);
  });
});

test("go falls back to the workspace when the agent pane is gone", () => {
  const { run, calls } = recorder(["herdr agent focus"]);
  expect(go(makeRow(), run)).toBe("done");
  expect(calls).toEqual(["herdr agent focus w1:p2", "herdr workspace focus w1"]);
});
