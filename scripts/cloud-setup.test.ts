import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { repoRoot, run, sandbox, type Sandbox } from "#harness";

const script = join(repoRoot, "scripts", "cloud-setup");

let box: Sandbox;
let tools: string;

beforeEach(() => {
  box = sandbox("cloud-setup");
  box.write("dotfiles/system/mise.toml", "");
  tools = box.mkdir("installs", "prek", "bin");
  chmodSync(box.write("installs/prek/bin/prek", ""), 0o755);
});

afterEach(() => {
  box.remove();
});

function setup(installStatus = 0) {
  box.stub(
    "mise",
    `case "$1" in install) exit ${installStatus} ;; bin-paths) echo ${tools} ;; esac`,
  );
  return run(["sh", script], {
    path: [box.bin],
    env: { CLOUD_SETUP_DIR: box.path("dotfiles"), CLOUD_SETUP_BIN: box.mkdir("out") },
  });
}

describe("cloud-setup", () => {
  test("links every pinned tool onto PATH", () => {
    expect(setup().status).toBe(0);
    expect(readlinkSync(box.path("out", "prek"))).toBe(join(tools, "prek"));
  });

  test("warns and exits 0 when the install fails, so the session still starts", () => {
    const result = setup(1);

    expect(result).toMatchObject({ status: 0, stderr: "cloud-setup: mise install failed\n" });
    expect(box.read("out/prek")).toBe("");
  });
});
