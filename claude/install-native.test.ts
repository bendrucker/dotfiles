import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { repoRoot, run, sandbox, type Sandbox } from "#harness";

const script = join(repoRoot, "claude", "install-native");
const SYSTEM = ["/usr/bin", "/bin"];

// What the real installer leaves behind: an executable at ~/.local/bin/claude.
const INSTALLER = `mkdir -p "$HOME/.local/bin"
printf '#!/bin/sh\\n' > "$HOME/.local/bin/claude"
chmod +x "$HOME/.local/bin/claude"`;

let box: Sandbox;
let home: string;

beforeEach(() => {
  box = sandbox("install-native");
  home = box.mkdir("home");
});

afterEach(() => box.remove());

function stubCurl(installer: string, status = 0): void {
  box.write("installer.sh", `${installer}\n`);
  box.stub("curl", `touch ${box.path("curl-ran")}\ncat ${box.path("installer.sh")}\nexit ${status}`);
}

function install() {
  return run([script], { onlyPath: [box.bin, ...SYSTEM], env: { HOME: home } });
}

describe("install-native", () => {
  test("installs when there is no native build", () => {
    stubCurl(INSTALLER);

    const result = install();

    expect(result.status).toBe(0);
    expect(box.read("home/.local/bin/claude")).toBe("#!/bin/sh\n");
  });

  test("does nothing when the native build is already there", () => {
    stubCurl(INSTALLER);
    box.stub("home/.local/bin/claude", "");

    const result = install();

    expect(result.status).toBe(0);
    expect(box.read("curl-ran")).toBe("");
  });

  test.each<{ name: string; installer: string; status: number }>([
    { name: "the download fails", installer: "", status: 22 },
    { name: "the installer exits nonzero", installer: "exit 3", status: 0 },
    { name: "the installer leaves no binary", installer: "true", status: 0 },
  ])("fails when $name", ({ installer, status }) => {
    stubCurl(installer, status);

    expect(install().status).not.toBe(0);
  });
});
