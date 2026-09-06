import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentPrs,
  type Candidate,
  classifyAgent,
  columnize,
  type Forge,
  formatAge,
  parseAgentState,
  parseAgents,
  parseArguments,
  plural,
  type Pr,
  prDisplay,
  run,
  splitWorktreePath,
  summaryLine,
  summaryPrRefs,
} from "./claude-prune-agents";

const SCRIPT = join(import.meta.dir, "claude-prune-agents");

describe("classifyAgent", () => {
  // PR states -> action and reason. The empty set is the agent with no
  // discoverable PR, which is reported and never auto-removed.
  test.each<{ states: string[]; action: string; reason: string }>([
    { states: [], action: "skip", reason: "no PRs" },
    { states: ["OPEN"], action: "keep", reason: "open PR" },
    // One open PR outranks any number of terminal ones: work is still in flight.
    { states: ["MERGED", "OPEN"], action: "keep", reason: "open PR" },
    { states: ["MERGED"], action: "stale", reason: "merged" },
    { states: ["MERGED", "MERGED"], action: "stale", reason: "merged" },
    // Closed-unmerged does not block, so a terminal mix is still removable.
    { states: ["MERGED", "CLOSED"], action: "stale", reason: "merged, closed" },
    { states: ["CLOSED"], action: "stale", reason: "closed" },
    // A failed lookup blocks removal: the PR behind it may well be open, so it
    // must not be classified away by whatever else did resolve.
    { states: ["ERROR"], action: "keep", reason: "PR lookup failed" },
    { states: ["MERGED", "ERROR"], action: "keep", reason: "PR lookup failed" },
    { states: ["OPEN", "ERROR"], action: "keep", reason: "open PR" },
    // An unmodeled state can never delete an agent.
    { states: ["DRAFTED"], action: "keep", reason: "unknown PR state" },
    { states: ["MERGED", "DRAFTED"], action: "stale", reason: "merged" },
  ])("[$states] -> $action ($reason)", ({ states, action, reason }) => {
    expect(classifyAgent(states)).toEqual({ action, reason });
  });

  // The shell tested membership by substring containment on the joined argument
  // list, so a state carrying a space around a keyword matched it.
  test("matches a state as a whole value, not as a substring", () => {
    expect(classifyAgent(["NOT OPEN YET"])).toEqual({ action: "keep", reason: "unknown PR state" });
  });
});

describe("splitWorktreePath", () => {
  test.each<{ path: string; root: string; branch: string }>([
    { path: "/src/repo/.worktrees/feature-x", root: "/src/repo", branch: "feature-x" },
    { path: "/src/repo/.claude/worktrees/feature-x", root: "/src/repo", branch: "feature-x" },
    // Only the first component after the marker is the branch, so a branch name
    // carrying a slash resolves to its first segment.
    { path: "/src/repo/.worktrees/feat/sub", root: "/src/repo", branch: "feat" },
    // Greedy: with nested markers the last one wins.
    {
      path: "/a/.worktrees/x/.claude/worktrees/y",
      root: "/a/.worktrees/x",
      branch: "y",
    },
  ])("$path splits into $root and $branch", ({ path, root, branch }) => {
    expect(splitWorktreePath(path)).toEqual({ root, branch });
  });

  test.each(["/src/repo", "", "/src/repo/.worktrees", "/src/repo/worktrees/feature-x"])(
    "reports no worktree for %p",
    (path) => {
      expect(splitWorktreePath(path)).toBeUndefined();
    },
  );
});

describe("formatAge", () => {
  test.each<[number, string]>([
    [0, "0m"],
    [59, "0m"],
    [60, "1m"],
    [3599, "59m"],
    [3600, "1h"],
    [86399, "23h"],
    [86400, "1d"],
    [86400 * 30, "30d"],
    // A future timestamp truncates toward zero, same as zsh integer division.
    [-60, "-1m"],
  ])("%p seconds reads as %p", (secs, expected) => {
    expect(formatAge(secs)).toBe(expected);
  });
});

describe("summaryPrRefs", () => {
  test("takes the repo of a URL reference from the URL itself", () => {
    const summary = "see https://github.com/other/repo/pull/12 for the fix";
    expect(summaryPrRefs(summary, "own/repo")).toEqual([{ slug: "other/repo", number: "12" }]);
  });

  test("resolves a bare reference against the agent's own repo", () => {
    expect(summaryPrRefs("shipped as PR #77", "own/repo")).toEqual([
      { slug: "own/repo", number: "77" },
    ]);
  });

  // A bare number against the wrong repo would resolve to an unrelated PR.
  test("drops bare references when the agent has no repo", () => {
    expect(summaryPrRefs("shipped as PR #77", "")).toEqual([]);
  });

  test("keeps URL references when the agent has no repo", () => {
    expect(summaryPrRefs("github.com/other/repo/pull/12", "")).toEqual([
      { slug: "other/repo", number: "12" },
    ]);
  });

  // URL references come first, then bare ones, each in summary order, and the
  // order reaches the PRS column.
  test("orders URL references ahead of bare ones", () => {
    expect(summaryPrRefs("#1 github.com/a/b/pull/2 #3", "own/repo")).toEqual([
      { slug: "a/b", number: "2" },
      { slug: "own/repo", number: "1" },
      { slug: "own/repo", number: "3" },
    ]);
  });

  test("finds nothing in a summary with no references", () => {
    expect(summaryPrRefs("nothing to see", "own/repo")).toEqual([]);
  });
});

