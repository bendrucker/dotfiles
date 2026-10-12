export { errorMessage, log, POLL_MS, READY_TIMEOUT_MS, until, UsageError } from "../aws/vm/process.ts";

export interface Exit {
  status: number;
  stdout: string;
}

/** Run a command to completion. Its output streams through unless captured. */
export function run(cmd: string[], options: { stdin?: Uint8Array; capture?: boolean } = {}): Exit {
  const result = Bun.spawnSync({
    cmd,
    stdin: options.stdin ?? "ignore",
    stdout: options.capture ? "pipe" : "inherit",
    stderr: "inherit",
  });
  return { status: result.exitCode ?? 128, stdout: options.capture ? result.stdout.toString() : "" };
}

export function must(cmd: string[], options: { stdin?: Uint8Array; capture?: boolean } = {}): string {
  const result = run(cmd, options);
  if (result.status !== 0) throw new Error(`${cmd.join(" ")} exited ${result.status}`);
  return result.stdout;
}

export function randomName(): string {
  return `vm-test-${Array.from(crypto.getRandomValues(new Uint8Array(3)), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
