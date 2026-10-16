import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { utimesSync } from "node:fs";
import { join } from "node:path";
import { run, type Run, sandbox, type Sandbox } from "#harness";

const HOOK = join(import.meta.dir, "pre-commit-stop");
const SESSION = "session-1";

let box: Sandbox;

beforeEach(() => {
  box = sandbox("pre-commit-stop");
  box.write(".pre-commit-config.yaml", "repos: []\n");
  box.write("notes.md", "notes\n");
  box.write("transcript.jsonl", `${edit(box.path("notes.md"))}\n`);
  // Each call appends the files it was handed, and exits with the status the
  // case wrote, so a case can fail a Stop and then let the next one pass.
  box.stub("prek", ['shift 2', 'echo "$*" >> "$FIXTURES/calls"', 'exit "$(cat "$FIXTURES/status" 2>/dev/null || echo 0)"'].join("\n"));
});

afterEach(() => {
  box.remove();
});

function edit(path: string): string {
  return JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: path } }] } });
}

function stop(session: string = SESSION): Run {
  const payload = JSON.stringify({ transcript_path: box.path("transcript.jsonl"), cwd: box.dir, session_id: session });
  return run(["sh", "-c", `printf '%s' "$PAYLOAD" | ${JSON.stringify(HOOK)}`], {
    path: [box.bin],
    env: { PAYLOAD: payload, FIXTURES: box.dir, CLAUDE_PROJECT_DIR: box.dir, CLAUDE_CODE_TMPDIR: box.path("cache") },
  });
}

function calls(): string[] {
  return box.read("calls").split("\n").filter(Boolean);
}

// Ahead of any stamp the Stop before it could have written.
function touchLater(name: string): void {
  const later = Date.now() / 1000 + 60;
  utimesSync(box.path(name), later, later);
}

describe("pre-commit-stop", () => {
  test("runs one pass when the first finds nothing", () => {
    const outcome = stop();

    expect(outcome.status).toBe(0);
    expect(outcome.stdout).toBe("");
    expect(calls()).toEqual([box.path("notes.md")]);
  });

  test("blocks with the second pass when the first fails", () => {
    box.write("status", "1");

    const outcome = stop();

    expect(outcome.status).toBe(0);
    expect(JSON.parse(outcome.stdout).decision).toBe("block");
    expect(calls()).toHaveLength(2);
  });

  test("skips a file unchanged since a passing Stop", () => {
    stop();
    stop();

    expect(calls()).toHaveLength(1);
  });

  test("rechecks a file edited after a passing Stop", () => {
    stop();
    touchLater("notes.md");
    stop();

    expect(calls()).toHaveLength(2);
  });

  test("rechecks a file a blocked Stop left failing", () => {
    box.write("status", "1");
    stop();
    box.write("status", "0");
    stop();

    expect(calls()).toEqual([box.path("notes.md"), box.path("notes.md"), box.path("notes.md")]);
  });

  // The stamp is named for the session, so an id that is not a plain filename
  // could otherwise name a path outside the cache.
  test("keeps no stamp for a session id that is not a filename", () => {
    stop("../escape");
    stop("../escape");

    expect(calls()).toHaveLength(2);
    expect(box.read("escape")).toBe("");
  });
});
