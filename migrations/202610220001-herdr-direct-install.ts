// Removes the herdr launchd agent and Homebrew formula.
//
// EXPIRES: 2027-01-22 every machine has run scripts/install since herdr left Homebrew

import { $ } from "bun";
import { join } from "node:path";
import { type Context, exists, removeFormula, removeTree } from "#migrations/migration";

const LABEL = "me.bendrucker.herdr";

export async function up(context: Context): Promise<void> {
  if (context.platform === "darwin") await removeLaunchAgent(context);
  await removeHomebrewHerdr(context);
}

// A bootout would kill the live server and its panes.
async function removeLaunchAgent(context: Context): Promise<void> {
  const target = `gui/${process.getuid?.() ?? 0}/${LABEL}`;
  const job = await $`cat /dev/null | launchctl print ${target} 2>>/dev/stderr`.nothrow().quiet();
  if (job.exitCode === 0) {
    if (/^\s*pid = \d+/m.test(job.stdout.toString())) {
      throw new Error(`the herdr server still runs under launchd. See herdr/README.md`);
    }
    await $`launchctl bootout ${target} < /dev/null`.nothrow();
  }

  await removeTree(context,join(context.home, "Library", "LaunchAgents", `${LABEL}.plist`));
}

// herdr/install.sh runs after migrations, so the direct binary lands one install later.
async function removeHomebrewHerdr(context: Context): Promise<void> {
  const brew = Bun.which("brew", { PATH: process.env.PATH });
  if (brew === null) return;
  const listed = await $`cat /dev/null | ${brew} list --versions herdr 2>>/dev/stderr`.nothrow().quiet();
  if (listed.exitCode !== 0) return;

  if (!exists(join(context.home, ".local", "bin", "herdr"))) {
    throw new Error("~/.local/bin/herdr is not installed yet");
  }

  // Plugins call back into the server's binary path.
  const prefix = (await $`cat /dev/null | ${brew} --prefix 2>>/dev/stderr`.nothrow().quiet()).stdout.toString().trim();
  const processes = (await $`cat /dev/null | ps -A -o command= 2>>/dev/stderr`.nothrow().quiet()).stdout.toString();
  if (prefix !== "" && processes.split("\n").some((line) => line.startsWith(`${prefix}/`) && /\/herdr server\b/.test(line))) {
    throw new Error("a herdr server is running from Homebrew's binary");
  }

  await removeFormula("herdr");
}
