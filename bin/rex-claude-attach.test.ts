import { afterEach, beforeEach, describe as group, expect, test } from "bun:test";
import { join } from "node:path";
import { run, sandbox, stubGum, type Sandbox } from "#harness";
import { recorded, recordingStub } from "#harness/recorder";
import {
  type Agent,
  candidates,
  filtered,
  findAgent,
  homeSession,
  type Pane,
  parsePick,
  type Pick,
  rows,
  showsAgent,
  type Status,
  statusOf,
} from "./rex-claude-attach";

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
  expect(candidates(agents, [makePane({ pid: 2 })]).map((a) => a.name)).toEqual(["asking", "busy", "shown", "done"]);
});

group("statusOf", () => {
  test.each<{ name: string; agent: Partial<Agent>; status: Status }>([
    {
      name: "a permission prompt",
      agent: { state: "blocked", status: "waiting", waitingFor: "permission prompt" },
      status: { group: "waiting", text: "needs input: permission prompt" },
    },
    { name: "blocked with no reason", agent: { state: "blocked", status: undefined }, status: { group: "waiting", text: "needs input" } },
    { name: "a failed run", agent: { state: "failed", status: undefined }, status: { group: "failed", text: "failed" } },
    { name: "a busy interactive session", agent: { state: undefined, status: "busy" }, status: { group: "working", text: "working" } },
    { name: "a finished run", agent: { state: "done", status: "idle" }, status: { group: "done", text: "done" } },
    { name: "a stopped run", agent: { state: "stopped", status: undefined }, status: { group: "done", text: "stopped" } },
    { name: "an idle interactive session", agent: { state: undefined, status: "idle" }, status: { group: "idle", text: "idle" } },
  ])("$name", ({ agent, status }) => {
    expect(statusOf(makeAgent(agent))).toEqual(status);
  });
});

test("rows align names and statuses, color the status, and dim a home-relative directory", () => {
  const agents = [
    makeAgent({ name: "a", state: "blocked", status: "waiting", waitingFor: "input needed", cwd: "/home/u/src/repo" }),
    makeAgent({ name: "longer-name", cwd: "/elsewhere" }),
  ];
  expect(rows(agents, "/home/u")).toMatchInlineSnapshot(`
    [
      "0	a          	\x1B[1;31mneeds input: input needed\x1B[0m	\x1B[2m~/src/repo\x1B[0m",
      "1	longer-name	\x1B[33mworking                  \x1B[0m	\x1B[2m/elsewhere\x1B[0m",
    ]
  `);
});

test("filters hide finished sessions by default and narrow to the ones needing input", () => {
  const agents = [
    makeAgent({ name: "asking", state: "blocked", status: "waiting" }),
    makeAgent({ name: "busy" }),
    makeAgent({ name: "finished", state: "done", status: "idle" }),
  ];
  const names = (list: string[]) => list.map((row) => row.split("\t").slice(0, 2).map((field) => field.trim()).join(" "));
  const lists = filtered(agents, "/home/u");
  expect({ active: names(lists.active), waiting: names(lists.waiting), all: names(lists.all) }).toEqual({
    active: ["0 asking", "1 busy"],
    waiting: ["0 asking"],
    all: ["0 asking", "1 busy", "2 finished"],
  });
});

group("parsePick", () => {
  test.each<{ name: string; out: string; pick: Pick | undefined }>([
    { name: "enter opens a tab", out: "\n2\tfix-thing  ·  busy\n", pick: { index: 2, placement: "tab" } },
    { name: "ctrl-v splits a pane", out: "ctrl-v\n0\tfix-thing\n", pick: { index: 0, placement: "pane" } },
    { name: "ctrl-f floats", out: "ctrl-f\n1\tfix-thing\n", pick: { index: 1, placement: "float" } },
    { name: "a key with no row", out: "ctrl-v\n", pick: undefined },
    { name: "an unknown key", out: "ctrl-x\n0\tfix-thing\n", pick: undefined },
  ])("$name", ({ out, pick }) => {
    expect(parsePick(out)).toEqual(pick);
  });
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
        `  "do session.select") [ -f '${box.path("select-fails")}' ] && { echo 'client target default is ambiguous' >&2; exit 3; } ;;`,
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
    return recorded(box).filter((call) => !["ls", "block"].includes(call[1] ?? "") && !call.includes("session.view"));
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

  test("still opens the tab when the app can't be switched to it", () => {
    stubRex(view([]), {});
    box.stub("ps", "true");
    box.write("select-fails", "");
    const result = attach("cf37276a");
    expect(result.status).toBe(0);
    expect(rexCalls().map((call) => call.slice(0, 3))).toEqual([["rex", "window", "new"], ["rex", "do", "session.select"]]);
    expect(result.stderr).toContain("couldn't switch the app to the tab: client target default is ambiguous");
  });

  test("splits a pane beside the given block", () => {
    stubRex(view(["block:here"]), { "block:here": { foreground: { pid: 5 } } });
    box.stub("ps", "echo '    5 -zsh'");
    expect(attach("cf37276a", "--as", "pane", "--beside", "block:here").status).toBe(0);
    expect(rexCalls()).toEqual([
      [
        "rex", "split", "-s", "session:dot", "-b", "block:here", "--split=right", "-c", box.path("repo"),
        "--focus=true", "--json", "--", "claude", "attach", "cf37276a",
      ],
    ]);
  });

  test("floats over the tab of the given block", () => {
    stubRex(view(["block:here"]), { "block:here": { foreground: { pid: 5 } } });
    box.stub("ps", "echo '    5 -zsh'");
    expect(attach("cf37276a", "--as", "float", "--beside", "block:here").status).toBe(0);
    const [call] = rexCalls();
    expect(call?.slice(0, 5)).toEqual(["rex", "api", "call", "-s", "session:dot"]);
    expect(JSON.parse(call?.at(-1) ?? "")).toEqual({
      window_id: "window:w",
      bounds: [0.1, 0.1, 0.8, 0.8],
      focus: true,
      layout: {
        block: {
          flavor: "com.superlogical.terminal.shell",
          options: { cwd: box.path("repo"), command: ["claude", "attach", "cf37276a"] },
        },
      },
    });
  });

  test("the picker's ctrl-v splits a pane beside the given block", () => {
    stubRex(view(["block:here"]), { "block:here": { foreground: { pid: 5 } } });
    box.stub("ps", "echo '    5 -zsh'");
    box.stub("fzf", `cat > '${box.path("rows")}'; printf 'ctrl-v\\n0\\tfix-thing\\n'`);
    expect(attach("--pick", "--beside", "block:here").status).toBe(0);
    expect(box.read("rows").split("\t").slice(0, 2)).toEqual(["0", "fix-thing"]);
    expect(rexCalls().map((call) => call.slice(0, 2))).toEqual([["rex", "split"]]);
  });

  test("dismissing the picker opens nothing", () => {
    stubRex(view([]), {});
    box.stub("ps", "true");
    box.stub("fzf", "exit 130");
    expect(attach("--pick").status).toBe(0);
    expect(rexCalls()).toEqual([]);
  });

  test.each<{ name: string; args: string[]; error: string }>([
    { name: "a pane with no block to place it beside", args: ["--as", "pane"], error: "a pane needs --beside or REX_BLOCK" },
    { name: "an unknown placement", args: ["--as", "window"], error: "--as takes tab, pane, or float, not window" },
  ])("refuses $name", ({ args, error }) => {
    stubRex(view([]), {});
    box.stub("ps", "true");
    const result = attach("cf37276a", ...args);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(error);
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
