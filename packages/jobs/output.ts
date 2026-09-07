// Where an unattended job's own lines and its children's output go.
//
// bin/dotfiles-sync lets both through to the streams it was started with.
// bin/claude-upgrade keeps a copy of everything as well, which is what its
// failure report and its latch fingerprint are built from: the `{ … } 2>&1 |
// tee "$output"` the shell wrapped its whole body in.
//
// A captured run folds both streams onto stdout, as `2>&1` did, and buffers a
// child's output until it exits rather than letting it stream. gum's own log
// lines are a child's output like any other, so the order the log reads in is
// the order the children ran.

import { writeSync } from "node:fs";
import { constants } from "node:os";

export interface SpawnOptions {
  cwd?: string;
  // Inherited by default: the prompt in the sync gate reads the terminal the
  // job was started from. A child that must not eat the job's stdin says so.
  stdin?: "ignore" | "inherit";
  env?: Record<string, string | undefined>;
}

export interface Output {
  write(fd: 1 | 2, text: string): void;
  // Run a child whose output belongs in the job's log. Returns its status.
  run(cmd: string[], options?: SpawnOptions): number;
  // Run a child whose stdout is a value the job reads. Whatever it writes on
  // stderr still belongs in the log.
  read(cmd: string[], options?: SpawnOptions): CommandResult;
}

export interface Capture extends Output {
  captured(): string;
}

export interface CommandResult {
  status: number;
  stdout: string;
}

export type Level = "info" | "warn" | "error";

// gum writes its log lines to stderr, which is what keeps them out of every
// value this repo reads off a child's stdout.
export function log(out: Output, level: Level, message: string): void {
  out.run(["gum", "log", "--level", level, message]);
}

export function streamOutput(): Output {
  return {
    write(fd, text) {
      writeAll(fd, text);
    },
    run(cmd, options) {
      return spawn(cmd, options, "inherit", "inherit").status;
    },
    read(cmd, options) {
      const result = spawn(cmd, options, "pipe", "inherit");
      return { status: result.status, stdout: result.stdout };
    },
  };
}

export function capturedOutput(): Capture {
  const chunks: string[] = [];
  const emit = (text: string): void => {
    if (text === "") return;
    chunks.push(text);
    writeAll(1, text);
  };

  return {
    write(_fd, text) {
      emit(text);
    },
    run(cmd, options) {
      const result = spawn(cmd, options, "pipe", "pipe");
      emit(result.stdout);
      emit(result.stderr);
      return result.status;
    },
    read(cmd, options) {
      const result = spawn(cmd, options, "pipe", "pipe");
      emit(result.stderr);
      return { status: result.status, stdout: result.stdout };
    },
    captured() {
      return chunks.join("");
    },
  };
}

interface SpawnResult {
  status: number;
  stdout: string;
  stderr: string;
}

// The status a missing binary is reported with, since Bun raises where the
// shell exited 127. Every caller here treated 127 as an ordinary failure.
const NOT_RUN = 127;

function spawn(
  cmd: string[],
  options: SpawnOptions | undefined,
  stdout: "pipe" | "inherit",
  stderr: "pipe" | "inherit",
): SpawnResult {
  try {
    // The environment goes across explicitly, because Bun otherwise resolves a
    // bare command name against the PATH it captured at startup and a caller
    // that adjusted PATH afterwards reaches a different binary than it meant to.
    const run = Bun.spawnSync({
      cmd,
      cwd: options?.cwd,
      env: options?.env ?? process.env,
      stdin: options?.stdin ?? "inherit",
      stdout,
      stderr,
    });
    return {
      status: exitStatus(run),
      stdout: readStream(run.stdout),
      stderr: readStream(run.stderr),
    };
  } catch (error) {
    const reason = reasonFor(cmd, error);
    // On the inherit path nothing reads the returned stderr, so the reason goes
    // to the real one, which is where the shell's own complaint landed.
    if (stderr === "inherit") {
      writeAll(2, reason);
      return { status: NOT_RUN, stdout: "", stderr: "" };
    }
    return { status: NOT_RUN, stdout: "", stderr: reason };
  }
}

// A child killed by a signal has no exit code, and Bun reports exitCode null
// with signalCode set. Returning that verbatim let a caller hand null to
// process.exit, which exits 0: a bootstrap killed by SIGTERM read as a clean
// run and the nightly job filed nothing. 128 + the signal number is what the
// shell reported for the same child.
function exitStatus(run: { exitCode: number | null; signalCode: string | null }): number {
  if (run.exitCode !== null) return run.exitCode;
  return 128 + signalNumber(run.signalCode);
}

function signalNumber(signal: string | null): number {
  if (signal === null) return 0;
  const known = constants.signals as Record<string, number | undefined>;
  return known[signal] ?? 0;
}

// Bun throws where the shell printed its own "no such file or directory" into
// the merged stream and left it in the log and in the to-do filed from it. The
// reason belongs on stderr, or a job that could not start reports a failure
// with nothing in it to act on.
function reasonFor(cmd: string[], error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `${cmd[0]}: ${detail}\n`;
}

// An inherited stream leaves no buffer behind to read.
function readStream(stream: Buffer | null | undefined): string {
  return stream ? stream.toString() : "";
}

// The nightly jobs are read through a pipe, where one write takes only what the
// buffer holds and exiting drops whatever is queued behind it.
function writeAll(fd: number, text: string): void {
  const bytes = Buffer.from(text);
  let written = 0;
  while (written < bytes.length) written += writeSync(fd, bytes, written);
}
