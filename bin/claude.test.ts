import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { repoRoot, run, sandbox, type Sandbox } from "#harness";

const bin = join(repoRoot, "bin");
const wrapper = join(bin, "claude");
const SYSTEM = ["/usr/bin", "/bin"];

// Reports what the wrapper handed it, so a case can read the environment and
// the arguments that reached the real binary.
const REAL_CLAUDE = `printf 'DEBUG_SDK=%s\\n' "\${DEBUG_SDK-unset}"
printf 'arg=%s\\n' "$@"`;

let box: Sandbox;

beforeEach(() => {
  box = sandbox("claude-wrapper");
  box.stub("claude", REAL_CLAUDE);
});

afterEach(() => box.remove());

function stubUname(system: string): string {
  box.stub("uname/uname", `echo ${system}`);
  return box.path("uname");
}

describe("claude wrapper", () => {
  test.each<{ name: string; system: string; debug: string | undefined; expected: string }>([
    { name: "turns the log on for macOS", system: "Darwin", debug: undefined, expected: "1" },
    { name: "keeps a caller's empty value", system: "Darwin", debug: "", expected: "" },
    { name: "leaves the log off outside macOS", system: "Linux", debug: undefined, expected: "unset" },
  ])("$name", ({ system, debug, expected }) => {
    const result = run([wrapper, "-p", "two words"], {
      onlyPath: [stubUname(system), bin, box.bin, ...SYSTEM],
      env: { DEBUG_SDK: debug },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`DEBUG_SDK=${expected}\narg=-p\narg=two words\n`);
  });

  test("skips itself when reached through a symlink", () => {
    const linked = box.mkdir("linked");
    symlinkSync(wrapper, join(linked, "claude"));

    const result = run([join(linked, "claude")], {
      onlyPath: [stubUname("Darwin"), linked, bin, box.bin, ...SYSTEM],
      env: { DEBUG_SDK: undefined },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("DEBUG_SDK=1\narg=\n");
  });

  test("fails when no other claude is on PATH", () => {
    const result = run([wrapper], { onlyPath: [stubUname("Darwin"), bin, ...SYSTEM] });

    expect(result.status).toBe(127);
    expect(result.stderr).toContain("no Claude Code binary on $PATH");
  });
});
