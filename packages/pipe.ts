// Writes that survive a pipe. Through a real pipeline a write takes only what
// fits in the buffer, and process.exit discards whatever is queued behind it.

import { writeSync } from "node:fs";

// A reader that stops early, as `| head` does, closes the pipe. The shell died
// quietly on SIGPIPE, so this returns where Bun would raise and exit 1.
export function writeAll(fd: number, text: string): void {
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
