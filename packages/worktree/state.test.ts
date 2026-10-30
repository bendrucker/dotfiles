import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sandbox, type Sandbox } from "#harness";
import { capture, defaultBranch, listWorktrees, prState, readWorktrees, remoteHost, UNKNOWN } from "./state.ts";

let box: Sandbox;
let originalPath: string | undefined;

beforeEach(() => {
  box = sandbox("state");
  originalPath = process.env.PATH;
  process.env.PATH = `${box.bin}:${originalPath}`;
});

afterEach(() => {
  process.env.PATH = originalPath;
  box.remove();
});

describe("capture", () => {
  test("trims trailing newlines", async () => {
    box.stub("tool", 'printf "value\\n\\n"');
    expect(await capture(["tool"])).toBe("value");
  });

  test("closes stdin", async () => {
    box.stub("tool", "cat; printf done");
    expect(await capture(["tool"])).toBe("done");
  });

  test("keeps what a failing command printed", async () => {
    box.stub("tool", 'printf "partial\\n"; exit 1');
    expect(await capture(["tool"])).toBe("partial");
  });

  test("is empty for a command that is not installed", async () => {
    expect(await capture(["not-installed-here"])).toBe("");
  });
});

describe("readWorktrees", () => {
  const clean = { staged: false, modified: false, untracked: false, renamed: false, deleted: false };
  const envelope = (items: unknown[]) => JSON.stringify({ schema: 2, items });

  test("reads a schema 2 worktree row", () => {
    const [row] = readWorktrees(
      envelope([
        {
          branch: "feature",
          head: { committed_at: "1970-01-01T00:16:40Z" },
          worktree: { path: "/repo.feature", main: false, current: true, changes: clean },
          upstream: { remote: "origin", branch: "feature", ahead: 0, behind: 2 },
          display: { state: "diverged" },
        },
      ]),
    );
    expect(row).toEqual({
      kind: "worktree",
      branch: "feature",
      path: "/repo.feature",
      isMain: false,
      isCurrent: true,
      timestamp: 1000,
      clean: true,
      onRemote: true,
      mainState: "diverged",
    });
  });

  test("reads a detached worktree with undetermined changes as not clean", () => {
    const [row] = readWorktrees(
      envelope([{ branch: null, head: null, worktree: { path: "/wt", main: false, current: false, changes: null } }]),
    );
    expect(row).toMatchObject({ branch: "", timestamp: 0, clean: false, onRemote: false, mainState: "" });
  });

  test.each<{ name: string; conflicted: boolean | null | undefined; expected: boolean }>([
    { name: "no conflicts", conflicted: false, expected: true },
    { name: "conflicts", conflicted: true, expected: false },
    { name: "an undetermined conflict check", conflicted: null, expected: false },
    { name: "no conflict field", conflicted: undefined, expected: true },
  ])("reads a worktree with $name as clean: $expected", ({ conflicted, expected }) => {
    const changes = { ...clean, ...(conflicted === undefined ? {} : { conflicted }) };
    const [row] = readWorktrees(envelope([{ branch: "topic", worktree: { path: "/wt", main: false, current: false, changes } }]));
    expect(row?.clean).toBe(expected);
  });

  test("throws on output that is not JSON", () => {
    expect(() => readWorktrees("warning: something\n{}")).toThrow("unexpected `wt list --format=json` output");
  });

  test("reads a row without a worktree as a branch", () => {
    expect(readWorktrees(envelope([{ branch: "topic" }]))[0]?.kind).toBe("branch");
  });

  test("throws on the schema 1 bare array", () => {
    expect(() => readWorktrees(JSON.stringify([{ kind: "worktree", branch: "main" }]))).toThrow(
      "unexpected `wt list --format=json` output",
    );
  });
});

describe("readers over capture", () => {
  test("defaultBranch is empty when wt cannot be run", async () => {
    process.env.PATH = box.bin;
    expect(await defaultBranch()).toBe("");
  });

  test("remoteHost reads the host out of the configured url", async () => {
    box.stub("git", 'printf "git@github.com:o/r.git\\n"');
    expect(await remoteHost()).toBe("github.com");
  });

  test("listWorktrees is undefined when wt says nothing", async () => {
    box.stub("wt", "exit 0");
    expect(await listWorktrees()).toBeUndefined();
  });

  test.each<{ name: string; host: string; tool: string; stdout: string; expected: unknown }>([
    {
      name: "gh answers for a github host",
      host: "github.com",
      tool: "gh",
      stdout: "MERGED\\t12\\n",
      expected: { state: "MERGED", number: "12" },
    },
    {
      name: "glab answers for a gitlab host, and OPENED reads as OPEN",
      host: "gitlab.example.com",
      tool: "glab",
      stdout: '[{"state":"opened","iid":7}]',
      expected: { state: "OPEN", number: "7" },
    },
  ])("prState: $name", async ({ host, tool, stdout, expected }) => {
    box.stub(tool, `printf '${stdout}'`);
    expect(await prState("feature", host)).toEqual(expected);
  });

  // A lookup that failed must not read as a branch with no PR, which the
  // pruner would take as license to archive and remove a dirty tree.
  test.each<{ name: string; host: string; tool: string; body: string; expected: unknown }>([
    {
      name: "gh confirms no PR",
      host: "github.com",
      tool: "gh",
      body: `echo 'no pull requests found for branch "feature"' >&2; exit 1`,
      expected: undefined,
    },
    {
      name: "gh fails on auth",
      host: "github.com",
      tool: "gh",
      body: "echo 'HTTP 401: Bad credentials' >&2; exit 1",
      expected: { state: UNKNOWN, number: "" },
    },
    { name: "glab confirms no MR", host: "gitlab.example.com", tool: "glab", body: "echo '[]'", expected: undefined },
    {
      name: "glab fails",
      host: "gitlab.example.com",
      tool: "glab",
      body: "exit 1",
      expected: { state: UNKNOWN, number: "" },
    },
  ])("prState: $name", async ({ host, tool, body, expected }) => {
    box.stub(tool, body);
    expect(await prState("feature", host)).toEqual(expected);
  });

  test("prState is unknown when the forge CLI is absent", async () => {
    process.env.PATH = box.bin;
    expect(await prState("feature", "github.com")).toEqual({ state: UNKNOWN, number: "" });
  });
});
