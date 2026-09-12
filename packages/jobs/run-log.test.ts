import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordRun, resetRuns, runCount, runLogPath } from "#jobs/run-log";

let sandbox: string;
const state = process.env.XDG_STATE_HOME;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "jobs-run-log-"));
  process.env.XDG_STATE_HOME = join(sandbox, "state");
});

afterEach(() => {
  if (state === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = state;
  rmSync(sandbox, { recursive: true, force: true });
});

function record(output: string, at = "2026-09-11 03:00:04 PDT"): number {
  return recordRun("dotfiles-sync", "9f8e7d6c5b4a", { at, output });
}

test("counts the run it just recorded", () => {
  expect(record("first")).toBe(1);
  expect(record("second")).toBe(2);
  expect(record("third")).toBe(3);
});

test("keeps every run, which is what survives a note that cannot grow", () => {
  record("first", "monday");
  record("second", "tuesday");

  const log = readFileSync(runLogPath("dotfiles-sync", "9f8e7d6c5b4a"), "utf8");
  expect(log).toContain("=== run monday ===\nfirst");
  expect(log).toContain("=== run tuesday ===\nsecond");
});

// Escalation to Today fires on the third run of the standing to-do. A count that
// kept climbing past a to-do Ben finished would walk straight past the threshold
// and never escalate again.
test("counts from one again for the to-do that replaces a finished one", () => {
  record("first");
  record("second");

  resetRuns("dotfiles-sync", "9f8e7d6c5b4a");

  expect(record("third")).toBe(2);
});

test("keeps the archive whole across a reset", () => {
  record("first", "monday");
  resetRuns("dotfiles-sync", "9f8e7d6c5b4a");
  record("second", "tuesday");

  const log = readFileSync(runLogPath("dotfiles-sync", "9f8e7d6c5b4a"), "utf8");
  expect(log).toContain("=== run monday ===\nfirst");
  expect(log).toContain("=== run tuesday ===\nsecond");
});

test("separates the causes of one job", () => {
  recordRun("dotfiles-sync", "aaaa", { at: "monday", output: "one" });
  expect(runCount("dotfiles-sync", "bbbb")).toBe(1);
});

// A count of 1 files a to-do rather than appending to one, so a log this run
// could not write costs a duplicate instead of losing the run.
test("reads an unwritable log as a first run", () => {
  process.env.XDG_STATE_HOME = "/dev/null/nowhere";
  expect(record("first")).toBe(1);
  expect(runCount("dotfiles-sync", "9f8e7d6c5b4a")).toBe(1);
});
