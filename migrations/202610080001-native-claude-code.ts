// Migrations run before the topic installers, so the native build is installed
// here first. Removing the cask before then would leave the machine without a
// `claude` until claude/install.sh ran, and a failed install would leave it
// without one until the next night.
//
// EXPIRES: 2027-04-08 every machine has run scripts/install since the removal

import { $ } from "bun";
import { join } from "node:path";
import { type Context, removeCask } from "#migrations/migration";

// Only the cask is macOS-only. claude/install.sh installs the native build on
// Linux.
export const platform = "darwin";

export async function up(context: Context): Promise<void> {
  const install = join(context.root, "claude", "install-native");
  if ((await $`${install} < /dev/null`.nothrow()).exitCode !== 0) {
    throw new Error("installing native Claude Code failed, so the cask stays");
  }
  await removeCask("claude-code@latest");
}
