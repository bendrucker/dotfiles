// EXPIRES: 2027-04-08 every machine has run scripts/install since the removal

import { $ } from "bun";
import { log } from "#gum";
import { removeFormula } from "#migrations/migration";

export const TAP = "withgraphite/tap";

// The formula first: brew refuses to untap a tap with an installed formula.
export async function up(): Promise<void> {
  await removeFormula(`${TAP}/graphite`);
  await untap(TAP);
}

async function untap(tap: string): Promise<void> {
  const brew = Bun.which("brew", { PATH: process.env.PATH });
  if (brew === null) return;

  const env = { ...process.env, HOMEBREW_NO_AUTO_UPDATE: "1", HOMEBREW_NO_ENV_HINTS: "1" };
  const tapped = await $`cat /dev/null | ${brew} tap 2> ${Bun.stderr}`.env(env).nothrow().quiet();
  if (tapped.exitCode !== 0 || !tapped.stdout.toString().split("\n").includes(tap)) return;

  await log("info", `untapping ${tap}`);
  if ((await $`${brew} untap ${tap} < /dev/null`.env(env).nothrow()).exitCode !== 0) {
    throw new Error(`brew untap ${tap} failed`);
  }
}
