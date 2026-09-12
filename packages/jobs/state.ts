// What the unattended jobs remember between runs: one directory, and the latch
// files in it.
//
// The latch is a job's record of what it last reported, so a failure that has
// not changed does not file a second to-do. Things itself is the better record
// once a to-do exists, since it knows whether Ben has finished with one. The
// latch is what answers when Things cannot be read.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// Reading a latch file back strips its trailing newline, so anything compared
// against one has to be stripped the same way.
export const TRAILING_NEWLINES = /\n+$/;

export function stateDir(): string {
  const state = process.env.XDG_STATE_HOME || join(process.env.HOME || homedir(), ".local", "state");
  return join(state, "dotfiles");
}

export function statusFile(job: string): string {
  return join(stateDir(), `${job}.status`);
}

// A missing latch is a job's first-ever failure, and reads as the empty string so
// it compares unequal to any latch value and files.
export function readLatch(job: string): string {
  try {
    return readFileSync(statusFile(job), "utf8").replace(TRAILING_NEWLINES, "");
  } catch {
    return "";
  }
}

export function writeLatch(job: string, value: string): void {
  const path = statusFile(job);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${value}\n`);
}

export function clearLatch(job: string): void {
  rmSync(statusFile(job), { force: true });
}
