// What every perf-vm module shares: logging, subprocesses, and polling.

export const READY_TIMEOUT_MS = 10 * 60 * 1000;
export const POLL_MS = 5000;

export class UsageError extends Error {}

export function log(message: string): void {
  process.stderr.write(`perf-vm: ${message}\n`);
}

export function spawn(cmd: string[], env?: Record<string, string>): { status: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync({ cmd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  return { status: result.exitCode ?? 128, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

export function which(name: string, hint: string): string {
  const found = Bun.which(name);
  if (!found) throw new Error(`${name} is not on PATH. ${hint}`);
  return found;
}

export function sleep(ms: number): void {
  Bun.sleepSync(ms);
}

export function until<T>(what: string, check: () => T | undefined): T {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    const value = check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    sleep(POLL_MS);
  }
}
