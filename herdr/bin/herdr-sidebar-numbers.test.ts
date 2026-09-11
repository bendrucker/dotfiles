import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { quote, resolveOnPath, run, sandbox, type Sandbox } from "#harness";

const script = join(import.meta.dir, "herdr-sidebar-numbers");
const config = join(import.meta.dir, "..", "config.toml");

const SNAPSHOT = {
  result: {
    snapshot: {
      workspaces: Array.from({ length: 12 }, (_, index) => ({
        workspace_id: `w${index + 1}`,
        number: index + 1,
        // w12 sat within the chords until something above it closed.
        ...(index === 11 ? { tokens: { number: "12" } } : {}),
      })),
    },
  },
};

function stubHerdr(box: Sandbox, reportStatus = 0): void {
  const snapshot = box.write("snapshot.json", JSON.stringify(SNAPSHOT));
  box.stub(
    "herdr",
    [
      'case "$1 $2" in',
      `  "api snapshot") exec cat ${quote(snapshot)} ;;`,
      `  *" report-metadata") printf '%s\\n' "$*" >> ${quote(box.path("reported"))}; exit ${reportStatus} ;;`,
      "  *) exit 1 ;;",
      "esac",
    ].join("\n"),
  );
}

// A reported line reads `workspace report-metadata w1 --source … --token number=1`.
function reported(box: Sandbox): string[] {
  return box.read("reported").split("\n").filter(Boolean);
}

function lineFor(box: Sandbox, id: string): string {
  return reported(box).find((line) => line.includes(` ${id} `)) ?? "";
}

let box: Sandbox;

beforeEach(() => {
  box = sandbox("herdr-sidebar-numbers");
  stubHerdr(box);
});

afterEach(() => {
  box.remove();
});

describe("herdr-sidebar-numbers", () => {
  // launcherContract runs shellcheck, which has no shell to read in a bun
  // script. Its other two clauses still hold.
  test("is executable", () => {
    expect(statSync(script).mode & 0o111).not.toBe(0);
  });

  test("is reachable on PATH from a login shell", () => {
    expect(resolveOnPath("herdr", "herdr-sidebar-numbers")).toBe(realpathSync(script));
  });

  test("runs on the tab bar interval by the name PATH exports", () => {
    expect(readFileSync(config, "utf8")).toContain('command = "herdr-sidebar-numbers"');
  });

  // bun stays reachable for the shebang. herdr is what the case takes away.
  test("refuses when herdr does not answer", () => {
    const r = run([script], { onlyPath: [dirname(process.execPath), "/usr/bin", "/bin"] });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("could not read the herdr snapshot");
  });

  test("reports each space's position as the digit its chord uses", () => {
    const r = run([script], { path: [box.bin] });
    expect(r.status).toBe(0);
    expect(lineFor(box, "w1")).toContain("--token number=1");
    expect(lineFor(box, "w2")).toContain("--token number=2");
  });

  test("clears a space that has fallen past the ninth, since no chord reaches it", () => {
    run([script], { path: [box.bin] });
    expect(lineFor(box, "w12")).toContain("--clear-token number");
  });

  // Verified by keypress rather than derived: prefix+shift+1 against this shape
  // focuses the repo at array index 1, passing over the worktree at index 0.
  test("counts a repo's row above its worktrees, which is the order drawn", () => {
    const repo = { repo_key: "/r/.git", is_linked_worktree: false };
    const linked = { repo_key: "/r/.git", is_linked_worktree: true };
    box.write(
      "snapshot.json",
      JSON.stringify({
        result: {
          snapshot: {
            workspaces: [
              { workspace_id: "w1", worktree: linked },
              { workspace_id: "w2", worktree: repo },
              { workspace_id: "w3", worktree: linked },
              { workspace_id: "w4" },
            ],
          },
        },
      }),
    );

    run([script], { path: [box.bin] });
    expect(lineFor(box, "w2")).toContain("--token number=1");
    expect(lineFor(box, "w1")).toContain("--token number=2");
    expect(lineFor(box, "w3")).toContain("--token number=3");
    expect(lineFor(box, "w4")).toContain("--token number=4");
  });

  // A herdr call costs about 150ms, so reporting every row every run passes the
  // tab bar's timeout and the numbers never settle.
  test("says nothing about a row already showing the digit it wants", () => {
    box.write(
      "snapshot.json",
      JSON.stringify({
        result: { snapshot: { workspaces: [{ workspace_id: "w1", tokens: { number: "1" } }] } },
      }),
    );

    const r = run([script], { path: [box.bin] });
    expect(r.status).toBe(0);
    expect(reported(box)).toEqual([]);
  });

  // `.result.snapshot` missing is not a parse failure, so the JSON try/catch
  // never sees it and an unguarded read would crash a line later instead.
  test("refuses a snapshot carrying no workspaces", () => {
    box.write("snapshot.json", JSON.stringify({ result: {} }));

    const r = run([script], { path: [box.bin] });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("carried no workspaces");
  });

  // The tab bar logs a status command that exits non-zero. Exiting 0 on a failed
  // report would leave a row showing a digit that focuses somewhere else with
  // nothing anywhere saying so.
  test("exits non-zero when a row would not take its digit, having tried the rest", () => {
    stubHerdr(box, 1);

    const r = run([script], { path: [box.bin] });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("could not report");
    expect(lineFor(box, "w1")).toContain("--token number=1");
    expect(lineFor(box, "w12")).toContain("--clear-token number");
  });
});
