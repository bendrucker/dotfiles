import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync } from "node:fs";
import { join, relative } from "node:path";
import { repoRoot, run, sandbox, type Sandbox } from "#harness";

const script = join(repoRoot, "scripts", "mise-shim-shadows");

let box: Sandbox;
let data: string;
let brew: string;
let active: string;

beforeEach(() => {
  box = sandbox("mise-shim-shadows");
  data = box.mkdir("mise");
  brew = box.mkdir("homebrew", "bin");
  active = box.mkdir("mise", "installs", "jq", "1.8", "bin");
  box.mkdir("mise", "shims");
});

afterEach(() => {
  box.remove();
});

// A plain file rather than a harness stub, whose launcher leaves a .stubs
// directory beside it that would read as one more command.
function executable(path: string): void {
  chmodSync(box.write(relative(box.dir, path), ""), 0o755);
}

function shim(name: string): void {
  executable(join(data, "shims", name));
}

function check(options: { binPaths?: string; path?: string[] } = {}) {
  box.stub("mise", options.binPaths ?? `echo ${active}`);
  return run([process.execPath, script], {
    onlyPath: options.path ?? [box.bin, join(data, "shims"), brew],
    env: { MISE_DATA_DIR: data, HOME: box.dir },
  });
}

describe("mise-shim-shadows", () => {
  test("is silent when every shim runs a globally active tool", () => {
    shim("jq");
    executable(join(active, "jq"));
    executable(join(brew, "jq"));

    const result = check();

    expect(result).toMatchObject({ status: 0, stdout: "" });
  });

  test("names a shim with no active version that shadows a later copy", () => {
    shim("bun");
    executable(join(brew, "bun"));

    const result = check();

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`bun  ${join(brew, "bun")}\n`);
  });

  test("ignores a shim with nothing behind it", () => {
    shim("orphan");

    expect(check()).toMatchObject({ status: 0, stdout: "" });
  });

  test("does not count a project's install directory as the copy behind a shim", () => {
    shim("bun");
    const project = box.mkdir("mise", "installs", "bun", "1.3.14", "bin");
    executable(join(project, "bun"));

    const result = check({ path: [box.bin, project, join(data, "shims"), brew] });

    expect(result).toMatchObject({ status: 0, stdout: "" });
  });

  test("fails when mise cannot list the active tools", () => {
    shim("bun");
    executable(join(brew, "bun"));

    const result = check({ binPaths: "exit 1" });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("mise bin-paths failed");
  });
});
