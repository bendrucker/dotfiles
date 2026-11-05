// EXPIRES: 2027-05-04 every machine has run scripts/install since the move to homebrew/core

import { $ } from "bun";
import { log } from "#gum";
import { removeFormula } from "#migrations/migration";

export const TAP = "agavra/tap";

// The formula first: brew refuses to untap a tap with an installed formula.
// `brew bundle` runs before migrations and counts the tap's formula as
// `tuicr`, so core's is installed here rather than on the next run.
export async function up(): Promise<void> {
  const brew = Bun.which("brew", { PATH: process.env.PATH });
  if (brew === null) return;

  await removeFormula(`${TAP}/tuicr`);
  await untap(brew, TAP);
  await install(brew, "tuicr");
}

const env = { ...process.env, HOMEBREW_NO_AUTO_UPDATE: "1", HOMEBREW_NO_ENV_HINTS: "1" };

async function untap(brew: string, tap: string): Promise<void> {
  const tapped = await $`cat /dev/null | ${brew} tap 2> ${Bun.stderr}`.env(env).nothrow().quiet();
  if (tapped.exitCode !== 0 || !tapped.stdout.toString().split("\n").includes(tap)) return;

  await log("info", `untapping ${tap}`);
  if ((await $`${brew} untap ${tap} < /dev/null`.env(env).nothrow()).exitCode !== 0) {
    throw new Error(`brew untap ${tap} failed`);
  }
}

async function install(brew: string, formula: string): Promise<void> {
  const listed = await $`cat /dev/null | ${brew} list --versions ${formula} 2> ${Bun.stderr}`.env(env).nothrow().quiet();
  if (listed.exitCode === 0) return;

  await log("info", `installing ${formula} from homebrew/core`);
  if ((await $`${brew} install ${formula} < /dev/null`.env(env).nothrow()).exitCode !== 0) {
    throw new Error(`brew install ${formula} failed`);
  }
}