describe("prDisplay", () => {
  test.each<{ name: string; prs: Pr[]; expected: string }>([
    { name: "renders a single dash for no PRs", prs: [], expected: "-" },
    {
      name: "lowercases the state beside the number",
      prs: [{ number: "1", state: "MERGED" }],
      expected: "#1 merged",
    },
    {
      name: "names a failed lookup rather than a number",
      prs: [
        { number: "-", state: "ERROR" },
        { number: "77", state: "MERGED" },
      ],
      expected: "lookup failed, #77 merged",
    },
  ])("$name", ({ prs, expected }) => {
    expect(prDisplay(prs)).toBe(expected);
  });
});

describe("columnize", () => {
  test("pads every column but the last to its widest cell", () => {
    expect(columnize([["a", "bb", "c"], ["longer", "b", "cc"]])).toEqual([
      "a       bb  c",
      "longer  b   cc",
    ]);
  });

  // BSD column collapses adjacent delimiters, so an agent with no name shifted
  // every later column of its row one place left.
  test("keeps an empty cell as a blank column", () => {
    expect(columnize([["id", "", "age"], ["longer", "name", "age"]])).toEqual([
      "id            age",
      "longer  name  age",
    ]);
  });

  // One row is one line, which jq's @tsv held to and an agent's self-chosen name
  // does not. A name carrying a newline otherwise splits its row in two, and the
  // picker reads its selection back by whole label.
  test("keeps a cell holding a control character on one line", () => {
    expect(columnize([["id", "two\nlines\there", "age"]])).toEqual([
      "id  two\\nlines\\there  age",
    ]);
  });

  test("escapes a backslash so the escaping is reversible", () => {
    expect(columnize([["id", "back\\slash"]])).toEqual(["id  back\\\\slash"]);
  });
});

describe("plural", () => {
  test.each<[number, string]>([
    [0, "0 agents"],
    [1, "1 agent"],
    [2, "2 agents"],
  ])("%p renders as %p", (n, expected) => {
    expect(plural(n, "agent")).toBe(expected);
  });
});

describe("summaryLine", () => {
  test.each<{ name: string; line: string; expected: string }>([
    {
      name: "names only the count when nothing else happened",
      line: summaryLine(1, "removed", 0, 0, 0),
      expected: "1 agent removed",
    },
    {
      name: "appends the notes in a fixed order",
      line: summaryLine(2, "removable", 2, 1, 3),
      expected: "2 agents removable (2 kept, 1 skipped: no PRs, 3 failed)",
    },
    {
      name: "omits a note whose count is zero",
      line: summaryLine(0, "removed", 0, 1, 0),
      expected: "0 agents removed (1 skipped: no PRs)",
    },
  ])("$name", ({ line, expected }) => {
    expect(line).toBe(expected);
  });
});

describe("parseAgents", () => {
  const done = { id: "a1", cwd: "/repo", kind: "background", state: "done", startedAt: 1000 };

  test("keeps only completed background agents", () => {
    const agents = parseAgents(
      JSON.stringify([
        done,
        { ...done, id: "a2", state: "working" },
        { ...done, id: "a3", state: "failed" },
        { ...done, id: "a4", kind: "interactive" },
        { ...done, id: "a5", state: "brand-new" },
      ]),
    );
    expect(agents?.map((agent) => agent.id)).toEqual(["a1"]);
  });

  test("reads the fields the table and the scan need", () => {
    expect(parseAgents(JSON.stringify([{ ...done, name: "an agent" }]))).toEqual([
      { id: "a1", cwd: "/repo", started: 1000, name: "an agent" },
    ] satisfies Candidate[]);
  });

  // zsh arithmetic read a missing timestamp as 0, which yields an epoch-sized
  // age rather than an error, and a row is more useful than a dropped agent.
  test.each<{ name: string; startedAt: unknown; expected: number }>([
    { name: "a missing timestamp", startedAt: undefined, expected: 0 },
    { name: "a null timestamp", startedAt: null, expected: 0 },
    { name: "a non-numeric timestamp", startedAt: "soon", expected: 0 },
    { name: "a stringified timestamp", startedAt: "1700000000000", expected: 1700000000000 },
  ])("reads $name", ({ startedAt, expected }) => {
    expect(parseAgents(JSON.stringify([{ ...done, startedAt }]))?.[0].started).toBe(expected);
  });

  test("drops an agent with no id rather than scanning an unnamed one", () => {
    const nameless = JSON.stringify([{ ...done, id: "" }, { ...done, id: undefined }]);
    expect(parseAgents(nameless)).toEqual([]);
  });

  test("defaults a missing name and cwd to empty", () => {
    expect(parseAgents(JSON.stringify([{ id: "a1", kind: "background", state: "done" }]))).toEqual([
      { id: "a1", cwd: "", started: 0, name: "" },
    ]);
  });

  test.each(["not json", '{"agents":[]}', ""])("reports %p as unreadable", (text) => {
    expect(parseAgents(text)).toBeUndefined();
  });
});

