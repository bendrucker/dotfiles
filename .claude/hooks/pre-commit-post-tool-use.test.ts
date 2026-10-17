import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { run, type Run, sandbox, type Sandbox } from "#harness";

const HOOK = join(import.meta.dir, "pre-commit-post-tool-use");

let box: Sandbox;

beforeEach(() => {
  box = sandbox("pre-commit-post-tool-use");
  box.write(".pre-commit-config.yaml", "repos: []\n");
  box.write("notes.md", "notes\n");
  box.stub("prek", ['shift 2', 'echo "$*" >> "$FIXTURES/calls"', 'echo "trailing whitespace...Failed"', 'exit "$(cat "$FIXTURES/status" 2>/dev/null || echo 0)"'].join("\n"));
});

afterEach(() => {
  box.remove();
});

function edit(input: unknown): Run {
  return run(["sh", "-c", `printf '%s' "$PAYLOAD" | ${JSON.stringify(HOOK)}`], {
    path: [box.bin],
    env: { PAYLOAD: JSON.stringify(input), FIXTURES: box.dir, CLAUDE_PROJECT_DIR: box.dir, CLAUDE_CODE_TMPDIR: box.path("cache") },
  });
}

describe("pre-commit-post-tool-use", () => {
  test("stays silent when the runner passes", () => {
    const outcome = edit({ tool_input: { file_path: box.path("notes.md") } });

    expect(outcome.status).toBe(0);
    expect(outcome.stdout).toBe("");
    expect(box.read("calls").trim()).toBe(box.path("notes.md"));
  });

  test("hands the runner's output back as context when it fails", () => {
    box.write("status", "1");

    const outcome = edit({ tool_input: { file_path: box.path("notes.md") } });

    expect(outcome.status).toBe(0);
    expect(JSON.parse(outcome.stdout).hookSpecificOutput).toEqual({
      hookEventName: "PostToolUse",
      additionalContext: `prek issues in ${box.path("notes.md")}:\n\ntrailing whitespace...Failed`,
    });
  });

  test.each([
    { name: "a payload with no file path", input: { tool_input: {} }, config: true },
    { name: "a payload that is not JSON", input: "not json", config: true },
    { name: "a project with no pre-commit config", input: { tool_input: { file_path: "notes.md" } }, config: false },
  ])("runs nothing for $name", ({ input, config }) => {
    if (!config) rmSync(box.path(".pre-commit-config.yaml"));

    const outcome = edit(input);

    expect(outcome.status).toBe(0);
    expect(outcome.stdout).toBe("");
    expect(box.read("calls")).toBe("");
  });
});
