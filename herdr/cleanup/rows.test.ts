import { describe, expect, test } from "bun:test";
import { buildRows, forgeOf, summarize, type GitFacts, type Row, type Sources } from "./rows";

const NOW = Date.parse("2026-10-07T12:00:00Z");

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
    worktree: {
      checkout_path: `/wt/${id}`,
      is_linked_worktree: true,
      repo_root: "/repo",
      repo_name: "dotfiles",
    },
    ...overrides,
  };
}

function makeAgent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { pane_id: "p1", workspace_id: "w1", agent_status: "idle", ...overrides };
}

function makePr(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 12,
    state: "OPEN",
    draft: false,
    conflicting: false,
    checks: "pending",
    updated: "2026-10-07T10:00:00Z",
    head: "abc",
    stacked: false,
    ...overrides,
  };
}

function makeCache(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workspace_id: "w1",
    path: "/wt/w1",
    branch: "topic",
    default: "main",
    prs: [makePr()],
    unpushed: 0,
    dirty: false,
    fetched_at: "2026-10-07T11:00:00Z",
    ...overrides,
  };
}

function makeSnapshot(workspaces: WorkspaceFixture[], agents: Record<string, unknown>[] = []): unknown {
  return { result: { snapshot: { workspaces, agents } } };
}

