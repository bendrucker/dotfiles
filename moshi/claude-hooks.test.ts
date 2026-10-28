import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { fakeIo, sandbox, type Sandbox } from "#harness";
import { installClaudeHooks } from "./claude-hooks";

let box: Sandbox;

beforeEach(() => {
  box = sandbox("moshi-claude-hooks");
});

afterEach(() => {
  box.remove();
});

function env(): Record<string, string | undefined> {
  return { ...process.env, PATH: `${box.bin}:/usr/bin:/bin` };
}

describe("installClaudeHooks", () => {
  test("installs the claude target", () => {
    box.stub("moshi-hook", "exit 0");
    const io = fakeIo({ answers: [{ argv: ["moshi-hook"] }] });

    expect(installClaudeHooks(io, env())).toBe(true);
    expect(io.calls.map((call) => call.argv)).toEqual([["moshi-hook", "install", "--target", "claude"]]);
    expect(io.calls[0].options?.stdin).toBe("ignore");
    expect(io.logs).toEqual([{ level: "info", message: "Installing moshi claude hooks..." }]);
  });

  test("reports a failed install", () => {
    box.stub("moshi-hook", "exit 0");
    const io = fakeIo({ answers: [{ argv: ["moshi-hook"], status: 1 }] });

    expect(installClaudeHooks(io, env())).toBe(false);
    expect(io.logs.at(-1)).toEqual({ level: "warn", message: "moshi-hook install failed" });
  });

  test("skips when moshi-hook is not on PATH", () => {
    const io = fakeIo();

    expect(installClaudeHooks(io, env())).toBe(true);
    expect(io.calls).toEqual([]);
    expect(io.captured()).toBe("");
  });
});
