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

const OPEN_PR = { number: 7, state: "OPEN", ref: "repo#7" } as const;

function errorsFrom(act: () => void): string[] {
  const errors: string[] = [];
  const original = console.error;
  console.error = (message: string) => errors.push(message);
  try {
    act();
  } finally {
    console.error = original;
  }
  return errors;
}

interface Checkout {
  status?: string;
  ahead?: string;
  branch?: string;
}

function recorder(
  failing: string[] = [],
  written = WAKE_TEXT,
  refusal = "",
  checkout: Checkout = {},
): { run: Runner; calls: string[] } {
  const calls: string[] = [];
  const run: Runner = (cmd) => {
    const line = cmd.join(" ");
    calls.push(line);
    const ok = !failing.some((prefix) => line.startsWith(prefix));
    if (line.startsWith("gum write")) return { ok, stdout: written, stderr: "" };
    if (line.includes(" status --porcelain")) return { ok, stdout: ok ? (checkout.status ?? "") : "", stderr: "" };
    if (line.includes(" rev-list ")) return { ok, stdout: ok ? (checkout.ahead ?? "0\n") : "", stderr: "" };
    if (line.includes(" branch --show-current")) return { ok, stdout: ok ? (checkout.branch ?? "topic\n") : "", stderr: "" };
    return { ok, stdout: "", stderr: ok ? "" : refusal };
  };
  return { run, calls };
}

const CHECK = [
  "git -C /src/.worktrees/repo/topic status --porcelain --ignored",
  "git -C /src/.worktrees/repo/topic rev-list --count HEAD --not --remotes",
  "git -C /src/.worktrees/repo/topic branch --show-current",
];

