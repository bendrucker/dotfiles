import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { quote, resolveOnPath, run, sandbox, type Sandbox } from "#harness";

const script = join(import.meta.dir, "herdr-agent-state");
const config = join(import.meta.dir, "..", "config.toml");

const MINUTE = 60 * 1000;

interface PaneShape {
  pane_id: string;
  agent?: string;
  agent_status?: string;
  focused?: boolean;
  tokens?: Record<string, string>;
}

function snapshot(box: Sandbox, panes: PaneShape[]): void {
  box.write("snapshot.json", JSON.stringify({ result: { snapshot: { panes } } }));
}

function stubHerdr(box: Sandbox, reportStatus = 0): void {
  box.stub(
    "herdr",
    [
      'case "$1 $2" in',
      `  "api snapshot") exec cat ${quote(box.path("snapshot.json"))} ;;`,
      `  *" report-metadata") printf '%s\\n' "$*" >> ${quote(box.path("reported"))}; exit ${reportStatus} ;;`,
      "  *) exit 1 ;;",
      "esac",
    ].join("\n"),
  );
}

const statePath = "state/dotfiles/herdr-agent-state.json";

function seed(box: Sandbox, activity: Record<string, { wasWorking: boolean; lastWorkingAt: number }>): void {
  box.write(statePath, JSON.stringify(activity));
}

function recorded(box: Sandbox): Record<string, { wasWorking: boolean; lastWorkingAt: number }> {
  return JSON.parse(box.read(statePath) || "{}");
}

// A reported line reads `pane report-metadata p1 --source agent-state --token agent_done=✓`.
function reported(box: Sandbox): string[] {
  return box.read("reported").split("\n").filter(Boolean);
}

function linesFor(box: Sandbox, id: string): string {
  return reported(box)
    .filter((line) => line.includes(` ${id} `))
    .join("\n");
}

function state(box: Sandbox): ReturnType<typeof run> {
  return run([script], { path: [box.bin], env: { XDG_STATE_HOME: box.path("state") } });
}

let box: Sandbox;

beforeEach(() => {
  box = sandbox("herdr-agent-state");
  stubHerdr(box);
});

afterEach(() => {
  box.remove();
});

