import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { sandbox, stubGum, type Sandbox } from "#harness";
import { call } from "#harness/call";

let box: Sandbox;

beforeEach(() => {
  box = sandbox("moshi-claude-hooks");
  stubGum(box);
});

afterEach(() => {
  box.remove();
});

function env(): Record<string, string | undefined> {
  return { ...process.env, PATH: `${box.bin}:/usr/bin:/bin` };
}

// Called in a child bun, since what Bun Shell writes never reaches this process's spies.
function install() {
  return call<boolean>(join(import.meta.dir, "claude-hooks.ts"), "installClaudeHooks", [env()], env());
}

describe("installClaudeHooks", () => {
  test("installs the claude target", async () => {
    box.stub("moshi-hook", `printf '%s\\n' "$*" >>"${box.path("calls")}"`);

    const { value, output } = await install();

    expect(value).toBe(true);
    expect(box.read("calls")).toBe("install --target claude\n");
    expect(output).toContain("Installing moshi claude hooks");
  });

  test("reports a failed install", async () => {
    box.stub("moshi-hook", "exit 1");

    const { value, output } = await install();

    expect(value).toBe(false);
    expect(output).toContain("moshi-hook install failed");
  });

  test("skips when moshi-hook is not on PATH", async () => {
    const { value, output } = await install();

    expect(value).toBe(true);
    expect(output).toBe("");
  });
});
