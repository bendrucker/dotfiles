// Runs after each claude repo pull, which rewrites the settings.json these hooks
// live in. The edit stays: a diff it leaves is a moshi upgrade to commit there.

import { $ } from "bun";
import { log } from "#gum";

export async function installClaudeHooks(env: Record<string, string | undefined>): Promise<boolean> {
  if (Bun.which("moshi-hook", { PATH: env.PATH }) === null) return true;

  await log("info", "Installing moshi claude hooks...");
  if ((await $`moshi-hook install --target claude < /dev/null`.env(env).nothrow()).exitCode !== 0) {
    await log("warn", "moshi-hook install failed");
    return false;
  }
  return true;
}
