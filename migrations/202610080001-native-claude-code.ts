// Migrations run before the topic installers, so the native build is installed
// here first. Removing the cask before then would leave the machine without a
// `claude` until claude/install.sh ran, and a failed install would leave it
// without one until the next night.
//
// EXPIRES: 2027-04-08 every machine has run scripts/install since the removal

import { join } from "node:path";
import { type Context, removeCask } from "#migrations/migration";

// Only the cask is macOS-only. claude/install.sh installs the native build on
// Linux.
export const platform = "darwin";

export function up(context: Context): void {
  const install = join(context.root, "claude", "install-native");
  if (context.out.run([install], { stdin: "ignore" }) !== 0) {
    throw new Error("installing native Claude Code failed, so the cask stays");
  }
  removeCask(context, "claude-code@latest");
}
