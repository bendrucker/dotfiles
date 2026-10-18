import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, readdirSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { repoRoot, run, sandbox, type Sandbox } from "#harness";

const script = join(repoRoot, "scripts", "vm-setup");

let box: Sandbox;
let tools: string;
let out: string;

beforeEach(() => {
  box = sandbox("vm-setup");
  box.write("dotfiles/system/mise.toml", "");
  box.mkdir("claude-repo");
  box.stub("dotfiles/claude/link", `echo "$CLAUDE_REPO_HOME $*" > ${box.path("linked")}`);
  tools = box.mkdir("installs", "prek", "bin");
  chmodSync(box.write("installs/prek/bin/prek", ""), 0o755);
  box.mkdir("installs", "prek", "bin", "share");
  out = box.mkdir("out");
});

afterEach(() => {
  box.remove();
});

function mise(installStatus = 0): string {
  return `case "$1" in install) exit ${installStatus} ;; bin-paths) echo ${tools} ;; esac`;
}

// Only the sandbox and the system directories, so a mise installed on the
// machine running the tests never resolves.
function setup() {
  return run(["sh", script], {
    onlyPath: [box.bin, "/usr/bin", "/bin"],
    env: { VM_SETUP_DIR: box.path("dotfiles"), VM_SETUP_BIN: out, CLAUDE_REPO_HOME: box.path("claude-repo") },
  });
}

describe("vm-setup", () => {
  test("links every pinned tool onto PATH, and no directory beside one", () => {
    box.stub("mise", mise());

    expect(setup().status).toBe(0);
    expect(readdirSync(out)).toEqual(["prek"]);
    expect(readlinkSync(join(out, "prek"))).toBe(join(tools, "prek"));
  });

  test("installs with the remote module selected", () => {
    box.stub("mise", `[ "$1" = install ] && echo "$MISE_ENV" > ${box.path("env")}\n${mise()}`);

    expect(setup().status).toBe(0);
    expect(box.read("env")).toBe("remote\n");
  });

  test("links the Claude config from the clone for remote", () => {
    box.stub("mise", mise());

    expect(setup().status).toBe(0);
    expect(box.read("linked")).toBe(`${box.path("claude-repo")} remote\n`);
  });

  test("installs mise into the bin directory when it is missing", () => {
    // The installer mise.run serves, reduced to writing a mise stub where it is told.
    box.stub("curl", `cat <<'EOF'\nprintf '%s\\n' '${mise()}' > "$MISE_INSTALL_PATH"\nchmod +x "$MISE_INSTALL_PATH"\nEOF`);

    expect(setup().status).toBe(0);
    expect(readlinkSync(join(out, "prek"))).toBe(join(tools, "prek"));
  });

  test("warns and exits 0 when the install fails, so the VM still boots", () => {
    box.stub("mise", mise(1));

    const result = setup();

    expect(result).toMatchObject({ status: 0, stderr: "vm-setup: mise install failed\n" });
    expect(box.read("out/prek")).toBe("");
  });
});
