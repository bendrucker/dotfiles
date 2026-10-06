// moshi-hook's Claude Code hooks live in the claude repo's settings.json, which
// bin/claude-sync rewrites on every pull. claude-sync calls this after the pull
// so the installer runs against the synced file.
//
// The installer adds the per-event entries its binary expects and leaves the
// rest alone. Its edit stays: the committed file is meant to match it, so a diff
// here is a moshi upgrade, which the sync gate reports the next night and a
// commit of the diff settles.

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
