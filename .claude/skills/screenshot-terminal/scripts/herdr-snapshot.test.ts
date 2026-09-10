import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { run, sandbox, type Sandbox } from "#harness";

const SCRIPT = join(import.meta.dir, "herdr-snapshot");

let box: Sandbox;

// A snapshot shaped like the server's, carrying the fields the TSVs are built
// from. `terminal_title` holds the agent's status glyph and
// `terminal_title_stripped` does not, which is what tells the two columns apart.
const SNAPSHOT = {
  result: {
    snapshot: {
      workspaces: [
        { workspace_id: "w9", number: 1, label: "work", tab_count: 2, pane_count: 2, focused: true },
      ],
      tabs: [
        { tab_id: "w9:t1", workspace_id: "w9", label: "main", focused: true },
        { tab_id: "w9:t2", workspace_id: "w9", label: "side", focused: false },
      ],
      panes: [
        {
          pane_id: "w9:p1",
          tab_id: "w9:t1",
          cwd: "/repo",
          terminal_title: "✳ fixing the parser",
          terminal_title_stripped: "fixing the parser",
        },
        {
          pane_id: "w9:p2",
          tab_id: "w9:t2",
          cwd: "/repo",
          terminal_title: "closing",
          terminal_title_stripped: "closing",
        },
      ],
      agents: [
        {
          pane_id: "w9:p1",
          agent: "claude",
          agent_status: "idle",
          agent_session: { value: "uuid-1" },
        },
      ],
    },
  },
};

beforeEach(() => {
  box = sandbox("herdr-snapshot");
  box.write("snapshot.json", JSON.stringify(SNAPSHOT));
  // `w9:p2` refuses its read, which is the pane that closed between the
  // snapshot and the buffer loop.
  box.stub(
    "herdr",
    `case "$1 $2" in
"api snapshot") cat ${box.path("snapshot.json")} ;;
"pane read")
  [ "$3" = "w9:p2" ] && exit 1
  echo "buffer for $3" ;;
esac
exit 0`,
  );
});

afterEach(() => {
  box.remove();
});

const snapshot = () =>
  run(["bash", SCRIPT, box.path("out")], { cwd: box.dir, path: [box.bin] });

const rows = (name: string) =>
  box
    .read(join("out", name))
    .trim()
    .split("\n")
    .map((line) => line.split("\t"));

// Tab objects carry `focused`. An earlier version read `.active`, a field the
// server does not send, so every row reported false and the column named no tab.
test("marks the focused tab", () => {
  const r = snapshot();
  expect(r.status).toBe(0);
  expect(rows("tabs.tsv")).toEqual([
    ["w9:t1", "w9", "main", "true"],
    ["w9:t2", "w9", "side", "false"],
  ]);
});

// Pane objects carry no `title`, which an earlier version read and so left the
// column empty for every pane.
test("takes a pane's title without the status glyph", () => {
  snapshot();
  const titles = rows("panes.tsv").map((row) => row[3]);
  expect(titles).toEqual(["fixing the parser", "closing"]);
});

test("writes the workspace and agent columns", () => {
  snapshot();
  expect(rows("workspaces.tsv")).toEqual([["w9", "1", "work", "2", "2", "true"]]);
  expect(rows("agents.tsv")).toEqual([["w9:p1", "claude", "idle", "uuid-1"]]);
});

// The pane id goes in the filename with its colon replaced, because a colon in
// a path is hostile to shell completion and to some tools.
test("names a buffer for the pane it came from", () => {
  snapshot();
  expect(box.read(join("out", "panes", "w9-p1.txt")).trim()).toBe("buffer for w9:p1");
});

// An empty file would read as a terminal showing nothing, which is a different
// finding from a pane that could not be read at all.
test("reports an unreadable pane instead of leaving an empty buffer", () => {
  const r = snapshot();
  expect(existsSync(box.path(join("out", "panes", "w9-p2.txt")))).toBe(false);
  expect(r.stderr).toContain("no buffer for w9:p2");
});
