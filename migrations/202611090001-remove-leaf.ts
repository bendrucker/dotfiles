// EXPIRES: 2027-05-09 every machine has run scripts/install since terminal/mise.toml dropped leaf

import { $ } from "bun";
import { log } from "#gum";

export const TOOL = "github:RivoLink/leaf";

// mise keeps every install of a tool its config stopped declaring, and the
// shim keeps `leaf` on PATH, so mdv would not be the only Markdown previewer.
export async function up(): Promise<void> {
  const mise = Bun.which("mise", { PATH: process.env.PATH });
  if (mise === null) return;

  const installed = await $`cat /dev/null | ${mise} ls --installed --no-header ${TOOL} 2> ${Bun.stderr}`.nothrow().text();
  if (installed.trim() === "") return;

  await log("info", `uninstalling ${TOOL}`);
  if ((await $`${mise} uninstall --all ${TOOL} < /dev/null`.nothrow()).exitCode !== 0) {
    throw new Error(`mise uninstall ${TOOL} failed`);
  }
  await $`${mise} reshim < /dev/null`.nothrow();
}
