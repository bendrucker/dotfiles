import { afterEach, beforeEach, describe as group, expect, test } from "bun:test";
import { join } from "node:path";
import { run, sandbox, stubGum, type Sandbox } from "#harness";
import { recorded, recordingStub } from "#harness/recorder";
import { type Agent, candidates, describe, findAgent, homeSession, type Pane, showsAgent } from "./rex-claude-attach";

const script = join(import.meta.dir, "rex-claude-attach");

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "cf37276a",
    sessionId: "cf37276a-0794-4a4e-b841-b970e2645a07",
    name: "fix-thing",
    cwd: "/home/u/src/repo",
    kind: "background",
    state: "working",
    status: "busy",
    ...overrides,
  };
}

function makePane(overrides: Partial<Pane> = {}): Pane {
  return { session: "session:a", label: "Work", window: "window:a", block: "block:a", ...overrides };
}

group("showsAgent", () => {
  test.each<{ name: string; pane: Partial<Pane>; agent: Partial<Agent>; shows: boolean }>([
    { name: "interactive session by pid", pane: { pid: 42 }, agent: { kind: "interactive", pid: 42 }, shows: true },
    { name: "another pid", pane: { pid: 43 }, agent: { kind: "interactive", pid: 42 }, shows: false },
    { name: "attach by short id", pane: { args: "claude attach cf37276a" }, agent: {}, shows: true },
    { name: "attach by full path and name", pane: { args: "/usr/local/bin/claude attach fix-thing" }, agent: {}, shows: true },
    { name: "attach by session id prefix", pane: { args: "claude attach cf37" }, agent: {}, shows: true },
    { name: "attach to another session", pane: { args: "claude attach 0000aaaa" }, agent: {}, shows: false },
    { name: "a shell", pane: { pid: 7, args: "-zsh" }, agent: {}, shows: false },
  ])("$name", ({ pane, agent, shows }) => {
    expect(showsAgent(makePane(pane), makeAgent(agent))).toBe(shows);
  });
});

group("findAgent", () => {
  const agents = [
    makeAgent(),
    makeAgent({ id: "0000aaaa", sessionId: "0000aaaa-1", name: "fix-other" }),
    makeAgent({ id: undefined, sessionId: "9999bbbb-1", name: "fix", kind: "interactive" }),
  ];

  test.each<{ query: string; name: string | undefined }>([
    { query: "cf37276a", name: "fix-thing" },
    { query: "0000aaaa-1", name: "fix-other" },
    { query: "fix", name: "fix" },
    { query: "fix-o", name: "fix-other" },
    { query: "9999", name: "fix" },
    { query: "nope", name: undefined },
  ])("$query", ({ query, name }) => {
    expect(findAgent(agents, query)?.name).toBe(name);
  });
});

test("candidates keep background sessions and shown interactive ones, waiting first", () => {
  const agents = [
    makeAgent({ name: "done", state: "done", status: "idle" }),
    makeAgent({ name: "unshown", kind: "interactive", pid: 1 }),
    makeAgent({ name: "shown", kind: "interactive", pid: 2, state: undefined, status: "idle" }),
    makeAgent({ name: "busy" }),
    makeAgent({ name: "asking", state: "blocked", status: "waiting", waitingFor: "permission prompt" }),
  ];
  expect(candidates(agents, [makePane({ pid: 2 })]).map((a) => a.name)).toEqual(["asking", "busy", "done", "shown"]);
});

test("describe shows the waiting reason and a home-relative directory", () => {
  const agent = makeAgent({ waitingFor: "input needed", cwd: "/home/u/src/repo" });
  expect(describe(agent, "/home/u")).toMatchInlineSnapshot(`"fix-thing  ·  input needed  ·  ~/src/repo"`);
});

