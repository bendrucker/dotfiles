
export const READY_TIMEOUT_MS = 10 * 60 * 1000;
// Tests set VM_POLL_MS so a wait on a state change does not sit out real polls.
export const POLL_MS = Number(process.env.VM_POLL_MS || 5000);

export class UsageError extends Error {}

export function log(message: string): void {
  process.stderr.write(`vm: ${message}\n`);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// An undefined value in env removes that variable from the child's.
export function spawn(cmd: string[], env?: Record<string, string | undefined>): { status: number; stdout: string; stderr: string } {
  const merged = Object.entries({ ...process.env, ...env }).filter((entry): entry is [string, string] => entry[1] !== undefined);
  const result = Bun.spawnSync({ cmd, env: Object.fromEntries(merged), stdout: "pipe", stderr: "pipe" });
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
