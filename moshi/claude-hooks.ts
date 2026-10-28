// Runs after each claude repo pull, which rewrites the settings.json these hooks
// live in. The edit stays: a diff it leaves is a moshi upgrade to commit there.

import type { Io } from "#io";

export function installClaudeHooks(out: Io, env: Record<string, string | undefined>): boolean {
  if (Bun.which("moshi-hook", { PATH: env.PATH }) === null) return true;

  out.log("info", "Installing moshi claude hooks...");
  if (out.run(["moshi-hook", "install", "--target", "claude"], { env, stdin: "ignore" }) !== 0) {
    out.log("warn", "moshi-hook install failed");
    return false;
  }
  return true;
}
