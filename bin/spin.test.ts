import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { repoRoot, run, sandbox, stubGum, type Run, type Sandbox } from "#harness";

// bin/spin is the command form of scripts/shell/spin.sh, for the TypeScript
// callers that cannot source it. These cover what the wrapper adds: that the
// arguments arrive as given and the command's status comes back out.

const script = join(repoRoot, "bin", "spin");

let box: Sandbox;

beforeEach(() => {
  box = sandbox("spin-bin");
  stubGum(box);
});

afterEach(() => {
  box.remove();
});

function runSpin(...args: string[]): Run {
  return run([script, ...args], { path: [box.bin] });
}

describe("bin/spin", () => {
  test("runs the command and passes its output through", () => {
    const r = runSpin("--title", "Working", "--", "printf", "ran\\n");
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("ran");
    expect(r.stderr).not.toBe("");
  });

  test("returns the command's status", () => {
    const r = runSpin("--title", "Pushing", "--", "false");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("Pushing");
  });

  // A caller that built an empty argument list would otherwise report a step
  // that never ran as done.
  test("refuses an empty command", () => {
    const r = runSpin("--title", "Syncing", "--");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("no command to run");
  });

  // A value carrying spaces has to arrive as one argument, or a title becomes
  // a command and the spinner runs the wrong thing.
  test("keeps a quoted argument whole", () => {
    const r = runSpin("--title", "Fetching origin/main (attempt 1/4)", "--", "printf", "%s\\n", "one two");
    expect(r.stdout.trim()).toBe("one two");
    expect(r.stderr).toContain("Fetching origin/main (attempt 1/4)");
  });
});
