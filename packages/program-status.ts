// Rex's Program Status Protocol (OSC 7501): tells the terminal whether a job
// is working, waiting on the user, or finished, so an unfocused tab shows it.
// Terminals ignore an OSC they don't implement.
// https://www.superlogical.com/rex/docs/build/program-status

import { closeSync, openSync, writeSync } from "node:fs";

export type Status =
  | { state: "working" | "done" | "error" }
  | { state: "blocked"; kind: "permission" | "question" | "auth"; msg: string };

// Each job reports on its own child record, named from its title, so it never
// replaces the record of a program it runs under, such as Claude Code.
export function encode(title: string, status: Status): string {
  const pairs = [
    `state=${status.state}`,
    `id=${title.toLowerCase().replaceAll(" ", "-")}`,
    "app=dotfiles",
    `title=${base64(title)}`,
  ];
  if (status.state === "blocked") pairs.push(`kind=${status.kind}`, `msg=${base64(status.msg)}`);
  return `\x1b]7501;${pairs.join(":")}\x1b\\`;
}

// Writes to the controlling terminal, because a job's stdout and stderr can be
// a pipe. Without one, as under launchd, nothing is written.
export function report(title: string, status: Status, tty = "/dev/tty"): void {
  let fd: number;
  try {
    fd = openSync(tty, "w");
  } catch {
    return;
  }
  try {
    writeSync(fd, encode(title, status));
  } finally {
    closeSync(fd);
  }
}

function base64(text: string): string {
  return Buffer.from(text).toString("base64");
}
