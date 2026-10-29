// Call a module's export in a child bun, so what it and the commands it runs
// write reaches the test as one log. Bun Shell writes to the process's own
// descriptors, where no in-process spy sees it.

import { $ } from "bun";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface Called<T> {
  value: T;
  // stdout and stderr, interleaved as they were written.
  output: string;
}

// A pause is real time with nothing to assert about it, so the child skips it.
const DRIVER = `
const { module, name, args, result } = JSON.parse(process.env.HARNESS_CALL);
Bun.sleep = async () => {};
const value = await (await import(module))[name](...args);
await Bun.write(result, JSON.stringify(value ?? null));
`;

export async function call<T>(
  module: string,
  name: string,
  args: unknown[] = [],
  env: Record<string, string | undefined> = process.env,
): Promise<Called<T>> {
  const scratch = mkdtempSync(join(tmpdir(), "harness-call-"));
  const result = join(scratch, "result.json");
  try {
    const request = JSON.stringify({ module, name, args, result });
    // Bun Shell takes one redirect per command, so stdin closes through a pipe.
    const child = await $`cat /dev/null | ${process.execPath} -e ${DRIVER} 2>&1`
      .env({ ...env, HARNESS_CALL: request })
      .nothrow()
      .quiet();
    const output = child.stdout.toString();
    if (child.exitCode !== 0) throw new Error(`${name} exited ${child.exitCode}:\n${output}`);
    return { value: JSON.parse(readFileSync(result, "utf8")), output };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
