// A stub that writes down how it was called, for a test asserting which
// commands code under test ran.

import type { Sandbox } from "./index";

const LOG = "calls.log";

// `body` runs after the call is recorded and decides what the stub answers.
export function recordingStub(box: Sandbox, name: string, body = ""): void {
  const log = box.path(LOG);
  const record = `{ printf '%s' "\${0##*/}"; for arg in "$@"; do printf '\\t%s' "$arg"; done; echo; } >> '${log}'`;
  box.stub(name, `${record}\n${body}`);
}

// Each recorded call as its command name followed by its arguments.
export function recorded(box: Sandbox): string[][] {
  return box
    .read(LOG)
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => line.split("\t"));
}
