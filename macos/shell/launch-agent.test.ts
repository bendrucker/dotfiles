import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { quote, repoRoot, type Sandbox, sandbox, shell, stubGum } from "#harness";

const lib = join(import.meta.dir, "launch-agent.sh");

function launchAgentPlan(...args: string[]) {
  return shell(`. ${quote(lib)}\nlaunch_agent_plan "$@"`, { args });
}

describe("launch_agent_plan", () => {
  describe("for every combination of inputs", () => {
    test.each<{ unchanged: number; loaded: number; is_self: number; plan: string }>([
      { unchanged: 1, loaded: 1, is_self: 0, plan: "skip" },
      { unchanged: 1, loaded: 1, is_self: 1, plan: "skip" },
      { unchanged: 1, loaded: 0, is_self: 0, plan: "bootstrap" },
      { unchanged: 1, loaded: 0, is_self: 1, plan: "bootstrap" },
      { unchanged: 0, loaded: 1, is_self: 0, plan: "reinstall" },
      { unchanged: 0, loaded: 1, is_self: 1, plan: "defer" },
      { unchanged: 0, loaded: 0, is_self: 0, plan: "bootstrap" },
      { unchanged: 0, loaded: 0, is_self: 1, plan: "bootstrap" },
    ])(
      "plans $plan when unchanged=$unchanged loaded=$loaded is_self=$is_self",
      ({ unchanged, loaded, is_self, plan }) => {
        const r = launchAgentPlan(String(unchanged), String(loaded), String(is_self));
        expect(r.status).toBe(0);
        expect(r.stdout.trim()).toBe(plan);
      },
    );
  });

  test("never boots out the job this process runs under", () => {
    const outcomes: string[] = [];
    for (const unchanged of ["0", "1"]) {
      for (const loaded of ["0", "1"]) {
        outcomes.push(launchAgentPlan(unchanged, loaded, "1").stdout.trim());
      }
    }
    expect(outcomes).not.toContain("reinstall");
  });

  test("reloads a job whose plist is installed but unloaded", () => {
    const r = launchAgentPlan("1", "0", "0");
    expect(r.stdout.trim()).toBe("bootstrap");
  });

  // A held job is one whose process outlives installs, like the herdr server
  // that owns every pane. Loading it would start a second copy, and
  // reinstalling it would kill the first.
  test("never loads or reloads a held job", () => {
    const outcomes: string[] = [];
    for (const unchanged of ["0", "1"]) {
      for (const loaded of ["0", "1"]) {
        for (const is_self of ["0", "1"]) {
          outcomes.push(launchAgentPlan(unchanged, loaded, is_self, "1").stdout.trim());
        }
      }
    }
    expect(outcomes).not.toContain("bootstrap");
    expect(outcomes).not.toContain("reinstall");
  });

  test("skips a held job that is already current", () => {
    expect(launchAgentPlan("1", "1", "0", "1").stdout.trim()).toBe("skip");
  });
});

describe("install_launch_agent", () => {
  let box: Sandbox;

  beforeEach(() => {
    box = sandbox("launch-agent");
    stubGum(box);
    // Nothing is loaded, and every call is logged for the test to read back.
    box.stub("launchctl", `echo "$*" >>"${box.path("launchctl.log")}"\n[ "$1" = print ] && exit 1\nexit 0`);
  });

  afterEach(() => box.remove());

  function install(...args: string[]) {
    return shell(`. ${quote(lib)}\ninstall_launch_agent "$@"`, {
      args,
      path: [box.bin],
      env: { HOME: box.dir, ZSH: repoRoot },
    });
  }

  const herdrPlist = "Library/LaunchAgents/me.bendrucker.herdr.plist";

  test("installs a plist a topic keeps under its own directory", () => {
    install("herdr/me.bendrucker.herdr.plist", "herdr server");
    const plist = box.read(herdrPlist);
    expect(plist).toContain("<string>me.bendrucker.herdr</string>");
    expect(plist).not.toContain("__HOME__");
    expect(box.read("launchctl.log")).toContain(`bootstrap gui/`);
  });

  test("writes a held plist without loading it", () => {
    const r = install("herdr/me.bendrucker.herdr.plist", "herdr server", "1");
    expect(r.status).toBe(0);
    expect(box.read(herdrPlist)).toContain("<string>me.bendrucker.herdr</string>");
    expect(box.read("launchctl.log")).not.toMatch(/bootstrap|bootout/);
  });
});