describe("parseAgentState", () => {
  test("joins the detail and the result with a single space", () => {
    expect(parseAgentState('{"worktreePath":"/w","detail":"a","output":{"result":"b"}}')).toEqual({
      worktreePath: "/w",
      summary: "a b",
    });
  });

  test.each<{ name: string; text: string }>([
    { name: "unparseable state", text: "{" },
    { name: "state that is not an object", text: "[]" },
  ])("leaves both empty for an $name", ({ text }) => {
    expect(parseAgentState(text)).toEqual({ worktreePath: "", summary: "" });
  });

  // jq failed on the whole expression here, leaving the summary empty rather
  // than failing the run.
  test("leaves the summary empty when output is not an object", () => {
    expect(parseAgentState('{"worktreePath":"/w","detail":"a","output":"done"}')).toEqual({
      worktreePath: "/w",
      summary: "",
    });
  });

  test("defaults a missing field to empty", () => {
    expect(parseAgentState("{}")).toEqual({ worktreePath: "", summary: " " });
  });
});

describe("parseArguments", () => {
  test.each<{ args: string[]; dryRun: boolean; force: boolean }>([
    { args: [], dryRun: false, force: false },
    { args: ["-n"], dryRun: true, force: false },
    { args: ["--dry-run"], dryRun: true, force: false },
    { args: ["-f"], dryRun: false, force: true },
    { args: ["--force"], dryRun: false, force: true },
    { args: ["--force", "--force"], dryRun: false, force: true },
    { args: ["--force", "--dry-run"], dryRun: true, force: true },
  ])("reads $args", ({ args, dryRun, force }) => {
    expect(parseArguments(args)).toEqual({ kind: "run", flags: { dryRun, force } });
  });

  // Answered in argument order, so a run that also asked for help does nothing.
  test("answers help wherever it appears", () => {
    expect(parseArguments(["--force", "--help"])).toEqual({ kind: "help" });
    expect(parseArguments(["-h"])).toEqual({ kind: "help" });
  });

  // No clustering, no `--flag=value`, no `--` terminator, and no positionals.
  test.each(["--nope", "-fn", "--force=yes", "--", "extra"])("refuses %p", (arg) => {
    expect(parseArguments(["--dry-run", arg])).toEqual({ kind: "unknown", arg });
  });
});

describe("agentPrs", () => {
  function forgeStub(overrides: Partial<Forge> = {}): Forge {
    return {
      slug: () => "own/repo",
      branchPrs: () => ({ status: 0, stdout: "" }),
      refState: () => "",
      ...overrides,
    };
  }

  test("skips the branch query when there is no branch", () => {
    let queried = false;
    const forge = forgeStub({
      branchPrs: () => {
        queried = true;
        return { status: 0, stdout: "" };
      },
    });
    expect(agentPrs(forge, "own/repo", "", "")).toEqual([]);
    expect(queried).toBe(false);
  });

  test("skips the branch query when there is no repo", () => {
    let queried = false;
    const forge = forgeStub({
      branchPrs: () => {
        queried = true;
        return { status: 0, stdout: "" };
      },
    });
    expect(agentPrs(forge, "", "a-branch", "")).toEqual([]);
    expect(queried).toBe(false);
  });

  // A failed query and a branch with genuinely no PR are both empty output, and
  // only the status separates them. Reading the failure as "no PRs" would hide
  // an open PR and let the agent classify as stale.
  test("turns a failed branch query into a blocking ERROR", () => {
    const forge = forgeStub({ branchPrs: () => ({ status: 1, stdout: "" }) });
    expect(agentPrs(forge, "own/repo", "a-branch", "")).toEqual([{ number: "-", state: "ERROR" }]);
  });

  test("reads a branch with no PR as no PR", () => {
    expect(agentPrs(forgeStub(), "own/repo", "a-branch", "")).toEqual([]);
  });

  test("resolves each row of the branch query", () => {
    const forge = forgeStub({ branchPrs: () => ({ status: 0, stdout: "1\tMERGED\n2\tOPEN\n" }) });
    expect(agentPrs(forge, "own/repo", "a-branch", "")).toEqual([
      { number: "1", state: "MERGED" },
      { number: "2", state: "OPEN" },
    ]);
  });

  // The branch results seed the seen set, so a PR found both ways is resolved
  // and counted once.
  test("resolves a PR found both ways only once", () => {
    const views: string[] = [];
    const forge = forgeStub({
      branchPrs: () => ({ status: 0, stdout: "77\tMERGED\n" }),
      refState: (slug, number) => {
        views.push(`${slug}#${number}`);
        return "MERGED";
      },
    });
    expect(agentPrs(forge, "own/repo", "a-branch", "shipped #77 and #77")).toEqual([
      { number: "77", state: "MERGED" },
    ]);
    expect(views).toEqual([]);
  });

  // Refs that fail to resolve are issue numbers and another repo's numbering as
  // often as they are outages, so they are dropped rather than blocking.
  test("drops a reference that resolves to nothing", () => {
    const forge = forgeStub({ refState: () => "" });
    expect(agentPrs(forge, "own/repo", "", "closes #4")).toEqual([]);
  });

  test("orders branch results ahead of summary references", () => {
    const forge = forgeStub({
      branchPrs: () => ({ status: 1, stdout: "" }),
      refState: () => "MERGED",
    });
    expect(agentPrs(forge, "own/repo", "a-branch", "shipped as PR #77")).toEqual([
      { number: "-", state: "ERROR" },
      { number: "77", state: "MERGED" },
    ]);
  });
});

