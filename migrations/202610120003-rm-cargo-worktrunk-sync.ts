// worktrunk-sync moved from `cargo install` to a mise cargo: tool. The old copy
// stays in ~/.cargo/bin, which is rust's own mise install directory, so it can
// sit ahead of mise's copy on $PATH and pin wt-sync at whatever was built then.
//
// EXPIRES: 2027-04-12 every machine has run scripts/install since the move

import { $ } from "bun";
import { join } from "node:path";
import { log } from "#gum";
import { type Context, exists } from "#migrations/migration";

export const CRATE = "worktrunk-sync";

export async function up(context: Context): Promise<void> {
  if (!exists(join(context.home, ".cargo", "bin", "wt-sync"))) return;

  const cargo = Bun.which("cargo", { PATH: process.env.PATH });
  if (cargo === null) {
    await log("warn", `no cargo to run \`cargo uninstall ${CRATE}\`; remove ~/.cargo/bin/wt-sync by hand`);
    return;
  }

  await log("info", `cargo uninstall ${CRATE}`);
  if ((await $`${cargo} uninstall ${CRATE} < /dev/null`.nothrow()).exitCode !== 0) {
    throw new Error(`cargo uninstall ${CRATE} failed`);
  }
}
