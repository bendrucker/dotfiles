// EXPIRES: 2027-05-04 every machine has run scripts/install since the move to homebrew/core

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { z } from "zod";
import { log } from "#gum";

export const TAP = "agavra/tap";

const Receipt = z.object({ source: z.object({ tap: z.string().nullish() }).nullish() });

const env = { ...process.env, HOMEBREW_NO_AUTO_UPDATE: "1", HOMEBREW_NO_ENV_HINTS: "1" };

// `brew bundle` counts the tap's formula as `tuicr` and leaves it installed.
// Only the install receipt records which tap a keg came from.
export async function up(): Promise<void> {
  const brew = Bun.which("brew", { PATH: process.env.PATH });
  if (brew === null) return;

  const cellar = (await $`${brew} --cellar < /dev/null`.env(env).nothrow().quiet()).stdout.toString().trim();
  if (!cellar || !fromTap(join(cellar, "tuicr"))) return;

  await log("info", `replacing ${TAP}/tuicr with homebrew/core's`);
  for (const args of [["uninstall", "--formula", "tuicr"], ["install", "--formula", "tuicr"]]) {
    if ((await $`${brew} ${args} < /dev/null`.env(env).nothrow()).exitCode !== 0) {
      throw new Error(`brew ${args.join(" ")} failed`);
    }
  }
}

function fromTap(rack: string): boolean {
  let versions: string[];
  try {
    versions = readdirSync(rack);
  } catch {
    return false;
  }
  return versions.some((version) => {
    try {
      const receipt = Receipt.parse(JSON.parse(readFileSync(join(rack, version, "INSTALL_RECEIPT.json"), "utf8")));
      return receipt.source?.tap === TAP;
    } catch {
      return false;
    }
  });
}
