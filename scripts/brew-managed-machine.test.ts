import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot, run, sandbox, type Sandbox } from "#harness";

const script = join(repoRoot, "scripts", "brew-managed-machine");

let box: Sandbox;

beforeEach(() => {
  box = sandbox("brew-managed-machine");
});

afterEach(() => {
  box.remove();
});

function managed(dir: string, options: { platform?: string } = {}) {
  box.stub("uname", `echo ${options.platform ?? "Darwin"}`);
  return run([script, dir], { path: [box.bin] });
}

describe("brew-managed-machine", () => {
  test("a directory holding configuration profiles is managed", () => {
    const dir = box.mkdir("managed");
    box.write("managed/com.example.plist", "");

    expect(managed(dir).status).toBe(0);
  });

  test("an empty directory is not", () => {
    expect(managed(box.mkdir("managed")).status).toBe(1);
  });

  test("a directory that is not there is not", () => {
    expect(managed(box.path("absent")).status).toBe(1);
  });

  test("a machine that is not a Mac is not", () => {
    const dir = box.mkdir("managed");
    box.write("managed/com.example.plist", "");

    expect(managed(dir, { platform: "Linux" }).status).toBe(1);
  });

  test("a directory that cannot be listed is managed, and says so", () => {
    const dir = box.mkdir("managed");
    box.write("managed/com.example.plist", "");
    chmodSync(dir, 0o000);

    const listable = run(["ls", "-A", dir]).status === 0;
    const result = managed(dir);
    chmodSync(dir, 0o755);

    // root lists a directory whatever its mode, so a test runner that is root
    // sees the ordinary managed answer instead.
    expect(result.status).toBe(0);
    if (!listable) expect(result.stderr).toContain("cannot list");
  });

  test("its default path is the one the Brewfile tests", () => {
    const source = readFileSync(script, "utf8");
    const brewfile = readFileSync(join(repoRoot, "Brewfile"), "utf8");
    const path = "/Library/Managed Preferences";

    expect(source).toContain(`\${1:-${path}}`);
    expect(brewfile).toContain(`Dir.exist?('${path}')`);
    expect(brewfile).toContain(`Dir.empty?('${path}')`);
  });
});
