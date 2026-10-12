import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { repoRoot, run, sandbox, type Run, type Sandbox } from "#harness";

let box: Sandbox;

beforeEach(() => {
  box = sandbox("dotfiles-reload");
  box.stub("mise", 'echo "$PWD $*" >> "$MISE_LOG"\nexit "${MISE_EXIT:-0}"');
});

afterEach(() => {
  box.remove();
});

function reload(env: Record<string, string> = {}): Run {
  return run([join(repoRoot, "bin", "dotfiles-reload")], {
    path: [box.bin],
    env: { XDG_CONFIG_HOME: box.path("config"), MISE_LOG: box.path("mise.log"), ...env },
  });
}

describe("dotfiles-reload", () => {
  test("does nothing before conf.d is linked", () => {
    const r = reload();
    expect(r.status).toBe(0);
    expect(box.read("mise.log")).toBe("");
  });

  test.each([
    { name: "every reload succeeds", exit: 0 },
    { name: "a reload fails", exit: 1 },
  ])("runs every reload task from / and exits with mise when $name", ({ exit }) => {
    box.mkdir("config", "mise", "conf.d");
    const r = reload({ MISE_EXIT: String(exit) });
    expect(r.status).toBe(exit);
    expect(box.read("mise.log")).toBe("/ run --continue-on-error *:reload\n");
  });
});
