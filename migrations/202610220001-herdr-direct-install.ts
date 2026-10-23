// Removes the herdr launchd agent and Homebrew formula.
//
// EXPIRES: 2027-01-22 every machine has run scripts/install since herdr left Homebrew

import { join } from "node:path";
import { type Context, exists, removeFormula, removeTree } from "#migrations/migration";

const LABEL = "me.bendrucker.herdr";

export function up(context: Context): void {
  if (context.platform === "darwin") removeLaunchAgent(context);
  removeHomebrewHerdr(context);
}

// A bootout would kill the live server and its panes.
function removeLaunchAgent(context: Context): void {
  const target = `gui/${process.getuid?.() ?? 0}/${LABEL}`;
  const job = context.out.read(["launchctl", "print", target], { stdin: "ignore" });
  if (job.status === 0) {
    if (/^\s*pid = \d+/m.test(job.stdout)) {
      throw new Error(`the herdr server still runs under launchd. See herdr/README.md`);
    }
    context.out.run(["launchctl", "bootout", target], { stdin: "ignore" });
  }

  removeTree(context, join(context.home, "Library", "LaunchAgents", `${LABEL}.plist`));
}

// herdr/install.sh runs after migrations, so the direct binary lands one install later.
function removeHomebrewHerdr(context: Context): void {
  const brew = Bun.which("brew", { PATH: process.env.PATH });
  if (brew === null) return;
  if (context.out.read([brew, "list", "--versions", "herdr"], { stdin: "ignore" }).status !== 0) return;

  if (!exists(join(context.home, ".local", "bin", "herdr"))) {
    throw new Error("~/.local/bin/herdr is not installed yet");
  }

  // Plugins call back into the server's binary path.
  const prefix = context.out.read([brew, "--prefix"], { stdin: "ignore" }).stdout.trim();
  const processes = context.out.read(["ps", "-A", "-o", "command="], { stdin: "ignore" }).stdout;
  if (prefix !== "" && processes.split("\n").some((line) => line.startsWith(`${prefix}/`) && /\/herdr server\b/.test(line))) {
    throw new Error("a herdr server is running from Homebrew's binary");
  }

  removeFormula(context, "herdr");
}
