import { appendFileSync } from "node:fs";
import { join } from "node:path";

// Date.now() is only millisecond-precise, so it anchors a monotonic clock once.
const origin = BigInt(Date.now()) * 1_000_000n - process.hrtime.bigint();

/** Wall-clock nanoseconds since the epoch, comparable with what scripts/shell/trace.sh writes. */
export function nowNs(): bigint {
  return origin + process.hrtime.bigint();
}

/** Append a marker in the shell helper's format, under this process's pid. */
export function appendEvent(dir: string, kind: "B" | "E", status: number, name = ""): void {
  const line = [kind, nowNs(), process.pid, status, name.replace(/[\t\n]/g, " ")].join("\t");
  appendFileSync(join(dir, "events.tsv"), `${line}\n`);
}
