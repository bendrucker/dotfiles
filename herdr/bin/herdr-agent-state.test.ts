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

/** This is how a test sets the clock. */
function seed(box: Sandbox, activity: Record<string, { lastStatus: string; lastWorkingAt: number }>): void {
  box.write(statePath, JSON.stringify(activity));
}

function recorded(box: Sandbox): Record<string, { lastStatus: string; lastWorkingAt: number }> {
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

  // bun stays reachable for the shebang. herdr is what the case takes away.
  test("refuses when herdr does not answer", () => {
    const r = run([script], { onlyPath: [dirname(process.execPath), "/usr/bin", "/bin"] });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("could not read the herdr snapshot");
  });

  test("leaves a pane with no agent alone", () => {
    snapshot(box, [{ pane_id: "p1", agent_status: "idle" }]);

    expect(state(box).status).toBe(0);
    expect(reported(box)).toEqual([]);
    expect(recorded(box)).toEqual({});
  });

  test("clears every mark off a working pane and records the activity", () => {
    snapshot(box, [
      { pane_id: "p1", agent: "claude", agent_status: "working", tokens: { agent_done: "✓" } },
    ]);
    seed(box, { p1: { lastStatus: "idle", lastWorkingAt: Date.now() - 300 * MINUTE } });

    expect(state(box).status).toBe(0);
    expect(linesFor(box, "p1")).toContain("--clear-token agent_done");
    expect(recorded(box).p1.lastWorkingAt).toBeGreaterThan(Date.now() - MINUTE);
  });

  test("latches done when a turn ends on a pane nobody is looking at", () => {
    snapshot(box, [{ pane_id: "p1", agent: "claude", agent_status: "idle" }]);
    seed(box, { p1: { lastStatus: "working", lastWorkingAt: Date.now() } });

    expect(state(box).status).toBe(0);
    expect(linesFor(box, "p1")).toContain("--token agent_done=✓");
  });

  // Watching a turn finish is the whole of what the mark is for.
  test("latches nothing when the turn ends on the focused pane", () => {
    snapshot(box, [{ pane_id: "p1", agent: "claude", agent_status: "idle", focused: true }]);
    seed(box, { p1: { lastStatus: "working", lastWorkingAt: Date.now() } });

    expect(state(box).status).toBe(0);
    expect(reported(box)).toEqual([]);
  });

  // herdr derives `done` itself and will not accept it from report-agent, so it
  // reaches a pane without any working poll before it.
  test("latches done off the status herdr derives, with no working poll behind it", () => {
    snapshot(box, [{ pane_id: "p1", agent: "claude", agent_status: "done" }]);
    seed(box, { p1: { lastStatus: "idle", lastWorkingAt: Date.now() } });

    expect(state(box).status).toBe(0);
    expect(linesFor(box, "p1")).toContain("--token agent_done=✓");
  });

  test("holds a done latch through later polls, and says nothing while it holds", () => {
    snapshot(box, [
      { pane_id: "p1", agent: "claude", agent_status: "idle", tokens: { agent_done: "✓" } },
    ]);
    seed(box, { p1: { lastStatus: "idle", lastWorkingAt: Date.now() } });

    expect(state(box).status).toBe(0);
    expect(reported(box)).toEqual([]);
  });

  test("clears a done latch once the pane is observed focused", () => {
    snapshot(box, [
      { pane_id: "p1", agent: "claude", agent_status: "idle", focused: true, tokens: { agent_done: "✓" } },
    ]);
    seed(box, { p1: { lastStatus: "idle", lastWorkingAt: Date.now() } });

    expect(state(box).status).toBe(0);
    expect(linesFor(box, "p1")).toContain("--clear-token agent_done");
  });

  test("marks a blocked pane", () => {
    snapshot(box, [{ pane_id: "p1", agent: "claude", agent_status: "blocked" }]);

    expect(state(box).status).toBe(0);
    expect(linesFor(box, "p1")).toContain("--token agent_blocked=?");
  });

  // Focusing the pane redraws the prompt herdr recognized the question by, so
  // the status stops saying blocked while the question is still waiting.
  test("holds a blocked latch when the status stops saying blocked", () => {
    snapshot(box, [
      { pane_id: "p1", agent: "claude", agent_status: "idle", focused: true, tokens: { agent_blocked: "?" } },
    ]);
    seed(box, { p1: { lastStatus: "blocked", lastWorkingAt: Date.now() } });

    expect(state(box).status).toBe(0);
    expect(reported(box)).toEqual([]);
  });

  test("clears a blocked latch when the agent works again", () => {
    snapshot(box, [
      { pane_id: "p1", agent: "claude", agent_status: "working", tokens: { agent_blocked: "?" } },
    ]);
    seed(box, { p1: { lastStatus: "blocked", lastWorkingAt: Date.now() - 5 * MINUTE } });

    expect(state(box).status).toBe(0);
    expect(linesFor(box, "p1")).toContain("--clear-token agent_blocked");
  });

  test("marks a pane parked past the threshold", () => {
    snapshot(box, [{ pane_id: "p1", agent: "claude", agent_status: "idle" }]);
    seed(box, { p1: { lastStatus: "idle", lastWorkingAt: Date.now() - 121 * MINUTE } });

    expect(state(box).status).toBe(0);
    expect(linesFor(box, "p1")).toContain("--token agent_stale=◦");
  });

  test("leaves a pane short of the threshold unmarked", () => {
    snapshot(box, [{ pane_id: "p1", agent: "claude", agent_status: "idle" }]);
    seed(box, { p1: { lastStatus: "idle", lastWorkingAt: Date.now() - 119 * MINUTE } });

    expect(state(box).status).toBe(0);
    expect(reported(box)).toEqual([]);
  });

  // A restart with no record would otherwise read every idle pane as abandoned.
  test("counts a pane it has never seen as having just worked", () => {
    snapshot(box, [{ pane_id: "p1", agent: "claude", agent_status: "idle" }]);

    expect(state(box).status).toBe(0);
    expect(reported(box)).toEqual([]);
  });

  // A herdr call costs about 150ms, so reporting every pane every run passes the
  // tab bar's timeout and the marks never settle.
  test("says nothing about a pane already showing the mark it wants", () => {
    snapshot(box, [
      { pane_id: "p1", agent: "claude", agent_status: "blocked", tokens: { agent_blocked: "?" } },
    ]);

    expect(state(box).status).toBe(0);
    expect(reported(box)).toEqual([]);
  });

  test("ignores a pane the snapshot gave no id", () => {
    snapshot(box, [{ pane_id: "", agent: "claude", agent_status: "blocked" }]);

    expect(state(box).status).toBe(0);
    expect(reported(box)).toEqual([]);
    expect(recorded(box)).toEqual({});
  });

  test("forgets a pane the snapshot no longer carries", () => {
    snapshot(box, [{ pane_id: "p2", agent: "claude", agent_status: "working" }]);
    seed(box, {
      p1: { lastStatus: "idle", lastWorkingAt: Date.now() - 300 * MINUTE },
      p2: { lastStatus: "working", lastWorkingAt: Date.now() },
    });

    expect(state(box).status).toBe(0);
    expect(Object.keys(recorded(box))).toEqual(["p2"]);
  });

  // The tab bar logs a status command that exits non-zero. Exiting 0 would leave
  // a pane showing a mark for something that already happened, silently.
  test("exits non-zero when a mark would not take, having tried the rest", () => {
    stubHerdr(box, 1);
    snapshot(box, [
      { pane_id: "p1", agent: "claude", agent_status: "blocked" },
      { pane_id: "p2", agent: "claude", agent_status: "idle" },
    ]);
    seed(box, { p2: { lastStatus: "working", lastWorkingAt: Date.now() } });

    const r = state(box);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("could not report");
    expect(linesFor(box, "p1")).toContain("--token agent_blocked=?");
    expect(linesFor(box, "p2")).toContain("--token agent_done=✓");
  });

  // Advancing lastStatus past the transition would retire the only evidence the
  // mark was due, so the pane would sit unmarked until it worked again.
  test("leaves a failed mark's transition in the record for the next run", () => {
    stubHerdr(box, 1);
    snapshot(box, [{ pane_id: "p1", agent: "claude", agent_status: "idle" }]);
    seed(box, { p1: { lastStatus: "working", lastWorkingAt: Date.now() } });

    expect(state(box).status).not.toBe(0);
    expect(recorded(box).p1.lastStatus).toBe("working");
  });

  test("refuses a snapshot carrying no panes", () => {
    box.write("snapshot.json", JSON.stringify({ result: {} }));

    const r = state(box);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("carried no panes");
  });
});
