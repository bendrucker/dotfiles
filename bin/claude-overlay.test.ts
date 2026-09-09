import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { repoRoot, run, sandbox, type Run, type Sandbox } from "#harness";

// The linker lives in the claude repo, which this repo installs but does not
// version. These tests cover what a checkout missing the overlay plugin does,
// and that a checkout holding one still reaches it with the arguments intact.

const script = join(repoRoot, "bin", "claude-overlay");

let box: Sandbox;

beforeEach(() => {
  box = sandbox("claude-overlay");
});

afterEach(() => {
  box.remove();
});

function runOverlay(repo: string, ...args: string[]): Run {
  return run([script, ...args], { path: [box.bin], env: { CLAUDE_REPO_HOME: repo } });
}

function stubBun(): void {
  box.stub("bun", 'printf "%s\\n" "$@"');
}

describe("bin/claude-overlay", () => {
  test("passes the target through to the linker", () => {
    stubBun();
    const repo = box.mkdir("claude-repo");
    box.write("claude-repo/plugins/overlay/scripts/link.ts", "");

    const r = runOverlay(repo, "link", "/checkout");

    expect(r.status).toBe(0);
    expect(r.stdout.trim().split("\n")).toEqual([
      join(repo, "plugins/overlay/scripts/link.ts"),
      "link",
      "/checkout",
    ]);
  });

  // A checkout without the overlay plugin still has to work, so this leaves
  // the caller's output alone rather than reporting a module bun could not
  // find.
  test("exits quietly when the claude repo has no linker", () => {
    stubBun();
    const r = runOverlay(box.mkdir("claude-repo"), "link", "/checkout");

    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
  });

  test("reports what the linker itself failed on", () => {
    box.stub("bun", 'echo "link failed" >&2; exit 3');
    const repo = box.mkdir("claude-repo");
    box.write("claude-repo/plugins/overlay/scripts/link.ts", "");

    const r = runOverlay(repo, "link", "/checkout");

    expect(r.status).toBe(3);
    expect(r.stderr).toContain("link failed");
  });
});
