import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { run, sandbox, stubGum, type Sandbox, writeStub } from "#harness";

const script = join(import.meta.dir, "agent-prune");

let box: Sandbox;

beforeEach(() => {
  box = sandbox("agent-prune");
  stubGum(box);
  box.stub("open", `printf '%s\\n' "$2" >>"${box.path("todos")}"`);
  box.stub("scutil", "printf '%s\\n' Testbox");
  box.stub("ioreg", `printf '"IOPlatformUUID" = "%s"\\n' 0000-TEST`);
});

afterEach(() => box.remove());

function stubPruneAgents(body: string): void {
  writeStub(box.path("dotfiles/bin/claude-prune-agents"), body);
}

function prune() {
  return run([script], {
    path: [box.bin],
    env: {
      DOTFILES_HOME: box.path("dotfiles"),
      XDG_STATE_HOME: box.path("state"),
      THINGS_DATABASE: box.path("things.sqlite"),
    },
  });
}

test("removes stale agents without prompting and clears the latch", () => {
  stubPruneAgents(`printf 'args: %s\\n' "$*"`);
  const result = prune();
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("args: --force");
  expect(box.read("state/dotfiles/agent-prune.status")).toBe("ok\n");
  expect(box.read("todos")).toBe("");
});

test("files a to-do carrying both streams when the prune fails", () => {
  stubPruneAgents("echo listed; echo 'claude exploded' >&2; exit 2");
  expect(prune().status).toBe(1);
  const todo = decodeURIComponent(box.read("todos"));
  expect(todo).toContain("Nightly agent prune failed");
  expect(todo).toContain("listed");
  expect(todo).toContain("claude exploded");
});