// Stubs answer the probe first, so a stub that failed to shadow the real binary
// is caught before an example lets the program spawn one. `claude rm` against a
// real agent would destroy a worktree.
const PROBE = `[ "$1" = "--prune-probe" ] && { printf 'stub\\n'; exit 0; }\n`;

const CLAUDE_STUB = `#!/bin/sh
${PROBE}case "$1" in
  agents) /bin/cat "$AGENTS_JSON" ;;
  rm)
    printf 'rm %s\\n' "$2" >> "$CLAUDE_RM_LOG"
    printf 'rm noise on stdout\\n'
    printf 'rm noise on stderr\\n' >&2
    /bin/cat >> "$CLAUDE_RM_STDIN"
    exit "\${CLAUDE_RM_EXIT:-0}"
    ;;
esac
exit 0
`;

// `repo view` names the repo, `pr list` resolves a branch, `pr view` resolves a
// bare ref. An unknown branch or number prints nothing, as real gh does for a
// branch or a ref with no PR. flaky-branch exits nonzero with empty output, as
// real gh does on an auth, rate-limit, or network error.
const GH_STUB = `#!/bin/sh
${PROBE}printf '%s\\n' "$*" >> "$GH_LOG"
case "$1 $2" in
  "repo view") [ -n "\${GH_NO_SLUG:-}" ] || printf 'test/repo\\n' ;;
  "pr view") [ "$3" = "77" ] && printf 'MERGED\\n' ;;
  "pr list")
    case "$*" in
      *merged-branch*) printf '1\\tMERGED\\n' ;;
      *open-branch*) printf '2\\tOPEN\\n' ;;
      *flaky-branch*) exit 1 ;;
    esac
    ;;
esac
exit 0
`;

// choose records the labels it was fed and echoes back the lines matching
// $GUM_PICK, so an unset pick is the esc that selects nothing.
const GUM_STUB = `#!/bin/sh
${PROBE}printf '%s\\n' "$*" >> "$GUM_LOG"
case "$1" in
  choose)
    input=$(/bin/cat)
    printf '%s\\n' "$input" > "$GUM_CHOOSE_INPUT"
    [ -n "\${GUM_PICK:-}" ] && printf '%s\\n' "$input" | /usr/bin/grep -E -- "$GUM_PICK"
    ;;
esac
exit 0
`;

const AGENTS = (repo: string, sandbox: string) => [
  { id: "merged01", cwd: repo, kind: "background", startedAt: 1, name: "merged agent", state: "done" },
  { id: "open0001", cwd: repo, kind: "background", startedAt: 1, name: "open agent", state: "done" },
  { id: "bare0001", cwd: repo, kind: "background", startedAt: 1, name: "bare ref agent", state: "done" },
  {
    id: "lost0001",
    cwd: join(sandbox, "gone"),
    kind: "background",
    startedAt: 1,
    name: "lost agent",
    state: "done",
  },
  { id: "flaky001", cwd: repo, kind: "background", startedAt: 1, name: "flaky agent", state: "done" },
  { id: "working1", cwd: repo, kind: "background", startedAt: 1, name: "busy agent", state: "working" },
  { pid: 123, cwd: repo, kind: "interactive", startedAt: 1, name: "live session", status: "idle" },
];

const environment = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
};

let sandbox: string;
let stubs: string;
let nogum: string;
let repo: string;

