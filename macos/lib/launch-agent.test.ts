import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { quote, shell } from "../../scripts/lib/shell-fixtures.ts";

const lib = join(import.meta.dir, "launch-agent.sh");

function launchAgentPlan(...args: string[]) {
  return shell(`. ${quote(lib)}\nlaunch_agent_plan "$@"`, { args });
}

describe("launch_agent_plan", () => {
  describe("for every combination of inputs", () => {
    // unchanged loaded is_self  plan
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
});
