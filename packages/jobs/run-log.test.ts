import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordRun, runCount, runLogPath } from "#jobs/run-log";

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
