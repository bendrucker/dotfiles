import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { run, sandbox, stubGum, type Sandbox } from "#harness";
import type { Output } from "#jobs/output";
import { installClaudeHooks } from "./claude-hooks";

let box: Sandbox;
let logged: string[];

const out: Output = {
  write(_fd, text) {
    logged.push(text);
  },
  run(cmd, options) {
    const result = run(cmd, { env: options?.env, cwd: options?.cwd });
    logged.push(result.stdout, result.stderr);
    return result.status;
  },
  read(cmd, options) {
    const result = run(cmd, { env: options?.env, cwd: options?.cwd });
    logged.push(result.stderr);
    return { status: result.status, stdout: result.stdout };
  },
};

beforeEach(() => {
  box = sandbox("moshi-claude-hooks");
  stubGum(box);
  logged = [];
});

afterEach(() => {
  box.remove();
});

function env(): Record<string, string | undefined> {
  return { ...process.env, PATH: `${box.bin}:/usr/bin:/bin` };
}

describe("installClaudeHooks", () => {
  test("installs the claude target", () => {
    box.stub("moshi-hook", `printf '%s\\n' "$*" >>"${box.path("calls")}"`);

    expect(installClaudeHooks(out, env())).toBe(true);
    expect(box.read("calls")).toBe("install --target claude\n");
    expect(logged.join("")).toContain("Installing moshi claude hooks");
  });

  test("reports a failed install", () => {
    box.stub("moshi-hook", "exit 1");

    expect(installClaudeHooks(out, env())).toBe(false);
    expect(logged.join("")).toContain("moshi-hook install failed");
  });

  test("skips when moshi-hook is not on PATH", () => {
    expect(installClaudeHooks(out, env())).toBe(true);
    expect(logged.join("")).toBe("");
  });
});