describe("prune", () => {
  test("reads the checkout, trashes it, hands the stale entry to wt, then closes the workspace", () => {
    const { run, calls } = recorder();
    expect(prune(makeRow({ flags: ["dirty"] }), run)).toBe("done");
    expect(calls).toEqual([
      ...CHECK,
      "trash /src/.worktrees/repo/topic",
      "wt -C /src/repo remove topic --foreground --yes",
      "herdr workspace close w1",
    ]);
  });

  test.each<{ name: string; row: Partial<Row>; checkout: Checkout; error: string; ran: number }>([
    {
      name: "a row that is not finished",
      row: { step: "go", reason: "checks failing" },
      checkout: {},
      error: "topic is not merged or closed (checks failing), so p leaves it alone",
      ran: 0,
    },
    {
      name: "a detached checkout",
      row: {},
      checkout: { branch: "" },
      error: "topic has no branch checked out. Nothing was removed",
      ran: CHECK.length,
    },
    {
      name: "a checkout that moved to another branch",
      row: {},
      checkout: { branch: "other\n" },
      error: "topic is on other now, not topic, so press r first. Nothing was removed",
      ran: CHECK.length,
    },
  ])("removes nothing for $name", ({ row, checkout, error, ran }) => {
    const { run, calls } = recorder([], WAKE_TEXT, "", checkout);
    expect(errorsFrom(() => expect(prune(makeRow(row), run)).toBe("failed"))).toEqual([`herdr-cleanup: ${error}`]);
    expect(calls).toHaveLength(ran);
  });

  test.each<{ name: string; flags: string[]; live?: boolean; failing: string[]; checkout: Checkout; asked: string }>([
    {
      name: "work done since the cache was written",
      flags: [],
      failing: [],
      checkout: { status: " M file\n!! debug.log\n", ahead: "2\n" },
      asked: "Prune topic? dirty, unpushed:2, ignored:1",
    },
    { name: "a checkout git cannot read", flags: [], failing: ["git -C /src/.worktrees/repo/topic status"], checkout: {}, asked: "Prune topic? unreadable" },
    { name: "a live agent", flags: [], live: true, failing: [], checkout: {}, asked: "Prune topic? live" },
  ])("asks before removing $name", ({ flags, live, failing, checkout, asked }) => {
    const { run, calls } = recorder([...failing, "gum confirm"], WAKE_TEXT, "", checkout);
    expect(prune(makeRow({ flags, live }), run)).toBe("cancelled");
    expect(calls.find((c) => c.startsWith("gum confirm"))).toStartWith(`gum confirm --default=false ${asked}`);
    expect(calls.some((c) => c.startsWith("trash"))).toBe(false);
  });

  test("counts unpushed commits from the forge's copy of the branch when it has one", () => {
    const { run, calls } = recorder();
    prune(makeRow({ pr: { number: 7, state: "MERGED", ref: "repo#7", head: "abc123" } }), run);
    expect(calls[1]).toBe("git -C /src/.worktrees/repo/topic rev-list --count abc123..HEAD");
  });

  test.each<{ name: string; failing: string; ran: string }>([
    { name: "the Trash refuses", failing: "trash", ran: "trash /src/.worktrees/repo/topic" },
    { name: "wt refuses", failing: "wt ", ran: "wt -C /src/repo remove topic --foreground --yes" },
  ])("stops when $name", ({ failing, ran }) => {
    const { run, calls } = recorder([failing]);
    expect(errorsFrom(() => expect(prune(makeRow(), run)).toBe("failed"))).toHaveLength(1);
    expect(calls.at(-1)).toBe(ran);
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
    expect(close(makeRow({ forge, pr: OPEN_PR, flags: ["dirty"] }), run)).toBe("done");
    expect(calls.filter((c) => c.startsWith("gum confirm"))).toHaveLength(1);
    expect(calls).toContain(command);
    expect(calls.at(-1)).toBe("herdr workspace close w1");
  });

  test("leaves the worktree when the forge refuses", () => {
    const { run, calls } = recorder(["gh pr close"]);
    expect(close(makeRow({ pr: OPEN_PR }), run)).toBe("failed");
    expect(calls.some((c) => c.startsWith("trash"))).toBe(false);
  });

  test.each<{ name: string; row: Partial<Row>; error: string }>([
    { name: "an already merged PR", row: {}, error: "repo#7 is already merged, so press p to prune" },
    {
      name: "an origin on neither forge",
      row: { pr: OPEN_PR, forge: undefined },
      error: "topic's origin is neither GitHub nor GitLab, so repo#7 can't be closed from here",
    },
    {
      name: "a branch with more than one open PR",
      row: { pr: OPEN_PR, openPrs: 2 },
      error: "topic has 2 open pull requests, so close them on the forge",
    },
  ])("runs nothing for $name", ({ row, error }) => {
    const { run, calls } = recorder();
    expect(errorsFrom(() => expect(close(makeRow(row), run)).toBe("failed"))).toEqual([`herdr-cleanup: ${error}`]);
    expect(calls).toEqual([]);
  });
});

describe("wake", () => {
  test("sends the edited text to the agent pane", () => {
    const { run, calls } = recorder([], "[herdr-cleanup] rebase first\n");
    expect(wake(makeRow(), run)).toBe("done");
    expect(calls.at(-1)).toBe("herdr agent prompt w1:p2 [herdr-cleanup] rebase first");
  });

  test("draws the editor on stderr and reads the text from stdout", () => {
    const seen: (string | undefined)[] = [];
    const run: Runner = (cmd, options) => {
      if (cmd[1] === "write") seen.push(options?.terminal);
      return { ok: true, stdout: "hi", stderr: "" };
    };
    wake(makeRow(), run);
    expect(seen).toEqual(["stderr"]);
  });

  test.each<{ name: string; code: string; reason: string }>([
    { name: "a known code", code: "agent_not_ready", reason: "the agent isn't at its prompt, nothing was sent" },
    { name: "an unknown code", code: "other", reason: "agent w1:p2 is busy" },
  ])("reports why herdr refused the prompt: $name", ({ code, reason }) => {
    const refusal = JSON.stringify({ error: { code, message: "agent w1:p2 is busy" } });
    const { run } = recorder(["herdr agent prompt"], WAKE_TEXT, refusal);
    expect(errorsFrom(() => expect(wake(makeRow(), run)).toBe("failed"))).toEqual([
      `herdr-cleanup: herdr refused the prompt for topic: ${reason}`,
    ]);
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
