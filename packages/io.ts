// Every subprocess, log line, and prompt a job or CLI makes goes through an Io,
// so a test can hand it a scripted one instead of putting stubs on PATH.
//
// streamIo lets everything through to the streams the process was started
// with. capturedIo keeps a copy as well, which bin/claude-sync builds its
// failure report and latch fingerprint from: the `{ … } 2>&1 | tee "$output"`
// the shell wrapped its whole body in. A captured run folds both streams onto
// stdout and buffers a child's output until it exits, so the log reads in the
// order the children ran.

import { closeSync, openSync, writeSync } from "node:fs";
import { constants } from "node:os";

export type Level = "info" | "warn" | "error";

export interface SpawnOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  // Inherited by default: the prompt in the sync gate reads the terminal the
  // job was started from. A child that must not eat the job's stdin says so.
  stdin?: "inherit" | "ignore" | { input: string };
  // "log" streams to stderr, or into the captured log. "pipe" returns it in
  // the result and keeps it out of the log.
  stderr?: "log" | "ignore" | "pipe";
}

export interface Result {
  status: number;
  stdout: string;
  // Filled only for `stderr: "pipe"`.
  stderr: string;
}

export interface ChooseOptions {
  header?: string;
  limit?: number | "none";
  selected?: string[] | "*";
}

export interface Io {
  // Writes everything, and returns quietly when the reader has gone away.
  write(fd: 1 | 2, text: string): void;
  // Run a child whose output belongs in the log. Returns its status.
  run(cmd: string[], options?: SpawnOptions): number;
  // Run a child whose stdout is a value the caller reads.
  read(cmd: string[], options?: SpawnOptions): Result;
  // read without blocking, so independent lookups can run side by side.
  readAsync(cmd: string[], options?: SpawnOptions): Promise<Result>;
  log(level: Level, message: string): void;
  // The selected items, or none when the picker was dismissed or gum is missing.
  choose(items: string[], options?: ChooseOptions): string[];
}

export interface Capture extends Io {
  captured(): string;
}

// The status a missing binary is reported with, since Bun raises where the
// shell exited 127.
export const NOT_RUN = 127;

// A child's stdout with trailing newlines trimmed, or undefined when it exited
// nonzero or could not run.
export function readOk(io: Io, cmd: string[], options?: SpawnOptions): string | undefined {
  const result = io.read(cmd, options);
  if (result.status !== 0) return undefined;
  return result.stdout.replace(/\n+$/, "");
}

export function streamIo(): Io {
  return adapter((fd, text) => writeAll(fd, text), false);
}

export function capturedIo(): Capture {
  const chunks: string[] = [];
  const io = adapter((_fd, text) => {
    if (text === "") return;
    chunks.push(text);
    writeAll(1, text);
  }, true);
  return { ...io, captured: () => chunks.join("") };
}

type Sink = (fd: 1 | 2, text: string) => void;

function adapter(sink: Sink, captured: boolean): Io {
  // A captured child's stdout goes in the log ahead of its stderr, as it did
  // through `2>&1 | tee`. On the inherit path the child's stderr has already
  // gone through, so only a reason it could not run is left to write.
  const exec = (cmd: string[], options: SpawnOptions | undefined, logStdout: boolean): Result => {
    const stderr = options?.stderr ?? "log";
    const result = spawn(cmd, options, logStdout && !captured ? "inherit" : "pipe", stderrMode(stderr, captured));
    if (logStdout && captured) sink(1, result.stdout);
    return settle(result, stderr);
  };
  const settle = (result: Spawned, stderr: NonNullable<SpawnOptions["stderr"]>): Result => {
    if (stderr === "log" && (captured || result.reason !== undefined)) sink(2, result.stderr);
    return { status: result.status, stdout: result.stdout, stderr: stderr === "pipe" ? result.stderr : "" };
  };

  const io: Io = {
    write: sink,
    run(cmd, options) {
      return exec(cmd, options, true).status;
    },
    read(cmd, options) {
      return exec(cmd, options, false);
    },
    async readAsync(cmd, options) {
      const stderr = options?.stderr ?? "log";
      return settle(await spawnAsync(cmd, options, stderrMode(stderr, captured)), stderr);
    },
    // gum writes its log lines to stderr, which keeps them out of every value
    // read off a child's stdout. A gum that is missing or fails falls back to
    // a plain line rather than leaving the message unsaid.
    log(level, message) {
      const cmd = ["gum", "log", "--level", level, message];
      const result = spawn(cmd, undefined, captured ? "pipe" : "inherit", stderrMode("log", captured));
      if (result.reason === undefined) {
        if (captured) {
          sink(1, result.stdout);
          sink(2, result.stderr);
        }
        if (result.status === 0) return;
      }
      sink(2, `${level}: ${message}\n`);
    },
    // gum sizes its frame from the terminal its stderr points at, so a
    // redirected stderr would draw an invisible prompt that still takes keys.
    choose(items, options = {}) {
      const tty = openTty();
      try {
        const cmd = ["gum", "choose", ...chooseFlags(options)];
        const result = spawn(cmd, { stdin: { input: lines(items) } }, "pipe", tty ?? "inherit");
        if (result.status !== 0) return [];
        return result.stdout.split("\n").filter((line) => line !== "");
      } finally {
        if (tty !== undefined) closeSync(tty);
      }
    },
  };
  return io;
}

// Undefined off a terminal, as under launchd or in CI.
function openTty(): number | undefined {
  try {
    return openSync("/dev/tty", "w");
  } catch {
    return undefined;
  }
}

