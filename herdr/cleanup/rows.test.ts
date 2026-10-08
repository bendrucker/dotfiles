import { describe, expect, test } from "bun:test";
import { buildRows, repoRoots, summarize, type Row, type Sources } from "./rows";

interface WorkspaceFixture {
  workspace_id: string;
  label: string;
  worktree?: { checkout_path: string; is_linked_worktree: boolean; repo_root: string; repo_name: string };
}

function makeWorkspace(overrides: Partial<WorkspaceFixture> = {}): WorkspaceFixture {
  const id = overrides.workspace_id ?? "w1";
  return {
    workspace_id: id,
    label: id,
    worktree: { checkout_path: `/wt/${id}`, is_linked_worktree: true, repo_root: "/repo", repo_name: "dotfiles" },
    ...overrides,
  };
}

function makeAgent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { pane_id: "p1", workspace_id: "w1", agent_status: "idle", ...overrides };
}

// One entry of `wt list --format=json` at schema 2, holding only what the board reads.
function makeItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    branch: "topic",
    head: { sha: "abc123" },
    worktree: { path: "/wt/w1", changes: { staged: false, modified: false, untracked: false } },
    default_branch: { ahead: 1, behind: 0, merge_conflicts: false },
    upstream: null,
    pr: { number: 12, mergeable: null },
    checks: { status: "running", source: "pr", stale: false },
    display: { state: "ahead" },
    ...overrides,
  };
}

function makeList(items: Record<string, unknown>[], provider = "github"): unknown {
  return { schema: 2, repo: { default_branch: "main", forge: { provider } }, items };
}

function makeSnapshot(workspaces: WorkspaceFixture[], agents: Record<string, unknown>[] = []): unknown {
  return { result: { snapshot: { workspaces, agents } } };
}

function makeSources(overrides: Partial<Sources> = {}): Sources {
  return {
    snapshot: makeSnapshot([makeWorkspace()]),
    wt: { "/repo": makeList([makeItem()]) },
    ignored: () => [],
    ...overrides,
  };
}

function makeRow(overrides: Partial<Row> = {}): Row {
  return {
    workspaceId: "w",
    label: "w",
    path: "/wt/w",
    repoRoot: "/repo",
    repoName: "dotfiles",
    branch: "",
    forge: "github",
    step: "collapsed",
    reason: "no PR",
    flags: [],
    ignored: [],
    ...overrides,
  };
}

function only(sources: Partial<Sources>): Row | undefined {
  return buildRows(makeSources(sources))[0];
}

