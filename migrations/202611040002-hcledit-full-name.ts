// EXPIRES: 2027-05-04 every machine has run scripts/install since terraform/Brewfile named hcledit by its tap

import { $ } from "bun";
import { log } from "#gum";

export const FORMULA = "minamijoyo/hcledit/hcledit";

const env = { ...process.env, HOMEBREW_NO_AUTO_UPDATE: "1", HOMEBREW_NO_ENV_HINTS: "1" };

// A forced `brew bundle` cleanup uninstalls a keg installed under the bare
// name `hcledit`. Without this, the tap's would wait for the next bundle.
export async function up(): Promise<void> {
  const brew = Bun.which("brew", { PATH: process.env.PATH });
  if (brew === null) return;

  const listed = await $`cat /dev/null | ${brew} list --versions hcledit 2> ${Bun.stderr}`.env(env).nothrow().quiet();
  if (listed.exitCode === 0) return;

  await log("info", `installing ${FORMULA}`);
  if ((await $`${brew} install --formula ${FORMULA} < /dev/null`.env(env).nothrow()).exitCode !== 0) {
    throw new Error(`brew install ${FORMULA} failed`);
  }
}