function stderrMode(stderr: NonNullable<SpawnOptions["stderr"]>, captured: boolean): "pipe" | "inherit" | "ignore" {
  if (stderr === "log") return captured ? "pipe" : "inherit";
  return stderr;
}

function chooseFlags(options: ChooseOptions): string[] {
  const flags: string[] = [];
  if (options.limit === "none") flags.push("--no-limit");
  else if (options.limit !== undefined) flags.push(`--limit=${options.limit}`);
  if (options.selected === "*") flags.push("--selected=*");
  else if (options.selected !== undefined && options.selected.length > 0) flags.push(`--selected=${options.selected.join(",")}`);
  if (options.header !== undefined) flags.push("--header", options.header);
  return flags;
}

function lines(items: string[]): string {
  return items.map((item) => `${item}\n`).join("");
}

interface Spawned extends Result {
  // Why the binary could not run, already folded into stderr.
  reason?: string;
}

export function spawn(
  cmd: string[],
  options: SpawnOptions | undefined,
  stdout: "pipe" | "inherit",
  stderr: "pipe" | "inherit" | "ignore" | number,
): Spawned {
  try {
    // The environment goes across explicitly, because Bun otherwise resolves a
    // bare command name against the PATH it captured at startup and a caller
    // that adjusted PATH afterwards reaches a different binary than it meant to.
    const run = Bun.spawnSync({
      cmd,
      cwd: options?.cwd,
      env: options?.env ?? process.env,
      stdin: stdinFor(options?.stdin),
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
    return { status: NOT_RUN, stdout: "", stderr: reason, reason };
  }
}

async function spawnAsync(
  cmd: string[],
  options: SpawnOptions | undefined,
  stderr: "pipe" | "inherit" | "ignore",
): Promise<Spawned> {
  let child;
  try {
    child = Bun.spawn({
      cmd,
      cwd: options?.cwd,
      env: options?.env ?? process.env,
      stdin: stdinFor(options?.stdin),
      stdout: "pipe",
      stderr,
    });
  } catch (error) {
    const reason = reasonFor(cmd, error);
    return { status: NOT_RUN, stdout: "", stderr: reason, reason };
  }
  const [stdout, stderrText] = await Promise.all([
    new Response(child.stdout).text(),
    child.stderr instanceof ReadableStream ? new Response(child.stderr).text() : "",
  ]);
  await child.exited;
  return { status: exitStatus(child), stdout, stderr: stderrText };
}

export interface Teed {
  status: number;
  // Both streams, interleaved in the order their chunks arrived.
  output: string;
}

// A long step whose output is both live progress and the text a failure is
// filed with, so each chunk reaches io's stdout as it arrives and is kept. It
// spawns for real whatever io is, because a read returns only once the child
// exits. `label` prefixes the reason a child could not start.
export async function tee(
  io: Io,
  cmd: string[],
  options: { stdin?: "inherit" | "ignore"; label?: string } = {},
): Promise<Teed> {
  let child;
  try {
    child = Bun.spawn({ cmd, env: process.env, stdin: options.stdin ?? "inherit", stdout: "pipe", stderr: "pipe" });
  } catch (error) {
    const reason = `${options.label === undefined ? "" : `${options.label}: `}${reasonFor(cmd, error)}`;
    io.write(1, reason);
    return { status: NOT_RUN, output: reason };
  }

  const chunks: Uint8Array[] = [];
  const pump = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      chunks.push(chunk);
      io.write(1, decoder.decode(chunk, { stream: true }));
    }
    io.write(1, decoder.decode());
  };
  await Promise.all([pump(child.stdout), pump(child.stderr)]);
  await child.exited;
  return { status: exitStatus(child), output: Buffer.concat(chunks).toString() };
}

function stdinFor(stdin: SpawnOptions["stdin"]): "inherit" | "ignore" | Buffer {
  if (stdin === undefined) return "inherit";
  if (typeof stdin === "string") return stdin;
  return Buffer.from(stdin.input);
}

// A child killed by a signal has no exit code, and Bun reports exitCode null
// with signalCode set. Handing that null to process.exit exits 0, so a
// bootstrap killed by SIGTERM would read as a clean run. 128 + the signal
// number is what the shell reported for the same child.
function exitStatus(run: { exitCode: number | null; signalCode: string | null }): number {
  if (run.exitCode !== null) return run.exitCode;
  return 128 + signalNumber(run.signalCode);
}

function signalNumber(signal: string | null): number {
  if (signal === null) return 0;
  const known = constants.signals as Record<string, number | undefined>;
  return known[signal] ?? 0;
}

// The shell printed its own "no such file or directory" into the merged
// stream, and a job that could not start must still report something to act on.
function reasonFor(cmd: string[], error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `${cmd[0]}: ${detail}\n`;
}

function readStream(stream: Buffer | null | undefined): string {
  return stream ? stream.toString() : "";
}

// The nightly jobs are read through a pipe, where one write takes only what the
// buffer holds and exiting drops whatever is queued behind it. A reader that
// stops early, as `| head` does, closes the pipe: the shell died quietly on
// SIGPIPE, so this returns rather than raising.
function writeAll(fd: number, text: string): void {
  const bytes = Buffer.from(text);
  let written = 0;
  try {
    while (written < bytes.length) written += writeSync(fd, bytes, written);
  } catch (error) {
    if (isBrokenPipe(error)) return;
    throw error;
  }
}

function isBrokenPipe(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "EPIPE" || error.code === "ERR_STREAM_DESTROYED");
}