describe("buildRows", () => {
  test.each([
    { name: "workspace without a worktree", workspaces: [makeWorkspace({ worktree: undefined })], kept: [] },
    {
      name: "main checkout",
      workspaces: [makeWorkspace({ worktree: { checkout_path: "/repo", is_linked_worktree: false, repo_root: "/repo", repo_name: "dotfiles" } })],
      kept: [],
    },
    { name: "linked worktree", workspaces: [makeWorkspace()], kept: ["w1"] },
  ])("skip rules: $name", ({ workspaces, kept }) => {
    const rows = buildRows(makeSources({ snapshot: makeSnapshot(workspaces) }));
    expect(rows.map((row) => row.workspaceId)).toEqual(kept);
  });

  test.each([
    { provider: "github", forge: "github", ref: "dotfiles#12" },
    { provider: "gitlab", forge: "gitlab", ref: "dotfiles!12" },
    { provider: "gitea", forge: undefined, ref: "dotfiles#12" },
  ])("forge ref: $provider", ({ provider, forge, ref }) => {
    const row = only({ wt: { "/repo": makeList([makeItem()], provider) } });
    expect(row).toMatchObject({ forge, pr: { number: 12, ref }, branch: "topic", head: "abc123" });
  });

  test.each<{ name: string; item: Record<string, unknown>; step: string; reason: string }>([
    { name: "running checks", item: {}, step: "collapsed", reason: "checks running" },
    { name: "failed checks", item: { checks: { status: "failed" } }, step: "go", reason: "CI failing" },
    { name: "unknown checks", item: { checks: { status: "weird" } }, step: "collapsed", reason: "open PR" },
    { name: "conflicts the forge found", item: { pr: { number: 12, mergeable: false }, checks: null }, step: "go", reason: "conflicting" },
    {
      name: "conflicts wt found",
      item: { default_branch: { merge_conflicts: true }, checks: { status: "passed" } },
      step: "go",
      reason: "conflicting",
    },
    { name: "changes requested", item: { pr: { number: 12, review: "changes_requested" } }, step: "go", reason: "changes requested" },
    { name: "a draft", item: { pr: { number: 12, review: "draft" }, checks: { status: "passed" } }, step: "collapsed", reason: "draft" },
    { name: "green", item: { checks: { status: "passed" } }, step: "go", reason: "ready to merge" },
    { name: "integrated with no PR", item: { pr: null, display: { state: "integrated" } }, step: "prune", reason: "merged" },
    { name: "empty", item: { pr: null, display: { state: "empty" } }, step: "collapsed", reason: "no commits" },
    { name: "a PR without a number", item: { pr: { number: "12" } }, step: "collapsed", reason: "no PR" },
  ])("reads wt: $name", ({ item, step, reason }) => {
    expect(only({ wt: { "/repo": makeList([makeItem(item)]) } })).toMatchObject({ step, reason });
  });

  test.each([
    { name: "wt failed for the repo", wt: {}, reason: "wt failed" },
    { name: "wt does not list the checkout", wt: { "/repo": makeList([]) }, reason: "not in wt list" },
    { name: "wt printed something else", wt: { "/repo": { items: "nope" } }, reason: "wt failed" },
  ])("asks to be looked at when $name", ({ wt, reason }) => {
    expect(only({ wt })).toMatchObject({ step: "go", reason, branch: "" });
  });

  test("a prune row carries flags from wt and the ignored files", () => {
    const item = makeItem({
      pr: null,
      display: { state: "integrated" },
      worktree: { path: "/wt/w1", changes: { untracked: true } },
      upstream: { ahead: 2 },
    });
    const row = only({ wt: { "/repo": makeList([item]) }, ignored: () => [".env", "node_modules/"] });
    expect(row).toMatchObject({
      step: "prune",
      reason: "merged",
      flags: ["dirty", "unpushed:2", "ignored:2"],
      ignored: [".env", "node_modules/"],
    });
  });

  test("reads ignored files only for a row that may be pruned", () => {
    const read: string[] = [];
    only({ ignored: (path) => (read.push(path), []) });
    expect(read).toEqual([]);
  });

  test("a review token puts the pane at the top with its kind and summary", () => {
    const tokens = { review: "x", review_kind: "plan", review_summary: "approve the Worktrunk plan" };
    const row = only({ snapshot: makeSnapshot([makeWorkspace()], [makeAgent({ pane_id: "a" }), makeAgent({ pane_id: "b", tokens })]) });
    expect(row).toMatchObject({ step: "review", reason: "plan", detail: "approve the Worktrunk plan", agentPane: "b" });
  });

  test.each([
    { name: "null", snapshot: null },
    { name: "string", snapshot: "x" },
    { name: "no result", snapshot: {} },
    { name: "workspaces not an array", snapshot: { result: { snapshot: { workspaces: {} } } } },
  ])("invalid snapshot yields no rows: $name", ({ snapshot }) => {
    expect(buildRows(makeSources({ snapshot }))).toEqual([]);
  });

  test("malformed agents and workspaces are dropped", () => {
    const snapshot = makeSnapshot(
      [makeWorkspace(), { label: "no id" } as WorkspaceFixture],
      [makeAgent({ pane_id: 7 }), makeAgent({ pane_id: "p2", tokens: "bad" })],
    );
    const rows = buildRows(makeSources({ snapshot }));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.agentPane).toBe("p2");
  });

  test.each([
    {
      name: "blocked before done before any",
      agents: [
        makeAgent({ pane_id: "a" }),
        makeAgent({ pane_id: "b", tokens: { agent_done: "✓" } }),
        makeAgent({ pane_id: "c", tokens: { agent_blocked: "?" } }),
      ],
      pane: "c",
    },
    { name: "done before any", agents: [makeAgent({ pane_id: "a" }), makeAgent({ pane_id: "b", tokens: { agent_done: "✓" } })], pane: "b" },
    { name: "first agent otherwise", agents: [makeAgent({ pane_id: "a" }), makeAgent({ pane_id: "b" })], pane: "a" },
  ])("agent pane: $name", ({ agents, pane }) => {
    expect(only({ snapshot: makeSnapshot([makeWorkspace()], agents) })?.agentPane).toBe(pane);
  });

  test("a working agent marks the row live", () => {
    expect(only({ snapshot: makeSnapshot([makeWorkspace()], [makeAgent({ agent_status: "working" })]) })?.live).toBe(true);
  });

  test("sorts review, go, wake, prune, collapsed, then by label", () => {
    const ids = ["c1", "c2", "p1", "g1", "g2", "k1", "r1"];
    const labels: Record<string, string> = { c1: "zeta", c2: "alpha", p1: "beta", g1: "omega", g2: "gamma", k1: "kappa", r1: "rho" };
    const snapshot = makeSnapshot(
      ids.map((id) => makeWorkspace({ workspace_id: id, label: labels[id] ?? id })),
      [
        makeAgent({ pane_id: "pg1", workspace_id: "g1", agent_status: "blocked" }),
        makeAgent({ pane_id: "pg2", workspace_id: "g2", agent_status: "blocked" }),
        makeAgent({ pane_id: "pk1", workspace_id: "k1" }),
        makeAgent({ pane_id: "pr1", workspace_id: "r1", tokens: { review: "x", review_kind: "code" } }),
      ],
    );
    const item = (id: string, overrides: Record<string, unknown> = {}) =>
      makeItem({ worktree: { path: `/wt/${id}`, changes: {} }, pr: null, ...overrides });
    const wt = {
      "/repo": makeList([
        ...["c1", "c2", "g1", "g2", "r1"].map((id) => item(id)),
        item("p1", { display: { state: "integrated" } }),
        item("k1", { pr: { number: 3 }, checks: { status: "failed" } }),
      ]),
    };
    expect(buildRows(makeSources({ snapshot, wt })).map((row) => `${row.step}:${row.label}`)).toEqual([
      "review:rho",
      "go:gamma",
      "go:omega",
      "wake:kappa",
      "prune:beta",
      "collapsed:alpha",
      "collapsed:zeta",
    ]);
  });
});

test("asks wt about each repo once", () => {
  const snapshot = makeSnapshot([
    makeWorkspace({ workspace_id: "a" }),
    makeWorkspace({ workspace_id: "b" }),
    makeWorkspace({ workspace_id: "c", worktree: { checkout_path: "/wt/c", is_linked_worktree: true, repo_root: "/other", repo_name: "o" } }),
  ]);
  expect(repoRoots(snapshot)).toEqual(["/repo", "/other"]);
});

test("summarize counts what needs you, what can finish, and the rest", () => {
  const steps: Row["step"][] = ["review", "go", "wake", "prune", "prune", "collapsed"];
  const rows = steps.map((step) => makeRow({ step }));
  expect(summarize(rows)).toEqual({ needYou: 3, finish: 2, collapsed: 1 });
});
