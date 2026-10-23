// herdr moved off Homebrew onto its own installer, because only a binary
// `herdr update` manages can hand a running server's panes to a new release.
// It also moved off the launchd agent: a server launchd starts doesn't inherit
// Ghostty's TCC grants, and the agent's KeepAlive would start a second server
// the moment a handoff retired the first. Nothing removes the agent or the
// formula once neither is declared.
//
// EXPIRES: 2027-01-22 every machine has run scripts/install since herdr left Homebrew

import { join } from "node:path";
import { type Context, exists, removeFormula, removeTree } from "#migrations/migration";

const LABEL = "me.bendrucker.herdr";

export function up(context: Context): void {
  if (context.platform === "darwin") removeLaunchAgent(context);
  removeHomebrewHerdr(context);
}

// A bootout ends the server the job is running, and every pane with it, so a
// job still holding one is left for a person to retire when the panes allow.
function removeLaunchAgent(context: Context): void {
  const target = `gui/${process.getuid?.() ?? 0}/${LABEL}`;
  const job = context.out.read(["launchctl", "print", target], { stdin: "ignore" });
  if (job.status === 0) {
    if (/^\s*pid = \d+/m.test(job.stdout)) {
      throw new Error(
        `the herdr server still runs under launchd. When its panes can stop, run \`launchctl bootout ${target}\` from a terminal outside herdr, then start \`herdr\` from Ghostty`,
      );
    }
    context.out.run(["launchctl", "bootout", target], { stdin: "ignore" });
  }

  removeTree(context, join(context.home, "Library", "LaunchAgents", `${LABEL}.plist`));
}

// herdr/install.sh lays the replacement down after migrations run, so the first
// install that sees this leaves Homebrew's copy for the next one. Until then it
// is the only herdr on PATH.
function removeHomebrewHerdr(context: Context): void {
  const brew = Bun.which("brew", { PATH: process.env.PATH });
  if (brew === null) return;
  if (context.out.read([brew, "list", "--versions", "herdr"], { stdin: "ignore" }).status !== 0) return;

  if (!exists(join(context.home, ".local", "bin", "herdr"))) {
    throw new Error("herdr/install.sh has not installed herdr to ~/.local/bin yet, so Homebrew's herdr stays");
  }

  // A server keeps running from a deleted binary, but the plugins it launches
  // are handed that binary's path to call back into it.
  const prefix = context.out.read([brew, "--prefix"], { stdin: "ignore" }).stdout.trim();
  const processes = context.out.read(["ps", "-A", "-o", "command="], { stdin: "ignore" }).stdout;
  if (prefix !== "" && processes.split("\n").some((line) => line.startsWith(`${prefix}/`) && /\/herdr server\b/.test(line))) {
    throw new Error("a herdr server is running from Homebrew's binary, so Homebrew's herdr stays until it restarts");
  }

  removeFormula(context, "herdr");
}