function makeSources(overrides: Partial<Sources> = {}): Sources {
  return {
    snapshot: makeSnapshot([makeWorkspace()]),
    caches: {},
    agentState: undefined,
    git: () => ({ originUrl: "git@github.com:me/dotfiles.git", ignored: [] }),
    now: NOW,
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

describe("buildRows", () => {
  test.each([
    {
      name: "workspace without a worktree",
      workspaces: [makeWorkspace({ worktree: undefined })],
      kept: [],
    },
    {
      name: "main checkout",
      workspaces: [
        makeWorkspace({
          worktree: { checkout_path: "/repo", is_linked_worktree: false, repo_root: "/repo", repo_name: "dotfiles" },
        }),
      ],
      kept: [],
    },
    { name: "linked worktree", workspaces: [makeWorkspace()], kept: ["w1"] },
  ])("skip rules: $name", ({ workspaces, kept }) => {
    const rows = buildRows(makeSources({ snapshot: makeSnapshot(workspaces) }));
    expect(rows.map((row) => row.workspaceId)).toEqual(kept);
  });

  test.each([
    { name: "github", originUrl: "git@github.com:me/dotfiles.git", forge: "github", ref: "dotfiles#12" },
    { name: "github https", originUrl: "https://github.com/me/dotfiles", forge: "github", ref: "dotfiles#12" },
    { name: "gitlab", originUrl: "git@gitlab.com:me/dotfiles.git", forge: "gitlab", ref: "dotfiles!12" },
    { name: "self-hosted", originUrl: "ssh://git@git.corp.example/me/dotfiles", forge: "gitlab", ref: "dotfiles!12" },
    { name: "no origin", originUrl: undefined, forge: undefined, ref: "dotfiles#12" },
  ])("forge ref: $name", ({ originUrl, forge, ref }) => {
    const git = (): GitFacts => ({ originUrl, ignored: [] });
    const [row] = buildRows(makeSources({ caches: { w1: makeCache() }, git }));
    expect(row?.forge).toBe(forge);
    expect(row?.pr).toEqual({ number: 12, state: "OPEN", ref });
  });

  test("prefers the open PR over a newer closed one", () => {
    const prs = [makePr({ number: 3, state: "CLOSED", updated: "2026-10-07T11:30:00Z" }), makePr({ number: 4 })];
    const [row] = buildRows(makeSources({ caches: { w1: makeCache({ prs }) } }));
    expect(row?.pr?.number).toBe(4);
  });

  test("a missing cache decides from agents alone", () => {
    const snapshot = makeSnapshot([makeWorkspace()], [makeAgent({ agent_status: "blocked" })]);
    const [row] = buildRows(makeSources({ snapshot }));
    expect(row).toMatchObject({ step: "go", reason: "blocked", agentPane: "p1", branch: "" });
    expect(row?.pr).toBeUndefined();
    expect(row?.fetchedAt).toBeUndefined();
  });

  test("a missing cache and no agents reads no PR", () => {
    const [row] = buildRows(makeSources());
    expect(row).toMatchObject({ step: "collapsed", reason: "no PR" });
  });

  test.each([
    { name: "not an object", cache: "nope" },
    { name: "prs not an array", cache: { prs: {} } },
    { name: "unknown PR state", cache: makeCache({ prs: [makePr({ state: "WEIRD" })] }) },
    { name: "unknown checks", cache: makeCache({ prs: [makePr({ checks: "meh" })] }) },
    { name: "PR without a number", cache: makeCache({ prs: [makePr({ number: "12" })] }) },
  ])("invalid cache is ignored: $name", ({ cache }) => {
    const [row] = buildRows(makeSources({ caches: { w1: cache } }));
    expect(row).toMatchObject({ step: "collapsed", reason: "no PR" });
    expect(row?.pr).toBeUndefined();
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
    {
      name: "done before any",
      agents: [makeAgent({ pane_id: "a" }), makeAgent({ pane_id: "b", tokens: { agent_done: "✓" } })],
      pane: "b",
    },
    { name: "first agent otherwise", agents: [makeAgent({ pane_id: "a" }), makeAgent({ pane_id: "b" })], pane: "a" },
  ])("agent pane: $name", ({ agents, pane }) => {
    const [row] = buildRows(makeSources({ snapshot: makeSnapshot([makeWorkspace()], agents) }));
    expect(row?.agentPane).toBe(pane);
  });

  test("wake targets the idle pane from the agent state file", () => {
    const snapshot = makeSnapshot(
      [makeWorkspace()],
      [makeAgent({ pane_id: "a", agent_status: "working" }), makeAgent({ pane_id: "b" })],
    );
    const agentState = {
      a: { lastWorkingAt: NOW },
      b: { wasWorking: false, lastWorkingAt: Date.parse("2026-10-07T09:00:00Z") },
      c: "garbage",
    };
    const [row] = buildRows(makeSources({ snapshot, agentState, caches: { w1: makeCache() } }));
    expect(row).toMatchObject({ step: "wake", reason: "PR updated since agent idled", agentPane: "b" });
  });

  test("prune row carries flags from cache and git", () => {
    const cache = makeCache({ prs: [makePr({ state: "MERGED" })], dirty: true, unpushed: 2 });
    const git = (): GitFacts => ({ originUrl: "git@github.com:me/d.git", ignored: [".env", "node_modules/"] });
    const [row] = buildRows(makeSources({ caches: { w1: cache }, git }));
    expect(row).toMatchObject({
      step: "prune",
      reason: "merged",
      flags: ["dirty", "unpushed:2", "ignored:2"],
      ignored: [".env", "node_modules/"],
      fetchedAt: "2026-10-07T11:00:00Z",
      branch: "topic",
    });
  });

  test("sorts go, wake, prune, collapsed then by label", () => {
    const snapshot = makeSnapshot(
      [
        makeWorkspace({ workspace_id: "c1", label: "zeta" }),
        makeWorkspace({ workspace_id: "c2", label: "alpha" }),
        makeWorkspace({ workspace_id: "p1", label: "beta" }),
        makeWorkspace({ workspace_id: "g1", label: "omega" }),
        makeWorkspace({ workspace_id: "g2", label: "gamma" }),
        makeWorkspace({ workspace_id: "k1", label: "kappa" }),
      ],
      [
        makeAgent({ pane_id: "pg1", workspace_id: "g1", agent_status: "blocked" }),
        makeAgent({ pane_id: "pg2", workspace_id: "g2", agent_status: "blocked" }),
        makeAgent({ pane_id: "pk1", workspace_id: "k1" }),
      ],
    );
    const caches = {
      p1: makeCache({ prs: [makePr({ state: "MERGED" })] }),
      k1: makeCache({ prs: [makePr()] }),
    };
    const agentState = { pk1: { lastWorkingAt: Date.parse("2026-10-07T09:00:00Z") } };
    const rows = buildRows(makeSources({ snapshot, caches, agentState }));
    expect(rows.map((row) => `${row.step}:${row.label}`)).toEqual([
      "go:gamma",
      "go:omega",
      "wake:kappa",
      "prune:beta",
      "collapsed:alpha",
      "collapsed:zeta",
    ]);
  });
});

describe("forgeOf", () => {
  test.each([
    { name: "scp-style", url: "git@github.com:a/b.git", forge: "github" },
    { name: "https with user", url: "https://user@github.com/a/b", forge: "github" },
    { name: "upper case host", url: "https://GitHub.com/a/b", forge: "github" },
    { name: "other host", url: "https://gitlab.example.com/a/b", forge: "gitlab" },
    { name: "empty", url: "", forge: undefined },
    { name: "missing", url: undefined, forge: undefined },
  ])("$name", ({ url, forge }) => {
    expect(forgeOf(url)).toBe(forge);
  });
});

describe("summarize", () => {
  test.each([
    { name: "no rows", rows: [], expected: { needYou: 0, finish: 0, collapsed: 0, oldestFetch: undefined } },
    {
      name: "counts by step and finds the oldest fetch",
      rows: [
        makeRow({ step: "go", fetchedAt: "2026-10-07T11:00:00Z" }),
        makeRow({ step: "wake", fetchedAt: "2026-10-07T08:00:00Z" }),
        makeRow({ step: "prune" }),
        makeRow({ step: "prune", fetchedAt: "2026-10-07T09:00:00Z" }),
        makeRow({ step: "collapsed" }),
      ],
      expected: { needYou: 2, finish: 2, collapsed: 1, oldestFetch: "2026-10-07T08:00:00Z" },
    },
  ])("$name", ({ rows, expected }) => {
    expect(summarize(rows)).toEqual(expected);
  });
});
