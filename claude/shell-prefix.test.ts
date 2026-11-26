import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { repoRoot, run, sandbox } from "#harness";

const box = sandbox("shell-prefix");
afterAll(() => box.remove());

box.stub("taskpolicy", 'shift 4\nexec "$@"');
const data = box.mkdir("mise");

function pathUnder(inherited: string[]): string[] {
  const r = run([join(repoRoot, "claude", "shell-prefix"), 'printf %s "$PATH"'], {
    env: { PATH: [box.bin, ...inherited].join(":"), MISE_DATA_DIR: data, CLAUDE_CODE_SHELL: "/bin/sh" },
  });
  expect(r.stderr).toBe("");
  return r.stdout.split(":");
}

describe("shell-prefix", () => {
  test.each<{ name: string; inherited: string[]; kept: string[] }>([
    {
      name: "replaces inherited mise install directories with the shims",
      inherited: [`${data}/installs/uv/1.0.0/bin`, "/usr/bin", `${data}/shims`, "/bin"],
      kept: ["/usr/bin", "/bin"],
    },
    {
      name: "keeps a directory holding a space whole",
      inherited: ["/Applications/Visual Studio Code.app/bin", "/usr/bin"],
      kept: ["/Applications/Visual Studio Code.app/bin", "/usr/bin"],
    },
  ])("$name", ({ inherited, kept }) => {
    expect(pathUnder(inherited)).toEqual([`${data}/shims`, box.bin, ...kept]);
  });
});