group("homeSession", () => {
  test.each<{ name: string; panes: Partial<Pane>[]; session: string | undefined }>([
    {
      name: "the session labeled for the repo",
      panes: [{ session: "s:other", cwd: "/r/dotfiles/x" }, { session: "s:dot", label: "Dotfiles" }],
      session: "s:dot",
    },
    { name: "a session with a pane in the repo", panes: [{ session: "s:in", cwd: "/r/dotfiles/sub" }], session: "s:in" },
    { name: "a sibling repo isn't inside", panes: [{ session: "s:no", cwd: "/r/dotfiles-old" }], session: "s:env" },
  ])("$name", ({ panes, session }) => {
    expect(homeSession("/r/dotfiles", panes.map(makePane), "s:env")).toBe(session);
  });
});

group("main", () => {
  let box: Sandbox;

  beforeEach(() => {
    box = sandbox("rex-claude-attach");
    stubGum(box);
    box.write("agents.json", JSON.stringify([makeAgent({ cwd: box.path("repo") })]));
    box.write("ls.json", JSON.stringify({ sessions: [{ session_id: "session:dot", label: "Repo" }] }));
    box.stub("claude", `cat '${box.path("agents.json")}'`);
    box.stub("git", "exit 128");
  });

  afterEach(() => box.remove());

  function stubRex(view: object, processes: Record<string, object>): void {
    box.write("view.json", JSON.stringify(view));
    for (const [block, body] of Object.entries(processes)) box.write(`process-${block}.json`, JSON.stringify(body));
    recordingStub(
      box,
      "rex",
      [
        'case "$1 $2" in',
        `  "ls --json") cat '${box.path("ls.json")}' ;;`,
        `  "api call") cat '${box.path("view.json")}' ;;`,
        `  "block call") cat '${box.path("process-")}'"$6".json ;;`,
        `  "window new") echo '{"window_id":"window:new"}' ;;`,
        "esac",
      ].join("\n"),
    );
  }

  function view(blocks: string[]): object {
    return { windows: [{ window_id: "window:w", layers: [{ blocks: blocks.map((block_id) => ({ block_id })) }] }] };
  }

  function attach(...args: string[]) {
    return run([script, ...args], { path: [box.bin], env: { ZDOTDIR: box.mkdir("empty"), REX_SESSION: "session:env" } });
  }

  function rexCalls(): string[][] {
    return recorded(box).filter((call) => !["ls", "api", "block"].includes(call[1] ?? ""));
  }

  test("focuses the pane already attached", () => {
    stubRex(view(["block:b"]), { "block:b": { foreground: { pid: 77 } } });
    box.stub("ps", "echo '   77 claude attach cf37276a'");
    expect(attach("fix-thing").status).toBe(0);
    expect(rexCalls()).toEqual([
      ["rex", "focus", "-s", "session:dot", "block:b"],
      ["rex", "do", "session.select", "session_id=session:dot", "window_id=window:w"],
    ]);
  });

  test("opens a tab in the repo's session when no pane shows the session", () => {
    stubRex(view(["block:b"]), { "block:b": { foreground: { pid: 77, cwd: box.path("repo") } } });
    box.stub("ps", "echo '   77 -zsh'");
    expect(attach("cf37").status).toBe(0);
    expect(rexCalls()).toEqual([
      [
        "rex", "window", "new", "-s", "session:dot", "fix-thing", "-c", box.path("repo"),
        "--focus=true", "--json", "--", "claude", "attach", "cf37276a",
      ],
      ["rex", "do", "session.select", "session_id=session:dot", "window_id=window:new"],
    ]);
  });

  test("leaves focus alone with --no-focus", () => {
    stubRex(view([]), {});
    box.stub("ps", "true");
    expect(attach("cf37276a", "--no-focus").status).toBe(0);
    expect(rexCalls().map((call) => call.slice(0, 3))).toEqual([["rex", "window", "new"]]);
    expect(rexCalls()[0]).toContain("--focus=false");
  });

  test("fails on an unknown session", () => {
    stubRex(view([]), {});
    const result = attach("nope");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no Claude session matches nope");
  });
});
