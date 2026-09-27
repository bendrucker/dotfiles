// The command line tools a VM installs through mise on first boot.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Kind } from "./kinds.ts";
import { installLines, localRelease, type Release, type Source } from "./release.ts";

export const MISE: Source = {
  tool: "mise",
  repo: "jdx/mise",
  target: "/home/ec2-user/.local/bin/mise",
  tag: (version) => `v${version}`,
  asset: (version, arch) => `mise-v${version}-linux-${arch === "aarch64" ? "arm64" : "x64"}`,
};

export const TOOLS_LOG = "/var/log/vm-tools.log";
export const TOOLS_STATUS = "/var/lib/vm/tools-status";

const GuestConfig = z.object({ tools: z.record(z.string(), z.string()) });

export function guestTools(kind: Kind, path = join(import.meta.dir, "guest", "mise.toml")): Record<string, string> {
  const shipped = GuestConfig.parse(Bun.TOML.parse(readFileSync(path, "utf8"))).tools;
  return { ...shipped, ...kind.tools };
}

export function miseRelease(): Promise<Release | undefined> {
  return localRelease(MISE);
}

// A tool that fails to install leaves the rest usable, so the exit status is
// recorded for launch to report rather than failing the boot.
export function toolLines(mise: Release, tools: Record<string, string>): string[] {
  return [
    ...installLines(MISE, mise),
    "install -d -o ec2-user -g ec2-user /home/ec2-user/.config /home/ec2-user/.config/mise",
    "cat > /home/ec2-user/.config/mise/config.toml <<'TOOLS'",
    "[tools]",
    // JSON string escapes are valid TOML basic strings.
    ...Object.entries(tools).map(([tool, version]) => `${JSON.stringify(tool)} = ${JSON.stringify(version)}`),
    "TOOLS",
    `echo 'export PATH="$HOME/.local/share/mise/shims:$HOME/.local/bin:$PATH"' >> /home/ec2-user/.bashrc`,
    "chown ec2-user:ec2-user /home/ec2-user/.config/mise/config.toml /home/ec2-user/.bashrc",
    "install -d /var/lib/vm",
    `runuser -l ec2-user -c 'MISE_YES=1 ${MISE.target} install' > ${TOOLS_LOG} 2>&1; echo $? > ${TOOLS_STATUS}`,
  ];
}
