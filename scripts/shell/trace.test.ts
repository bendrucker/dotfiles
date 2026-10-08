import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { quote, repoRoot, run, sandbox, type RunOptions, type Sandbox } from "#harness";

const lib = join(repoRoot, "scripts", "shell", "trace.sh");

// scripts/bootstrap is bash, bin/dotf and scripts/install-topics are sh (dash
// on Ubuntu), and scripts/install is zsh, so every case runs under each.
const shells = ["sh", "bash", "zsh"].map((name) => [name, Bun.which(name) ?? name] as const);

let box: Sandbox;
let dir: string;

beforeEach(() => {
  box = sandbox("trace");
  dir = box.path("trace");
});

afterEach(() => {
  box.remove();
});

function lines(): string[][] {
  return box
    .read("trace/events.tsv")
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t"));
}

describe.each(shells)("trace.sh under %s", (_, interpreter) => {
  function traced(body: string, options: RunOptions = {}) {
    return run([interpreter, "-c", `. ${quote(lib)}\n${body}`], {
      cwd: box.dir,
      ...options,
      env: { DOTFILES_TRACE_DIR: dir, GIT_TRACE2_EVENT: undefined, ...options.env },
    });
  }

  test("does nothing when DOTFILES_TRACE_DIR is unset", () => {
    const r = traced('trace_begin step\ntrue\ntrace_end\necho "git=${GIT_TRACE2_EVENT-unset}"\ntrap', {
      env: { DOTFILES_TRACE_DIR: undefined },
    });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("git=unset");
    expect(readdirSync(box.dir).sort()).toEqual(["bin"]);
  });

  test("writes B and E lines with increasing nanosecond timestamps", () => {
    const r = traced("trace_begin outer\ntrace_begin inner\ntrace_end\ntrace_end");
    expect(r.status).toBe(0);
    const events = lines();
    expect(events.map(([kind, , , , name]) => [kind, name])).toEqual([
      ["B", "outer"],
      ["B", "inner"],
      ["E", ""],
      ["E", ""],
      ["X", undefined],
    ]);
    const times = events.map(([, ns]) => BigInt(ns ?? "0"));
    for (const ns of times) expect(String(ns)).toMatch(/^\d{19}$/);
    for (let i = 1; i < times.length; i++) expect(times[i]).toBeGreaterThanOrEqual(times[i - 1] ?? 0n);
  });

  test("strips tabs from a span name, which would split its field", () => {
    traced('trace_begin "a\tb"\ntrace_end');
    expect(lines()[0]?.[4]).toBe("a b");
  });

  test("trace_end keeps the status of the step it closes", () => {
    const r = traced("trace_begin step\n(exit 3)\ntrace_end\necho $?");
    expect(r.stdout.trim()).toBe("3");
    expect(lines()[1]?.slice(0, 1).concat(lines()[1]?.[3] ?? "")).toEqual(["E", "3"]);
  });

  test("a set -e failure writes an X line carrying the exit status", () => {
    const r = traced("set -e\ntrace_begin step\nfalse\ntrace_end");
    expect(r.status).toBe(1);
    const [, x] = lines();
    expect(x?.[0]).toBe("X");
    expect(x?.[2]).toBe(lines()[0]?.[2]);
    expect(x?.[3]).toBe("1");
  });

  test("a command substitution writes no X line of its own", () => {
    traced("trace_begin step\nx=$(echo hi)\ntrace_end");
    expect(lines().filter(([kind]) => kind === "X")).toHaveLength(1);
  });

  test("points git's trace2 events into the trace directory", () => {
    const r = traced('echo "$GIT_TRACE2_EVENT"');
    expect(r.stdout.trim()).toBe(join(dir, "git"));
    expect(readdirSync(dir)).toContain("git");
  });

  test("leaves a GIT_TRACE2_EVENT that is already set alone", () => {
    const r = traced('echo "$GIT_TRACE2_EVENT"', { env: { GIT_TRACE2_EVENT: "/elsewhere" } });
    expect(r.stdout.trim()).toBe("/elsewhere");
    expect(readdirSync(dir)).not.toContain("git");
  });

  // Topic installers call trace_run while bun may not be installed yet.
  test("trace_run runs the command plainly when bun is absent, keeping its status", () => {
    const r = traced("trace_run sh -c 'echo ran; exit 4'", { onlyPath: ["/usr/bin", "/bin"] });
    expect(r.stdout.trim()).toBe("ran");
    expect(r.status).toBe(4);
    expect(readdirSync(dir)).not.toContain("lines");
  });

  test("trace_run hands the command to scripts/trace-run when bun is present", () => {
    const r = traced("trace_run sh -c 'echo ran; exit 4'", { env: { ZSH: repoRoot } });
    expect(r.stdout.trim()).toBe("ran");
    expect(r.status).toBe(4);
    expect(readdirSync(join(dir, "lines"))).toHaveLength(1);
  });
});
