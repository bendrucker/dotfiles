import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot, run, sandbox, type Sandbox } from "#harness";

const script = join(repoRoot, "scripts", "trace-run");

let box: Sandbox;
let dir: string;

beforeEach(() => {
  box = sandbox("trace-run");
  dir = box.mkdir("trace");
});

afterEach(() => {
  box.remove();
});

function traceRun(args: string[], traced = true) {
  return run(["bun", script, ...args], { env: { DOTFILES_TRACE_DIR: traced ? dir : undefined } });
}

describe("trace-run", () => {
  test("passes output through and exits with the command's status", () => {
    const r = traceRun(["--", "sh", "-c", "echo out; echo err >&2; exit 3"]);
    expect(r.status).toBe(3);
    expect(r.stdout).toBe("out\n");
    expect(r.stderr).toBe("err\n");
  });

  test("timestamps each line into one file under lines/", () => {
    traceRun(["--", "sh", "-c", "echo one; echo two >&2; printf partial"]);
    const [file] = readdirSync(join(dir, "lines"));
    const rows = readFileSync(join(dir, "lines", file ?? ""), "utf8").trim().split("\n").map((row) => row.split("\t"));
    expect(rows.map(([, fd, text]) => [fd, text]).sort()).toEqual([
      ["1", "one"],
      ["1", "partial"],
      ["2", "two"],
    ]);
    for (const [ns] of rows) expect(ns).toMatch(/^\d{19}$/);
  });

  test("brackets the command with B and E events under its own pid", () => {
    traceRun(["--name", "herdr update", "--", "sh", "-c", "exit 5"]);
    const events = readFileSync(join(dir, "events.tsv"), "utf8").split("\n").filter(Boolean).map((row) => row.split("\t"));
    expect(events.map(([kind, , , status, name]) => [kind, status, name])).toEqual([
      ["B", "0", "herdr update"],
      ["E", "5", ""],
    ]);
    expect(events[0]?.[2]).toBe(events[1]?.[2]);
  });

  test("only runs the command when tracing is off", () => {
    const r = traceRun(["--", "sh", "-c", "echo out"], false);
    expect(r.stdout).toBe("out\n");
    expect(readdirSync(dir)).toEqual([]);
  });

  test("reports a missing command as 127", () => {
    const r = traceRun(["--", "no-such-command-anywhere"]);
    expect(r.status).toBe(127);
    expect(r.stderr).toContain("no-such-command-anywhere");
  });

  test("refuses a call with no command", () => {
    expect(traceRun(["--"]).status).toBe(2);
  });
});
