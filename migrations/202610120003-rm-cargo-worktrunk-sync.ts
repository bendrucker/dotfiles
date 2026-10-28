// worktrunk-sync moved from `cargo install` to a mise cargo: tool. The old copy
// stays in ~/.cargo/bin, which is rust's own mise install directory, so it can
// sit ahead of mise's copy on $PATH and pin wt-sync at whatever was built then.
//
// EXPIRES: 2027-04-12 every machine has run scripts/install since the move

import { join } from "node:path";
import { type Context, exists } from "#migrations/migration";

export const CRATE = "worktrunk-sync";

export function up(context: Context): void {
  if (!exists(join(context.home, ".cargo", "bin", "wt-sync"))) return;

  const cargo = Bun.which("cargo", { PATH: process.env.PATH });
  if (cargo === null) {
    context.io.log("warn", `no cargo to run \`cargo uninstall ${CRATE}\`; remove ~/.cargo/bin/wt-sync by hand`);
    return;
  }

  context.io.log("info", `cargo uninstall ${CRATE}`);
  if (context.io.run([cargo, "uninstall", CRATE], { stdin: "ignore" }) !== 0) {
    throw new Error(`cargo uninstall ${CRATE} failed`);
  }
}
