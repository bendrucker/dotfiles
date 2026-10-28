import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capturedIo, readOk, type SpawnOptions, streamIo, tee } from "#io";

let sandbox: string;
let stubs: string;
const environment = { PATH: process.env.PATH, GUM_DISMISS: process.env.GUM_DISMISS };

function writeScript(path: string, body: string): void {
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
}

function gumLog(): string {
  return readFileSync(join(sandbox, "gum.log"), "utf8");
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "io-"));
  stubs = join(sandbox, "stub");
  mkdirSync(stubs);
  writeScript(
    join(stubs, "gum"),
    [
      `printf '%s\\n' "$*" >>"${join(sandbox, "gum.log")}"`,
      'if [ "$1" = choose ]; then',
      '  [ -n "$GUM_DISMISS" ] && exit 130',
      "  head -n 2",
      "fi",
    ].join("\n"),
  );
  writeScript(join(stubs, "both-streams"), ["printf 'to stdout\\n'", "printf 'to stderr\\n' >&2"].join("\n"));
  process.env.PATH = `${stubs}:${environment.PATH}`;
  delete process.env.GUM_DISMISS;
});

afterEach(() => {
  process.env.PATH = environment.PATH;
  process.env.GUM_DISMISS = environment.GUM_DISMISS;
  rmSync(sandbox, { recursive: true, force: true });
});

describe("log", () => {
  test("hands gum the level and the message", () => {
    capturedIo().log("warn", "something happened");
    expect(gumLog()).toBe("log --level warn something happened\n");
  });

  // A machine without gum still says what happened, and only that.
  test("falls back to a plain line when gum is missing", () => {
    process.env.PATH = mkdtempSync(join(sandbox, "empty-"));
    const io = capturedIo();
    io.log("error", "it broke");
    expect(io.captured()).toBe("error: it broke\n");
  });

  test("falls back to a plain line when gum fails", () => {
    const broken = mkdtempSync(join(sandbox, "broken-"));
    writeScript(join(broken, "gum"), "printf 'gum: dyld\\n' >&2; exit 6");
    process.env.PATH = `${broken}:${environment.PATH}`;
    const io = capturedIo();
    io.log("warn", "it wobbled");
    expect(io.captured()).toBe("gum: dyld\nwarn: it wobbled\n");
  });
});

describe("choose", () => {
  test("hands gum the items on stdin and returns the selected lines", () => {
    const chosen = streamIo().choose(["first", "second", "third"], { header: "Pick", limit: "none", selected: "*" });
    expect(chosen).toEqual(["first", "second"]);
    expect(gumLog()).toBe("choose --no-limit --selected=* --header Pick\n");
  });

  test.each<{ name: string; dismiss: boolean; path?: string }>([
    { name: "dismissed", dismiss: true },
    { name: "gum missing", dismiss: false, path: "/nonexistent" },
  ])("returns nothing when $name", ({ dismiss, path }) => {
    if (dismiss) process.env.GUM_DISMISS = "1";
    if (path !== undefined) process.env.PATH = path;
    expect(streamIo().choose(["first"])).toEqual([]);
  });
});

describe("readOk", () => {
  test.each<{ name: string; cmd: string[]; expected: string | undefined }>([
    { name: "trims trailing newlines", cmd: ["bash", "-c", "printf 'value\\n\\n'"], expected: "value" },
    { name: "keeps an empty answer distinct", cmd: ["bash", "-c", "exit 0"], expected: "" },
    { name: "a nonzero exit", cmd: ["bash", "-c", "printf value; exit 3"], expected: undefined },
    { name: "a missing binary", cmd: ["no-such-command-anywhere"], expected: undefined },
  ])("$name", ({ cmd, expected }) => {
    expect(readOk(streamIo(), cmd, { stderr: "ignore" })).toBe(expected);
  });
});

describe("stdin", () => {
  test("feeds a child the input it is given", () => {
    expect(streamIo().read(["cat"], { stdin: { input: "hello\n" } }).stdout).toBe("hello\n");
  });
});

describe("stderr", () => {
  test.each<{ mode: NonNullable<SpawnOptions["stderr"]>; returned: string; logged: string }>([
    { mode: "log", returned: "", logged: "to stderr\n" },
    { mode: "ignore", returned: "", logged: "" },
    { mode: "pipe", returned: "to stderr\n", logged: "" },
  ])("$mode", async ({ mode, returned, logged }) => {
    const expected = { status: 0, stdout: "to stdout\n", stderr: returned };
    const io = capturedIo();
    expect(io.read(["both-streams"], { stderr: mode })).toEqual(expected);
    expect(io.captured()).toBe(logged);

    const later = capturedIo();
    expect(await later.readAsync(["both-streams"], { stderr: mode })).toEqual(expected);
    expect(later.captured()).toBe(logged);
  });

  test("returns the reason a binary could not run when piped", () => {
    const result = streamIo().read(["no-such-command-anywhere"], { stderr: "pipe" });
    expect(result.status).toBe(127);
    expect(result.stderr).toStartWith("no-such-command-anywhere: ");
  });
});

