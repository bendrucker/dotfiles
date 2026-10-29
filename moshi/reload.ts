// Restart the moshi-hook daemon when config.toml changed since the last restart
// this applied. The daemon reads it only at startup, so this is the one reload
// that restarts a server. Upgrades restart through `restart_service: :changed`
// in claude/Brewfile instead.

import { $ } from "bun";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { log } from "#gum";

function read(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

export async function reload(env: Record<string, string | undefined> = process.env): Promise<number> {
  if (Bun.which("moshi-hook", { PATH: env.PATH }) === null) return 0;

  const config = read(join(env.XDG_CONFIG_HOME ?? `${env.HOME}/.config`, "moshi", "config.toml"));
  if (config === undefined) return 0;

  const stamp = join(env.XDG_STATE_HOME ?? `${env.HOME}/.local/state`, "dotfiles", "moshi-hook.applied");
  const current = createHash("sha256").update(config).digest("hex");
  const record = () => {
    mkdirSync(dirname(stamp), { recursive: true });
    writeFileSync(stamp, current);
  };

  if (read(stamp) === current) {
    await log("info", "moshi-hook: config.toml unchanged, skipping restart");
    return 0;
  }

  // A stopped daemon picks it up when it next starts.
  const status = await $`moshi-hook service status 2>>/dev/stderr`.env(env).nothrow().quiet();
  if (!status.stdout.toString().includes("state = running")) {
    await log("info", "moshi-hook: config.toml changed but the daemon is not running, skipping restart");
    record();
    return 0;
  }

  await log("info", "moshi-hook: config.toml changed, restarting the daemon");
  // Recorded only on success, so a failed restart retries next run.
  if ((await $`moshi-hook service restart 2>>/dev/stderr`.env(env).nothrow().quiet()).exitCode !== 0) {
    await log("warn", "moshi-hook: service restart failed, the daemon keeps its old config");
    return 1;
  }
  record();
  return 0;
}

if (import.meta.main) process.exit(await reload());
