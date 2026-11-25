// Apply settings.json to every connected Rex Mac app through its
// client.setting actions. Each action sets an explicit value, so a setting
// that already matches is left alone. A missing server or app, or an app that
// refuses actions, is skipped with a warning and never fails the run.

import { $ } from "bun";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { log } from "#gum";

const Settings = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));

const Clients = z.object({
  clients: z.array(
    z.object({
      client_id: z.string(),
      info: z.object({ kind: z.string(), platform: z.string().optional(), label: z.string().optional() }).optional(),
    }),
  ),
});

const Actions = z.object({ actions: z.array(z.object({ name: z.string() })) });

type Env = Record<string, string | undefined>;

function findRex(env: Env): string | undefined {
  const onPath = Bun.which("rex", { PATH: env.PATH ?? "" });
  if (onPath !== null) return onPath;
  const bundled = `${env.HOME}/Library/Application Support/com.superlogical.rex/RexServer/Versions/Current/Rex Server.app/Contents/MacOS/rex`;
  return existsSync(bundled) ? bundled : undefined;
}

function parseJson<T>(schema: z.ZodType<T>, text: string): T | undefined {
  try {
    return schema.parse(JSON.parse(text));
  } catch {
    return undefined;
  }
}

export async function apply(env: Env = process.env): Promise<number> {
  const rex = findRex(env);
  if (rex === undefined) return 0;

  const settings = Settings.parse(JSON.parse(readFileSync(join(import.meta.dir, "settings.json"), "utf8")));

  const listed = await $`${rex} --autostart=false client ls --json`.env(env).nothrow().quiet();
  const clients = listed.exitCode === 0 ? parseJson(Clients, listed.stdout.toString()) : undefined;
  if (clients === undefined) {
    await log("info", "rex: server not running, skipping app settings");
    return 0;
  }

  const apps = clients.clients.filter((client) => client.info?.kind === "app" && client.info.platform === "macos");
  if (apps.length === 0) {
    await log("info", "rex: no Mac app connected, skipping app settings");
    return 0;
  }

  for (const app of apps) await applyTo(rex, env, app.client_id, app.info?.label ?? app.client_id, settings);
  return 0;
}

async function applyTo(rex: string, env: Env, client: string, label: string, settings: z.infer<typeof Settings>): Promise<void> {
  const listed = await $`${rex} --autostart=false -C ${client} actions --json`.env(env).nothrow().quiet();
  const actions = listed.exitCode === 0 ? parseJson(Actions, listed.stdout.toString()) : undefined;
  if (actions === undefined) {
    await log("warn", `rex: could not list ${label}'s actions, skipping app settings`);
    return;
  }
  const offered = new Set(actions.actions.map((action) => action.name));

  for (const [key, value] of Object.entries(settings)) {
    const action = `client.setting.${key}`;
    if (!offered.has(action)) {
      await log("warn", `rex: ${label} has no ${action}, skipping it`);
      continue;
    }

    const args = JSON.stringify({ value });
    const result = await $`${rex} --autostart=false -C ${client} do ${action} --args ${args} --timeout 10s`.env(env).nothrow().quiet();
    if (result.exitCode === 0) continue;

    const error = Bun.stripANSI(result.stderr.toString()).trim();
    // The app rejects a value it can't take, such as a theme this Mac hasn't imported.
    if (error.includes("(invalid_value)")) {
      await log("warn", `rex: ${label} rejected ${action}: ${error}`);
      continue;
    }
    // Any other failure, such as Remote Control being off, fails every action the same way.
    await log("warn", `rex: ${label} refused ${action}, skipping the rest of its settings: ${error}`);
    return;
  }
}

if (import.meta.main) process.exit(await apply());