function writeStub(dir: string, name: string, script: string): void {
  const path = join(dir, name);
  writeFileSync(path, script);
  chmodSync(path, 0o755);
}

function writeState(id: string, worktreePath: string, detail: string): void {
  const dir = join(sandbox, ".claude", "jobs", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "state.json"),
    JSON.stringify({ worktreePath, detail, output: { result: "" } }),
  );
}

function writeAgents(agents: unknown): void {
  const payload = typeof agents === "string" ? agents : JSON.stringify(agents);
  writeFileSync(join(sandbox, "agents.json"), payload);
}

function removalLog(): string {
  return readFileSync(join(sandbox, "removed.log"), "utf8");
}

function rmStdin(): string {
  try {
    return readFileSync(join(sandbox, "rm.stdin"), "utf8");
  } catch {
    return "";
  }
}

function gumLog(): string {
  try {
    return readFileSync(join(sandbox, "gum.log"), "utf8");
  } catch {
    return "";
  }
}

function ghCalls(): string[] {
  try {
    return readFileSync(join(sandbox, "gh.log"), "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function probe(command: string): void {
  const result = Bun.spawnSync({
    cmd: [command, "--prune-probe"],
    env: process.env,
    stdin: "ignore",
  });
  if (result.stdout.toString().trim() !== "stub") {
    throw new Error(`${command} resolved to ${Bun.which(command, { PATH: process.env.PATH })}`);
  }
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "claude-prune-agents-"));
  stubs = join(sandbox, "stub");
  nogum = join(sandbox, "nogum");
  repo = join(sandbox, "repo");
  mkdirSync(stubs);
  mkdirSync(nogum);
  mkdirSync(join(repo, ".worktrees"), { recursive: true });

  // The program reads each agent's summary from $HOME/.claude/jobs/<id>/state.json.
  process.env.HOME = sandbox;
  process.env.AGENTS_JSON = join(sandbox, "agents.json");
  process.env.CLAUDE_RM_LOG = join(sandbox, "removed.log");
  process.env.GH_LOG = join(sandbox, "gh.log");
  process.env.GUM_LOG = join(sandbox, "gum.log");
  process.env.GUM_CHOOSE_INPUT = join(sandbox, "choose.in");
  process.env.CLAUDE_RM_STDIN = join(sandbox, "rm.stdin");
  delete process.env.GUM_PICK;
  delete process.env.CLAUDE_RM_EXIT;
  delete process.env.GH_NO_SLUG;
  writeFileSync(process.env.CLAUDE_RM_LOG, "");
  writeFileSync(process.env.CLAUDE_RM_STDIN, "");

  for (const [name, script] of [
    ["claude", CLAUDE_STUB],
    ["gh", GH_STUB],
    ["gum", GUM_STUB],
  ] as const) {
    writeStub(stubs, name, script);
    // The no-gum PATH holds everything the program needs except gum, so its
    // absence cannot be shadowed by a real one further down the machine's PATH.
    if (name !== "gum") writeStub(nogum, name, script);
  }

  // merged01 worked in a worktree, so its branch resolves a merged PR.
  // open0001's branch resolves an open PR. bare0001 has no worktree and a
  // summary whose bare #77 ref resolves against its cwd repo. lost0001 has
  // neither a worktree nor a resolvable repo, so it has no discoverable PR.
  // flaky001's branch query fails while its summary ref still resolves to a
  // merged PR: classifying from that partial result would remove it.
  writeState("merged01", join(repo, ".worktrees", "merged-branch"), "shipped it");
  writeState("open0001", join(repo, ".worktrees", "open-branch"), "shipped it");
  writeState("bare0001", "", "shipped as PR #77");
  writeState("lost0001", "", "nothing to see");
  writeState("flaky001", join(repo, ".worktrees", "flaky-branch"), "shipped as PR #77");
  writeAgents(AGENTS(repo, sandbox));

  process.env.PATH = `${stubs}:${environment.PATH}`;
  probe("claude");
  probe("gh");
  probe("gum");
});

afterEach(() => {
  process.env.PATH = environment.PATH;
  if (environment.HOME === undefined) delete process.env.HOME;
  else process.env.HOME = environment.HOME;
  for (const name of [
    "AGENTS_JSON",
    "CLAUDE_RM_LOG",
    "CLAUDE_RM_EXIT",
    "GH_LOG",
    "GH_NO_SLUG",
    "GUM_LOG",
    "GUM_PICK",
    "GUM_CHOOSE_INPUT",
    "CLAUDE_RM_STDIN",
  ]) {
    delete process.env[name];
  }
  rmSync(sandbox, { recursive: true, force: true });
});

