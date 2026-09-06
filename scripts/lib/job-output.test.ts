import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capturedOutput, log, streamOutput } from "./job-output.ts";

let sandbox: string;
let stubs: string;
const environment = { PATH: process.env.PATH };

function writeScript(path: string, body: string): void {
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "job-output-"));
  stubs = join(sandbox, "stub");
  mkdirSync(stubs);
  writeScript(join(stubs, "gum"), `printf '%s\\n' "$*" >>"${join(sandbox, "gum.log")}"`);
  writeScript(join(stubs, "both-streams"), ["printf 'to stdout\\n'", "printf 'to stderr\\n' >&2"].join("\n"));
  process.env.PATH = `${stubs}:${environment.PATH}`;
});

afterEach(() => {
  process.env.PATH = environment.PATH;
  rmSync(sandbox, { recursive: true, force: true });
});

describe("log", () => {
  test("hands gum the level and the message", () => {
    log(capturedOutput(), "warn", "something happened");
    expect(readFileSync(join(sandbox, "gum.log"), "utf8")).toBe("log --level warn something happened\n");
  });
});

const LONG = 400_000;

// capturedOutput driven from a child process, which is the only place fd 1 is
// observable.
function tee(body: string[]): { exitCode: number | null; stdout: Buffer } {
  const script = join(sandbox, "tee.ts");
  writeFileSync(
    script,
    [
      `import { capturedOutput } from ${JSON.stringify(join(import.meta.dir, "job-output.ts"))};`,
      "const out = capturedOutput();",
      ...body,
    ].join("\n"),
  );

  const run = Bun.spawnSync({
    cmd: ["bun", script],
    env: process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: run.exitCode, stdout: run.stdout };
}

describe("capturedOutput", () => {
  // `{ … } 2>&1 | tee` is what this replaces, so a child's stderr belongs in the
  // log beside its stdout.
  test("keeps both of a child's streams", () => {
    const out = capturedOutput();
    expect(out.run(["both-streams"])).toBe(0);
    expect(out.captured()).toBe("to stdout\nto stderr\n");
  });

  // A value the job reads travels back rather than into the log, and whatever the
  // child complained about still belongs there.
  test("returns a read child's stdout and logs only its stderr", () => {
    const out = capturedOutput();
    const result = out.read(["both-streams"]);
    expect(result).toEqual({ status: 0, stdout: "to stdout\n" });
    expect(out.captured()).toBe("to stderr\n");
  });

  test("keeps what the job wrote itself", () => {
    const out = capturedOutput();
    out.write(2, "a line\n");
    expect(out.captured()).toBe("a line\n");
  });

  // The whole run is read back through a pipe, so nothing may be dropped on the
  // way out. A subprocess is the only place fd 1 is observable.
  test("writes everything it keeps through to stdout", () => {
    const run = tee([
      'out.write(1, "written\\n");',
      'out.run(["both-streams"]);',
      'if (out.captured() !== "written\\nto stdout\\nto stderr\\n") process.exit(1);',
    ]);
    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString()).toBe("written\nto stdout\nto stderr\n");
  });

  // process.stdout.write queues, and process.exit drops what has not drained: a
  // pipe takes one 131072-byte buffer and the rest of the log is lost. The
  // nightly log is several times that, and it is read back through `| tee`.
  test("writes a log past one pipe buffer without exiting on the remainder", () => {
    const run = tee([
      `out.write(1, "x".repeat(${LONG}) + "\\n");`,
      "process.exit(0);",
    ]);
    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString().length).toBe(LONG + 1);
  });
});

describe("streamOutput", () => {
  test("reports a child's status", () => {
    expect(streamOutput().run(["bash", "-c", "exit 3"])).toBe(3);
  });

  test("returns a read child's stdout", () => {
    expect(streamOutput().read(["bash", "-c", "printf value"])).toEqual({ status: 0, stdout: "value" });
  });

  // Bun raises where the shell exited 127, and every caller here treated 127 as
  // an ordinary failure.
  test("reports a command that could not be run rather than raising", () => {
    expect(streamOutput().run(["no-such-command-anywhere"])).toBe(127);
    expect(capturedOutput().read(["no-such-command-anywhere"])).toEqual({ status: 127, stdout: "" });
  });
});
