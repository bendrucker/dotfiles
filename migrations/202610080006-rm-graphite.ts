// GitHub native stacked PRs replaced Graphite. That change stopped declaring
// the formula and its tap, but nothing uninstalls a formula or untaps a tap a
// Brewfile no longer names, so scripts/brew-drift kept reporting the tap.
//
// EXPIRES: 2027-04-08 every machine has run scripts/install since the removal

import { log } from "#jobs/output";
import { type Context, removeFormula } from "#migrations/migration";

export const TAP = "withgraphite/tap";

// The formula first: brew refuses to untap a tap with an installed formula.
export function up(context: Context): void {
  removeFormula(context, `${TAP}/graphite`);
  untap(context, TAP);
}

function untap(context: Context, tap: string): void {
  const brew = Bun.which("brew", { PATH: process.env.PATH });
  if (brew === null) return;

  const env = { ...process.env, HOMEBREW_NO_AUTO_UPDATE: "1", HOMEBREW_NO_ENV_HINTS: "1" };
  const tapped = context.out.read([brew, "tap"], { env, stdin: "ignore" });
  if (tapped.status !== 0 || !tapped.stdout.split("\n").includes(tap)) return;

  log(context.out, "info", `untapping ${tap}`);
  if (context.out.run([brew, "untap", tap], { env, stdin: "ignore" }) !== 0) {
    throw new Error(`brew untap ${tap} failed`);
  }
}
