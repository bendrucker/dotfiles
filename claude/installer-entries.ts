// settings.json entries that an installer writes and the nightly sync re-adds,
// so a diff made only of them is no change to the config repo.

import { z } from "zod";

interface InstallerHook { installer: string; command: RegExp }
interface InstallerEnv { installer: string; name: string; value: RegExp }

export const INSTALLER_HOOKS: InstallerHook[] = [
  { installer: "rex", command: /rex __internal/ },
  // Matches the bare command and the same command behind a wrapper script.
  { installer: "moshi", command: /moshi-hook'? claude-hook/ },
];

export const INSTALLER_ENV: InstallerEnv[] = [
  { installer: "moshi", name: "CLAUDE_CODE_PLUGIN_DIRS", value: /\/\.claude\/moshi-plugin$/ },
];

const Hook = z.looseObject({ command: z.string().optional() });
const Group = z.looseObject({ hooks: z.array(Hook).optional() });
const Settings = z.looseObject({
  hooks: z.record(z.string(), z.array(Group)).optional(),
  env: z.record(z.string(), z.unknown()).optional(),
});

function installerOwnedHook(hook: z.infer<typeof Hook>): boolean {
  return INSTALLER_HOOKS.some(({ command }) => command.test(hook.command ?? ""));
}

function installerOwnedEnv(name: string, value: unknown): boolean {
  return INSTALLER_ENV.some((entry) => entry.name === name && typeof value === "string" && entry.value.test(value));
}

// Drops every installer-owned entry, then any group, event, or table it leaves
// empty. Answers undefined for text that is not JSON with object-valued hooks and env.
export function withoutInstallerEntries(text: string): unknown {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = Settings.safeParse(json);
  if (!parsed.success) return undefined;
  const { hooks, env, ...rest } = parsed.data;

  const keptHooks = Object.fromEntries(
    Object.entries(hooks ?? {})
      .map(([event, groups]) => [
        event,
        groups
          .map((group) => ({ ...group, hooks: (group.hooks ?? []).filter((hook) => !installerOwnedHook(hook)) }))
          .filter((group) => group.hooks.length > 0),
      ] as const)
      .filter(([, groups]) => groups.length > 0),
  );
  const keptEnv = Object.fromEntries(Object.entries(env ?? {}).filter(([name, value]) => !installerOwnedEnv(name, value)));

  return {
    ...rest,
    ...(Object.keys(keptHooks).length > 0 && { hooks: keptHooks }),
    ...(Object.keys(keptEnv).length > 0 && { env: keptEnv }),
  };
}
