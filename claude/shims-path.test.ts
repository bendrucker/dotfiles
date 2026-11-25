import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { repoRoot, run, sandbox } from "#harness";

const box = sandbox("shims-path");
afterAll(() => box.remove());

const data = box.mkdir("mise");
const script = join(repoRoot, "claude", "shims-path.sh");

describe("shims-path.sh", () => {
  test.each(["/bin/sh", "zsh"])("replaces mise install directories with the shims under %s", (shell) => {
    const inherited = [
      `${data}/installs/uv/0.13.6/bin`,
      "/Applications/Visual Studio Code.app/bin",
      `${data}/shims`,
      "/usr/bin",
      "/bin",
    ];
    const r = run([shell, "-c", `. '${script}'; printf %s "$PATH"`], {
      env: { PATH: inherited.join(":"), MISE_DATA_DIR: data, ZDOTDIR: box.mkdir("empty") },
    });
    expect(r.stderr).toBe("");
    expect(r.stdout.split(":")).toEqual([
      `${data}/shims`,
      "/Applications/Visual Studio Code.app/bin",
      "/usr/bin",
      "/bin",
    ]);
  });
});
