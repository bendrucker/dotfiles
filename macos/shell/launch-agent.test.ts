import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { quote, repoRoot, type Sandbox, sandbox, shell, stubGum } from "#harness";

const lib = join(import.meta.dir, "launch-agent.sh");

function launchAgentPlan(...args: string[]) {
  return shell(`. ${quote(lib)}\nlaunch_agent_plan "$@"`, { args });
}

describe("launch_agent_plan", () => {
  test.each<{ unchanged: number; loaded: number; plan: string }>([
    { unchanged: 1, loaded: 1, plan: "skip" },
    { unchanged: 1, loaded: 0, plan: "bootstrap" },
    { unchanged: 0, loaded: 1, plan: "reinstall" },
    { unchanged: 0, loaded: 0, plan: "bootstrap" },
  ])("plans $plan when unchanged=$unchanged loaded=$loaded", ({ unchanged, loaded, plan }) => {
    const r = launchAgentPlan(String(unchanged), String(loaded));
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(plan);
  });

  // A held job is one whose process outlives installs, like the herdr server
  // that owns every pane. Loading it would start a second copy, and
  // reinstalling it would kill the first.
  test("never loads or reloads a held job", () => {
    const outcomes: string[] = [];
    for (const unchanged of ["0", "1"]) {
      for (const loaded of ["0", "1"]) {
        outcomes.push(launchAgentPlan(unchanged, loaded, "1").stdout.trim());
      }
    }
    expect(outcomes).not.toContain("bootstrap");
    expect(outcomes).not.toContain("reinstall");
  });

  test("skips a held job that is already current", () => {
    expect(launchAgentPlan("1", "1", "1").stdout.trim()).toBe("skip");
  });
});

describe("install_launch_agent", () => {
  let box: Sandbox;

  beforeEach(() => {
    box = sandbox("launch-agent");
    stubGum(box);
    // Nothing is loaded until a bootstrap succeeds.
    const log = box.path("launchctl.log");
    box.stub(
      "launchctl",
      `[ "$1" = print ] && { grep -q '^bootstrap' "${log}" 2>/dev/null; exit $?; }\necho "$*" >>"${log}"`,
    );
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
    const r = install("herdr/me.bendrucker.herdr.plist", "herdr server");
    expect(r.status).toBe(0);
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