describe("tee", () => {
  // A child that alternates streams, so the kept text shows arrival order.
  test("echoes and keeps both streams in the order they arrived", async () => {
    writeScript(
      join(stubs, "alternate"),
      ["printf 'one\\n'", "sleep 0.1", "printf 'two\\n' >&2", "sleep 0.1", "printf 'three\\n'", "exit 4"].join("\n"),
    );
    const io = capturedIo();
    expect(await tee(io, ["alternate"], { stdin: "ignore" })).toEqual({ status: 4, output: "one\ntwo\nthree\n" });
    expect(io.captured()).toBe("one\ntwo\nthree\n");
  });

  test("names the job and the reason a child could not start", async () => {
    const io = capturedIo();
    const teed = await tee(io, ["no-such-command-anywhere"], { label: "job" });
    expect(teed.status).toBe(127);
    expect(teed.output).toStartWith("job: no-such-command-anywhere: ");
    expect(io.captured()).toBe(teed.output);
  });
});

const LONG = 400_000;

// The adapters driven from a child process, which is the only place fd 1 is
// observable.
function child(body: string[]): { exitCode: number | null; stdout: Buffer; stderr: Buffer } {
  const script = join(sandbox, "child.ts");
  writeFileSync(
    script,
    [`import { capturedIo, streamIo } from ${JSON.stringify(join(import.meta.dir, "io.ts"))};`, ...body].join("\n"),
  );

  const run = Bun.spawnSync({
    cmd: ["bun", script],
    env: process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: run.exitCode, stdout: run.stdout, stderr: run.stderr };
}

describe("capturedIo", () => {
  // `{ … } 2>&1 | tee` is what this replaces, so a child's stderr belongs in the
  // log beside its stdout.
  test("keeps both of a child's streams", () => {
    const io = capturedIo();
    expect(io.run(["both-streams"])).toBe(0);
    expect(io.captured()).toBe("to stdout\nto stderr\n");
  });

  // A value the job reads travels back rather than into the log, and whatever the
  // child complained about still belongs there.
  test("returns a read child's stdout and logs only its stderr", () => {
    const io = capturedIo();
    const result = io.read(["both-streams"]);
    expect(result).toEqual({ status: 0, stdout: "to stdout\n", stderr: "" });
    expect(io.captured()).toBe("to stderr\n");
  });

  test("keeps what the job wrote itself", () => {
    const io = capturedIo();
    io.write(2, "a line\n");
    expect(io.captured()).toBe("a line\n");
  });

  // The whole run is read back through a pipe, so nothing may be dropped on the
  // way out.
  test("writes everything it keeps through to stdout", () => {
    const run = child([
      "const io = capturedIo();",
      'io.write(1, "written\\n");',
      'io.run(["both-streams"]);',
      'if (io.captured() !== "written\\nto stdout\\nto stderr\\n") process.exit(1);',
    ]);
    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString()).toBe("written\nto stdout\nto stderr\n");
  });

  // process.stdout.write queues, and process.exit drops what has not drained: a
  // pipe takes one 131072-byte buffer and the rest of the log is lost. The
  // nightly log is several times that, and it is read back through `| tee`.
  test("writes a log past one pipe buffer without exiting on the remainder", () => {
    const run = child(["const io = capturedIo();", `io.write(1, "x".repeat(${LONG}) + "\\n");`, "process.exit(0);"]);
    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString().length).toBe(LONG + 1);
  });
});

describe("streamIo", () => {
  test("reports a child's status", () => {
    expect(streamIo().run(["bash", "-c", "exit 3"])).toBe(3);
  });

  test("returns a read child's stdout", () => {
    expect(streamIo().read(["bash", "-c", "printf value"])).toEqual({ status: 0, stdout: "value", stderr: "" });
  });

  // Bun raises where the shell exited 127, and every caller here treated 127 as
  // an ordinary failure.
  test("reports a command that could not be run rather than raising", () => {
    expect(streamIo().run(["no-such-command-anywhere"], { stderr: "ignore" })).toBe(127);
    expect(capturedIo().read(["no-such-command-anywhere"], { stderr: "ignore" })).toEqual({
      status: 127,
      stdout: "",
      stderr: "",
    });
  });

  // `| head` closes the pipe early. The shell died quietly on SIGPIPE, so a
  // stack trace and a failing status would be new.
  test("returns quietly when the reader closes the pipe", () => {
    const script = join(sandbox, "epipe.ts");
    writeFileSync(
      script,
      [
        `import { streamIo } from ${JSON.stringify(join(import.meta.dir, "io.ts"))};`,
        'streamIo().write(1, "x\\n".repeat(1e6));',
      ].join("\n"),
    );
    const run = Bun.spawnSync({
      cmd: ["bash", "-c", 'bun "$1" | head -1; echo "${PIPESTATUS[0]}"', "bash", script],
      env: process.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(run.stdout.toString()).toBe("x\n0\n");
    expect(run.stderr.toString()).toBe("");
  });
});