describe("run --dry-run", () => {
  test("classifies each completed agent and removes nothing", async () => {
    const outcome = await run(["--dry-run"], false);

    expect(outcome.status).toBe(0);
    expect(outcome.stdout).toContain("DECISION");
    expect(outcome.stdout).toContain("merged01");
    expect(outcome.stdout).toContain("#1 merged");
    expect(outcome.stdout).toContain("stale");
    expect(outcome.stdout).toContain("open0001");
    expect(outcome.stdout).toContain("#2 open");
    expect(outcome.stdout).toContain("keep");
    expect(outcome.stdout).toContain("no PRs");
    expect(outcome.stdout).toContain("2 agents removable (2 kept, 1 skipped: no PRs)");
    expect(removalLog()).toBe("");
  });

  // A failed branch query is empty output, same as a branch with no PR. Reading
  // it as "no PRs" would let the agent's merged summary ref carry it to stale.
  test("keeps an agent whose branch query failed", async () => {
    const outcome = await run(["--dry-run"], false);

    expect(outcome.stdout).toContain("lookup failed, #77 merged");
    expect(outcome.stdout).toMatch(/flaky001 +flaky agent +\S+ +lookup failed, #77 merged +keep/);
  });

  test("resolves a bare PR ref against the agent's own repo", async () => {
    expect((await run(["--dry-run"], false)).stdout).toContain("#77 merged");
  });

  test("leaves agents that are not done alone", async () => {
    const outcome = await run(["--dry-run"], false);

    expect(outcome.stdout).not.toContain("working1");
    expect(outcome.stdout).not.toContain("live session");
  });

  // Every discovered PR is terminal only for merged01 and bare0001, and both
  // keep and skip agents stay out of the removable count.
  test("counts only the stale agents as removable", async () => {
    expect((await run(["-n"], false)).stdout.trimEnd().split("\n").at(-1)).toBe(
      "2 agents removable (2 kept, 1 skipped: no PRs)",
    );
  });

  // The table is the whole point of the flag, so a run that meant to force sees
  // a report rather than a removal.
  test("wins over --force", async () => {
    const outcome = await run(["--dry-run", "--force"], false);

    expect(outcome.stdout).toContain("DECISION");
    expect(outcome.stdout).toContain("2 agents removable");
    expect(removalLog()).toBe("");
  });
});

describe("run --force", () => {
  test("removes every stale agent and nothing else", async () => {
    const outcome = await run(["--force"], false);

    expect(outcome.status).toBe(0);
    expect(outcome.stdout).toContain("2 agents removed");
    expect(removalLog()).toContain("rm merged01");
    expect(removalLog()).toContain("rm bare0001");
    expect(removalLog()).not.toContain("rm open0001");
    expect(removalLog()).not.toContain("rm lost0001");
    expect(removalLog()).not.toContain("rm flaky001");
  });

  test("prints no table", async () => {
    expect((await run(["--force"], false)).stdout).not.toContain("DECISION");
  });

  // A removal that failed is reported and counted, and the run still completes:
  // `claude rm` refuses when there are unpushed commits, which is a finding
  // rather than an error.
  test("reports a failed removal and still completes", async () => {
    process.env.CLAUDE_RM_EXIT = "1";

    const outcome = await run(["--force"], false);

    expect(outcome.status).toBe(0);
    expect(outcome.stdout).toContain("0 agents removed (2 kept, 1 skipped: no PRs, 2 failed)");
    expect(gumLog()).toContain(
      "log --level warn claude rm merged01 failed, likely unpushed commits",
    );
  });

  // Calling gum unconditionally answered a failed removal with `command not
  // found` on a machine that has none.
  test("warns on stderr where gum is absent", async () => {
    process.env.CLAUDE_RM_EXIT = "1";
    process.env.PATH = nogum;

    const outcome = await run(["--force"], false);

    expect(outcome.status).toBe(0);
    expect(outcome.stderr).toContain("claude rm merged01 failed, likely unpushed commits");
    expect(outcome.stdout).toContain("2 failed");
  });
});

describe("run interactive", () => {
  test("offers the stale agents preselected and removes what comes back", async () => {
    process.env.GUM_PICK = ".";

    const outcome = await run([], true);

    const offered = readFileSync(join(sandbox, "choose.in"), "utf8");
    expect(offered).toContain("merged01");
    expect(offered).toContain("bare0001");
    expect(offered).not.toContain("open0001");
    // Preselected, so enter accepts the batch and a row has to be deselected to
    // be kept. Without it the same keypress removes nothing.
    expect(gumLog()).toContain("--selected=*");
    expect(outcome.stdout).toContain("2 agents removed");
    expect(removalLog()).toContain("rm merged01");
  });

  // An agent names itself, and a name carrying a newline used to split its row
  // across two lines: gum offered two entries, neither matched the label the
  // selection is read back against, and the agent was silently never removed.
  test("removes an agent whose name holds a newline", async () => {
    const agents = AGENTS(repo, sandbox);
    writeAgents(
      agents.map((agent) =>
        "id" in agent && agent.id === "merged01" ? { ...agent, name: "merged\nagent" } : agent,
      ),
    );
    process.env.GUM_PICK = "merged01";

    const outcome = await run([], true);

    const offered = readFileSync(join(sandbox, "choose.in"), "utf8").split("\n").filter(Boolean);
    expect(offered.length).toBe(2);
    expect(outcome.stdout).toContain("1 agent removed");
    expect(removalLog()).toContain("rm merged01");
  });

  // A handful of gh calls per agent, so a terminal run shows progress. The title
  // counts the candidates rather than every agent. It reaches gum through
  // bin/spin, which is the only thing that knows whether a spinner or a log line
  // is what the terminal can render.
  test("spins over the candidate count while the scan runs", async () => {
    process.env.GUM_PICK = ".";

    await run([], true);

    expect(gumLog()).toContain("Resolving PRs for 5 agents");
  });

  // gum 2 writes its frames to stderr whether or not a terminal can interpret
  // them, so an unattended run would capture them as control characters.
  test("shows no progress where nothing renders it", async () => {
    await run(["--dry-run"], false);

    expect(gumLog()).toBe("");
  });

  test("removes only the rows that came back selected", async () => {
    process.env.GUM_PICK = "merged01";

    const outcome = await run([], true);

    expect(outcome.stdout).toContain("1 agent removed");
    expect(removalLog()).toContain("rm merged01");
    expect(removalLog()).not.toContain("rm bare0001");
  });

  // Escaping the checklist, and a gum that could not render one, both come back
  // as no selection, so nothing is removed and the run still succeeds.
  test("removes nothing when the checklist comes back empty", async () => {
    const outcome = await run([], true);

    expect(outcome.status).toBe(0);
    expect(outcome.stdout).toContain("0 agents removed (2 kept, 1 skipped: no PRs)");
    expect(removalLog()).toBe("");
  });

  // Without a checklist there is no way to approve the batch, and removing
  // nothing while reporting success would read as "nothing was stale".
  test("fails loudly when gum is absent", async () => {
    process.env.PATH = nogum;

    const outcome = await run([], true);

    expect(outcome.status).toBe(1);
    expect(outcome.stderr).toContain("gum is required");
    expect(removalLog()).toBe("");
  });

  test("fails loudly when there is no terminal to render the checklist", async () => {
    const outcome = await run([], false);

    expect(outcome.status).toBe(1);
    expect(outcome.stderr).toContain("interactive selection needs a terminal");
    expect(removalLog()).toBe("");
  });

  // The guard is reached only when something is stale, so a machine with nothing
  // to prune completes without gum and without a terminal.
  test("says nothing was removed when nothing is stale", async () => {
    writeAgents([
      { id: "open0001", cwd: repo, kind: "background", startedAt: 1, name: "open agent", state: "done" },
    ]);
    process.env.PATH = nogum;

    const outcome = await run([], false);

    expect(outcome.status).toBe(0);
    expect(outcome.stdout).toBe("0 agents removed (1 kept)\n");
  });
});

describe("run", () => {
  test.each<{ name: string; agents: string }>([
    { name: "empty output", agents: "" },
    { name: "an empty list", agents: "[]" },
  ])("reports no agents for $name", async ({ agents }) => {
    writeAgents(agents);
    expect(await run(["--dry-run"], false)).toEqual({
      status: 0,
      stdout: "no agents\n",
      stderr: "",
    });
  });

  // A claude that is missing, broken, or unauthenticated produces empty output,
  // so this machine is indistinguishable from one with no agents.
  test("reports no agents when claude cannot be run", async () => {
    process.env.PATH = join(sandbox, "empty");
    mkdirSync(process.env.PATH);

    expect(await run(["--dry-run"], false)).toEqual({
      status: 0,
      stdout: "no agents\n",
      stderr: "",
    });
  });

  test("reports no completed agents when nothing is done", async () => {
    writeAgents([
      { id: "working1", cwd: repo, kind: "background", startedAt: 1, name: "busy", state: "working" },
    ]);

    expect(await run(["--dry-run"], false)).toEqual({
      status: 0,
      stdout: "no completed agents\n",
      stderr: "",
    });
  });

  test("says so on stderr when the agent list cannot be read", async () => {
    writeAgents("{not json");

    const outcome = await run(["--dry-run"], false);

    expect(outcome.status).toBe(0);
    expect(outcome.stdout).toBe("no completed agents\n");
    expect(outcome.stderr).toContain("could not read the agent list");
  });

  test("prints the usage before asking claude anything", async () => {
    process.env.PATH = join(sandbox, "empty");
    mkdirSync(process.env.PATH);

    const outcome = await run(["--force", "--help"], false);

    expect(outcome.status).toBe(0);
    expect(outcome.stdout).toContain("Usage: claude-prune-agents [-f|--force] [-n|--dry-run]");
    expect(outcome.stdout).toContain("  -n, --dry-run  print the decision table, remove nothing");
  });

  test("refuses an unknown option without scanning anything", async () => {
    const outcome = await run(["--nope"], false);

    expect(outcome).toEqual({
      status: 1,
      stdout: "",
      stderr: "claude-prune-agents: unknown option: --nope\n",
    });
    expect(ghCalls()).toEqual([]);
    expect(removalLog()).toBe("");
  });

  // The scan hits the same handful of repos repeatedly and each lookup is a
  // subprocess, so the answer is memoized for the life of the run.
  test("resolves a repo slug once per repo root", async () => {
    await run(["--dry-run"], false);

    expect(ghCalls().filter((call) => call.startsWith("repo view"))).toHaveLength(1);
  });

  // A repo root that does not exist gets no slug, so the branch query and the
  // bare-ref resolution are both skipped and the agent only ever reaches the
  // table.
  test("skips an agent whose repo root is gone", async () => {
    const outcome = await run(["--dry-run"], false);

    expect(outcome.stdout).toMatch(/lost0001 +lost agent +\S+ +- +skip +no PRs/);
  });

  // Losing the slug loses the branch query too, so nothing is discovered and
  // nothing is removable.
  test("removes nothing when no repo slug resolves", async () => {
    process.env.GH_NO_SLUG = "1";

    const outcome = await run(["--dry-run"], false);

    expect(outcome.stdout).toContain("0 agents removable (5 skipped: no PRs)");
  });
});

describe("the executable", () => {
  function spawnPrune(args: string[]) {
    return Bun.spawnSync({
      cmd: [process.execPath, SCRIPT, ...args],
      env: process.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  }

  test("prints the decision table and exits 0", () => {
    const prune = spawnPrune(["--dry-run"]);

    expect(prune.exitCode).toBe(0);
    expect(prune.stdout.toString()).toContain("ID");
    expect(prune.stdout.toString()).toContain("2 agents removable (2 kept, 1 skipped: no PRs)\n");
    expect(removalLog()).toBe("");
  });

  test("carries the unknown-option error on stderr and exits 1", () => {
    const prune = spawnPrune(["--nope"]);

    expect(prune.exitCode).toBe(1);
    expect(prune.stdout.toString()).toBe("");
    expect(prune.stderr.toString()).toBe("claude-prune-agents: unknown option: --nope\n");
  });

  // Through a real pipeline a write takes only what fits in the buffer and
  // exiting drops whatever is queued behind it, so a long table arrived cut
  // mid-row with the summary line gone.
  test("writes a table longer than a pipe buffer in full", () => {
    const agents = Array.from({ length: 4000 }, (_, index) => ({
      id: `agent${index.toString().padStart(4, "0")}`,
      cwd: join(sandbox, "gone"),
      kind: "background",
      startedAt: 1,
      name: `agent number ${index}`,
      state: "done",
    }));
    writeAgents(agents);

    const piped = Bun.spawnSync({
      cmd: ["/bin/sh", "-c", `'${process.execPath}' '${SCRIPT}' --dry-run | /bin/cat`],
      env: process.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const printed = piped.stdout.toString().split("\n").filter(Boolean);

    expect(printed.length).toBe(agents.length + 2);
    expect(printed.at(-1)).toBe("0 agents removable (4000 skipped: no PRs)");
  });

  // `| head` closes the pipe as soon as it has what it wants. The shell died on
  // SIGPIPE with nothing to say, and a raised EPIPE would answer a routine look
  // at the top of the table with a stack trace.
  test("stays quiet when the reader stops early", () => {
    writeAgents(
      Array.from({ length: 4000 }, (_, index) => ({
        id: `agent${index.toString().padStart(4, "0")}`,
        cwd: join(sandbox, "gone"),
        kind: "background",
        startedAt: 1,
        name: `agent number ${index}`,
        state: "done",
      })),
    );

    const piped = Bun.spawnSync({
      cmd: ["/bin/sh", "-c", `'${process.execPath}' '${SCRIPT}' --dry-run | /usr/bin/head -3`],
      env: process.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(piped.stderr.toString()).toBe("");
    expect(piped.stdout.toString().split("\n").filter(Boolean).length).toBe(3);
  });

  // Its stdin so it cannot eat the keystrokes meant for the picker or block on a
  // prompt, its stdout and stderr so nothing of its own lands in the table.
  test("runs claude rm with all three streams closed", () => {
    const prune = Bun.spawnSync({
      cmd: [process.execPath, SCRIPT, "--force"],
      env: process.env,
      stdin: Buffer.from("keystrokes meant for something else\n"),
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(removalLog()).toContain("rm merged01");
    expect(rmStdin()).toBe("");
    expect(prune.stdout.toString()).not.toContain("noise");
    expect(prune.stderr.toString()).not.toContain("noise");
  });
});
