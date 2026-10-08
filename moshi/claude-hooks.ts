// Runs after each claude repo pull, which rewrites the settings.json these hooks
// live in. The edit stays: a diff it leaves is a moshi upgrade to commit there.

import { log, type Output } from "#jobs/output";

export function installClaudeHooks(out: Output, env: Record<string, string | undefined>): boolean {
  if (Bun.which("moshi-hook", { PATH: env.PATH }) === null) return true;

  log(out, "info", "Installing moshi claude hooks...");
  if (out.run(["moshi-hook", "install", "--target", "claude"], { env, stdin: "ignore" }) !== 0) {
    log(out, "warn", "moshi-hook install failed");
    return false;
  }
  return true;
}