describe("herdr-agent-state", () => {
  // launcherContract runs shellcheck, which has no shell to read in a bun
  // script. Its other two clauses still hold.
  test("is executable", () => {
    expect(statSync(script).mode & 0o111).not.toBe(0);
  });

  test("is reachable on PATH from a login shell", () => {
    expect(resolveOnPath("herdr", "herdr-agent-state")).toBe(realpathSync(script));
  });

  test("runs on the tab bar interval by the name PATH exports", () => {
    expect(readFileSync(config, "utf8")).toContain('command = "herdr-agent-state"');
  });

  // herdr validates a token name and never learns what writes it, so a mark with
  // no cell is published to a sidebar that draws nothing for it.
  test("gives every mark it can publish a cell to render it", () => {
    const source = readFileSync(script, "utf8");
    const marks = source
      .slice(source.indexOf("const MARKS = {"), source.indexOf("} as const;"))
      .matchAll(/^ {2}(\w+):/gm);
    const names = [...marks].map(([, name]) => name);

    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(readFileSync(config, "utf8")).toContain(`token = "$${name}"`);
    }
  });

  // bun stays reachable for the shebang. herdr is what the case takes away.
  test("refuses when herdr does not answer", () => {
    const r = run([script], { onlyPath: [dirname(process.execPath), "/usr/bin", "/bin"] });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("could not read the herdr snapshot");
  });

  test.each<{ name: string; pane: PaneShape }>([
    { name: "no agent", pane: { pane_id: "p1", agent_status: "idle" } },
    { name: "no pane id", pane: { pane_id: "", agent: "claude", agent_status: "blocked" } },
  ])("leaves a pane with $name out of the run", ({ pane }) => {
    snapshot(box, [pane]);

    expect(state(box).status).toBe(0);
    expect(reported(box)).toEqual([]);
    expect(recorded(box)).toEqual({});
  });

  test("clears every mark off a working pane and records the activity", () => {
    snapshot(box, [
      { pane_id: "p1", agent: "claude", agent_status: "working", tokens: { agent_done: "✓" } },
    ]);
    seed(box, { p1: { wasWorking: false, lastWorkingAt: Date.now() - 300 * MINUTE } });

    expect(state(box).status).toBe(0);
    expect(linesFor(box, "p1")).toContain("--clear-token agent_done");
    expect(recorded(box).p1.lastWorkingAt).toBeGreaterThan(Date.now() - MINUTE);
  });

  test("latches done when a turn ends on a pane nobody is looking at", () => {
    snapshot(box, [{ pane_id: "p1", agent: "claude", agent_status: "idle" }]);
    seed(box, { p1: { wasWorking: true, lastWorkingAt: Date.now() } });

    expect(state(box).status).toBe(0);
    expect(linesFor(box, "p1")).toContain("--token agent_done=✓");
  });

  test("latches nothing when the turn ends on the focused pane", () => {
    snapshot(box, [{ pane_id: "p1", agent: "claude", agent_status: "idle", focused: true }]);
    seed(box, { p1: { wasWorking: true, lastWorkingAt: Date.now() } });

    expect(state(box).status).toBe(0);
    expect(reported(box)).toEqual([]);
  });

  // herdr derives `done` itself and will not accept it from report-agent, so it
  // reaches a pane without any working poll before it.
  test("latches done off the status herdr derives, with no working poll behind it", () => {
    snapshot(box, [{ pane_id: "p1", agent: "claude", agent_status: "done" }]);
    seed(box, { p1: { wasWorking: false, lastWorkingAt: Date.now() } });

    expect(state(box).status).toBe(0);
    expect(linesFor(box, "p1")).toContain("--token agent_done=✓");
  });

  test("holds a done latch through later polls, and says nothing while it holds", () => {
    snapshot(box, [
      { pane_id: "p1", agent: "claude", agent_status: "idle", tokens: { agent_done: "✓" } },
    ]);
    seed(box, { p1: { wasWorking: false, lastWorkingAt: Date.now() } });

    expect(state(box).status).toBe(0);
    expect(reported(box)).toEqual([]);
  });

  test("clears a done latch once the pane is observed focused", () => {
    snapshot(box, [
      { pane_id: "p1", agent: "claude", agent_status: "idle", focused: true, tokens: { agent_done: "✓" } },
    ]);
    seed(box, { p1: { wasWorking: false, lastWorkingAt: Date.now() } });

    expect(state(box).status).toBe(0);
    expect(linesFor(box, "p1")).toContain("--clear-token agent_done");
  });

  test("marks a blocked pane", () => {
    snapshot(box, [{ pane_id: "p1", agent: "claude", agent_status: "blocked" }]);

    expect(state(box).status).toBe(0);
    expect(linesFor(box, "p1")).toContain("--token agent_blocked=?");
  });

  // Focusing the pane redraws the prompt herdr recognized the question by, so a
  // waiting question stops reporting blocked. A question answered inside one poll
  // gap therefore leaves the mark up, which is the chosen direction to err.
  test.each<{ name: string; pane: PaneShape }>([
    {
      name: "the status stops saying blocked",
      pane: { pane_id: "p1", agent: "claude", agent_status: "idle", focused: true, tokens: { agent_blocked: "?" } },
    },
    {
      name: "a turn ended",
      pane: { pane_id: "p1", agent: "claude", agent_status: "done", tokens: { agent_blocked: "?" } },
    },
  ])("holds a blocked latch when $name", ({ pane }) => {
    snapshot(box, [pane]);
    seed(box, { p1: { wasWorking: false, lastWorkingAt: Date.now() } });

    expect(state(box).status).toBe(0);
    expect(reported(box)).toEqual([]);
  });

  test("clears a blocked latch when the agent works again", () => {
    snapshot(box, [
      { pane_id: "p1", agent: "claude", agent_status: "working", tokens: { agent_blocked: "?" } },
    ]);
    seed(box, { p1: { wasWorking: false, lastWorkingAt: Date.now() - 5 * MINUTE } });

    expect(state(box).status).toBe(0);
    expect(linesFor(box, "p1")).toContain("--clear-token agent_blocked");
  });

  test("marks a pane parked past the threshold", () => {
    snapshot(box, [{ pane_id: "p1", agent: "claude", agent_status: "idle" }]);
    seed(box, { p1: { wasWorking: false, lastWorkingAt: Date.now() - 121 * MINUTE } });

    expect(state(box).status).toBe(0);
    expect(linesFor(box, "p1")).toContain("--token agent_stale=◦");
  });

  test("leaves a pane short of the threshold unmarked", () => {
    snapshot(box, [{ pane_id: "p1", agent: "claude", agent_status: "idle" }]);
    seed(box, { p1: { wasWorking: false, lastWorkingAt: Date.now() - 119 * MINUTE } });

    expect(state(box).status).toBe(0);
    expect(reported(box)).toEqual([]);
  });

  // A restart with no record would otherwise read every idle pane as abandoned.
  test("counts a pane it has never seen as having just worked", () => {
    snapshot(box, [{ pane_id: "p1", agent: "claude", agent_status: "idle" }]);

    expect(state(box).status).toBe(0);
    expect(reported(box)).toEqual([]);
  });

  test("says nothing about a pane already showing the mark it wants", () => {
    snapshot(box, [
      { pane_id: "p1", agent: "claude", agent_status: "blocked", tokens: { agent_blocked: "?" } },
    ]);

    expect(state(box).status).toBe(0);
    expect(reported(box)).toEqual([]);
  });

  test("forgets a pane the snapshot no longer carries", () => {
    snapshot(box, [{ pane_id: "p2", agent: "claude", agent_status: "working" }]);
    seed(box, {
      p1: { wasWorking: false, lastWorkingAt: Date.now() - 300 * MINUTE },
      p2: { wasWorking: true, lastWorkingAt: Date.now() },
    });

    expect(state(box).status).toBe(0);
    expect(Object.keys(recorded(box))).toEqual(["p2"]);
  });

  // The tab bar logs a status command that exits non-zero. Exiting 0 would leave
  // a stuck mark silent.
  test("exits non-zero when a mark would not take, having tried the rest", () => {
    stubHerdr(box, 1);
    snapshot(box, [
      { pane_id: "p1", agent: "claude", agent_status: "blocked" },
      { pane_id: "p2", agent: "claude", agent_status: "idle" },
    ]);
    seed(box, { p2: { wasWorking: true, lastWorkingAt: Date.now() } });

    const r = state(box);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("could not report");
    expect(linesFor(box, "p1")).toContain("--token agent_blocked=?");
    expect(linesFor(box, "p2")).toContain("--token agent_done=✓");
  });

  test("leaves a failed mark's transition in the record for the next run", () => {
    stubHerdr(box, 1);
    snapshot(box, [{ pane_id: "p1", agent: "claude", agent_status: "idle" }]);
    seed(box, { p1: { wasWorking: true, lastWorkingAt: Date.now() } });

    expect(state(box).status).not.toBe(0);
    expect(recorded(box).p1.wasWorking).toBe(true);
  });

  test("spends one call on a pane however many of its marks moved", () => {
    snapshot(box, [
      { pane_id: "p1", agent: "claude", agent_status: "blocked", tokens: { agent_stale: "\u25e6" } },
    ]);

    expect(state(box).status).toBe(0);
    expect(reported(box)).toHaveLength(1);
    expect(linesFor(box, "p1")).toContain("--clear-token agent_stale");
    expect(linesFor(box, "p1")).toContain("--token agent_blocked=?");
  });

  // A run killed at the timeout writes no state file, so the turn that ended
  // while it was part way through goes unrecorded.
  test("reports every moved pane at once rather than one after another", () => {
    box.stub(
      "herdr",
      [
        'case "$1 $2" in',
        `  "api snapshot") exec cat ${quote(box.path("snapshot.json"))} ;;`,
        `  *" report-metadata") printf 'start %s\\n' "$3" >> ${quote(box.path("order"))}` +
          `; sleep 0.3; printf 'end %s\\n' "$3" >> ${quote(box.path("order"))}; exit 0 ;;`,
        "  *) exit 1 ;;",
        "esac",
      ].join("\n"),
    );
    snapshot(
      box,
      ["p1", "p2", "p3"].map((pane_id) => ({ pane_id, agent: "claude", agent_status: "blocked" })),
    );

    expect(state(box).status).toBe(0);

    const order = box.read("order").split("\n").filter(Boolean);
    expect(order.slice(0, 3).every((line) => line.startsWith("start"))).toBe(true);
  });

  test("reports a state file it cannot parse, having marked what it could", () => {
    box.write(statePath, "{ not json");
    snapshot(box, [{ pane_id: "p1", agent: "claude", agent_status: "blocked" }]);

    const r = state(box);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("could not read");
    expect(linesFor(box, "p1")).toContain("--token agent_blocked=?");
  });

  test("ignores an activity entry whose timestamp is not a finite number", () => {
    snapshot(box, [{ pane_id: "p1", agent: "claude", agent_status: "idle" }]);
    box.write(statePath, '{ "p1": { "wasWorking": false, "lastWorkingAt": -1e999 } }');

    expect(state(box).status).toBe(0);
    expect(reported(box)).toEqual([]);
  });

  test("refuses a snapshot carrying no panes", () => {
    box.write("snapshot.json", JSON.stringify({ result: {} }));

    const r = state(box);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("carried no panes");
  });
});
