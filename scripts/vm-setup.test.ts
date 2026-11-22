import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, readdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { repoRoot, run, sandbox, type Sandbox } from "#harness";
import { recorded, recordingStub } from "#harness/recorder";

const script = join(repoRoot, "scripts", "vm-setup");

let box: Sandbox;
let tools: string;
let out: string;

beforeEach(() => {
  box = sandbox("vm-setup");
  box.write("dotfiles/system/mise.toml", "");
  box.write("dotfiles/claude/mise.macos.toml", "");
  box.mkdir("claude-repo");
  box.stub("dotfiles/claude/link", `echo "$CLAUDE_REPO_HOME $*" > ${box.path("linked")}`);
  box.write("dotfiles/vale/vale.ini", "");
  box.stub("vale", `echo "$*" > ${box.path("vale-args")}`);
  tools = box.mkdir("installs", "prek", "bin");
  chmodSync(box.write("installs/prek/bin/prek", ""), 0o755);
  box.mkdir("installs", "prek", "bin", "share");
  out = box.mkdir("out");
  for (const cmd of ["rsync", "bwrap", "socat"]) box.stub(`packages/${cmd}`, "");
  recordingStub(box, "apt-get");
});

afterEach(() => {
  box.remove();
});

function mise(installStatus = 0): string {
  return `case "$1" in install) exit ${installStatus} ;; bin-paths) echo ${tools} ;; esac`;
}

// The system directories without the commands named, so a test sees them
// missing whatever the machine running it has installed.
function systemWithout(...names: string[]): string {
  const system = box.mkdir("system");
  const linked = new Set(names);
  for (const dir of ["/usr/bin", "/bin"]) {
    for (const entry of readdirSync(dir)) {
      if (linked.has(entry)) continue;
      linked.add(entry);
      symlinkSync(join(dir, entry), join(system, entry));
    }
  }
  return system;
}

const packageCommands = ["rsync", "bwrap", "socat"];
const install = ["apt-get", "install", "-y", "--no-install-recommends", "rsync", "bubblewrap", "socat"];

// Only the sandbox and the system directories, so a mise installed on the
// machine running the tests never resolves.
function setup(path = [box.bin, box.path("packages"), "/usr/bin", "/bin"]) {
  return run(["sh", script], {
    onlyPath: path,
    env: {
      VM_SETUP_DIR: box.path("dotfiles"),
      VM_SETUP_BIN: out,
      CLAUDE_REPO_HOME: box.path("claude-repo"),
      XDG_CONFIG_HOME: box.path("config"),
    },
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

  test("links the vale config and syncs its packages", () => {
    box.stub("mise", mise());

    expect(setup().status).toBe(0);
    const config = box.path("config", "vale", ".vale.ini");
    expect(readlinkSync(config)).toBe(box.path("dotfiles", "vale", "vale.ini"));
    expect(box.read("vale-args")).toBe(`sync --config ${config}\n`);
  });

  test("installs mise into the bin directory when it is missing", () => {
    // The installer mise.run serves, reduced to writing a mise stub where it is told.
    box.stub("curl", `while [ "$1" != -o ]; do shift; done\ncat > "$2" <<'EOF'\nprintf '%s\\n' '${mise()}' > "$MISE_INSTALL_PATH"\nchmod +x "$MISE_INSTALL_PATH"\nEOF`);

    expect(setup().status).toBe(0);
    expect(readlinkSync(join(out, "prek"))).toBe(join(tools, "prek"));
  });

  test("warns and exits 0 when the install fails, so the VM still boots", () => {
    box.stub("mise", mise(1));

    const result = setup();

    expect(result).toMatchObject({ status: 0, stderr: "vm-setup: mise install failed\n" });
    expect(box.read("out/prek")).toBe("");
  });

  test("skips the packages when their commands already resolve", () => {
    box.stub("mise", mise());

    expect(setup().status).toBe(0);
    expect(box.read("calls.log")).toBe("");
  });

  test("installs the packages when a command is missing", () => {
    box.stub("mise", mise());

    expect(setup([box.bin, systemWithout(...packageCommands, "apt-get")]).status).toBe(0);
    expect(recorded(box)).toEqual([install]);
  });

  test("updates the package index when the first install fails", () => {
    box.stub("mise", mise());
    recordingStub(box, "apt-get", `[ "$1" = update ] && touch ${box.path("updated")}\n[ "$1" = update ] || [ -e ${box.path("updated")} ]`);

    expect(setup([box.bin, systemWithout(...packageCommands, "apt-get")]).status).toBe(0);
    expect(recorded(box)).toEqual([install, ["apt-get", "update"], install]);
  });

  test("warns and carries on when the packages cannot be installed", () => {
    box.stub("mise", mise());
    recordingStub(box, "apt-get", "exit 1");

    const result = setup([box.bin, systemWithout(...packageCommands, "apt-get")]);

    expect(result).toMatchObject({ status: 0, stderr: "vm-setup: package install failed\n" });
    expect(readlinkSync(join(out, "prek"))).toBe(join(tools, "prek"));
  });

  test("skips the packages quietly without apt-get", () => {
    box.stub("mise", mise());
    rmSync(join(box.bin, "apt-get"));

    const result = setup([box.bin, systemWithout(...packageCommands, "apt-get")]);

    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(readlinkSync(join(out, "prek"))).toBe(join(tools, "prek"));
  });
});
