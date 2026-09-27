// A Linux build of a tool the VM runs, pinned to the version installed here.

import { z } from "zod";
import { quote } from "./ssh.ts";
import { errorMessage, log, spawn } from "./process.ts";

const ARCHES = ["aarch64", "x86_64"] as const;
export type Arch = (typeof ARCHES)[number];

export interface Source {
  // The local command, and the prefix of the shell variables user data sets.
  tool: string;
  repo: string;
  target: string;
  tag(version: string): string;
  asset(version: string, arch: Arch): string;
}

export interface Asset {
  arch: Arch;
  url: string;
  sha256: string;
}

export type Release = Asset[];

const GitHubRelease = z.object({
  assets: z.array(z.object({ name: z.string(), browser_download_url: z.string(), digest: z.string().nullable() })),
});

export async function release(source: Source, version: string, api = "https://api.github.com"): Promise<Release> {
  const tag = source.tag(version);
  const response = await fetch(`${api}/repos/${source.repo}/releases/tags/${tag}`);
  if (!response.ok) throw new Error(`${source.tool} release ${tag} lookup failed: ${response.status}`);
  const { assets } = GitHubRelease.parse(await response.json());
  const found: Release = [];
  for (const arch of ARCHES) {
    const asset = assets.find((candidate) => candidate.name === source.asset(version, arch));
    const sha256 = asset?.digest?.replace(/^sha256:/, "");
    if (!asset || !sha256) continue;
    // Both land in a script that runs as root on boot.
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`${source.tool} release ${tag} has a malformed digest: ${sha256}`);
    found.push({ arch, url: asset.browser_download_url, sha256 });
  }
  if (found.length === 0) throw new Error(`${source.tool} release ${tag} has no Linux build with a digest`);
  return found;
}

// Without a matching release, launch still starts a VM that SSH reaches.
export async function localRelease(source: Source): Promise<Release | undefined> {
  if (!Bun.which(source.tool)) return undefined;
  const version = /(\d+\.\d+\.\d+\S*)/.exec(spawn([source.tool, "--version"]).stdout)?.[1];
  if (!version) {
    log(`could not read the local ${source.tool} version, so the VM gets no ${source.tool}`);
    return undefined;
  }
  try {
    return await release(source, version, process.env.VM_GITHUB_API);
  } catch (error) {
    log(`${errorMessage(error)}; the VM gets no ${source.tool}`);
    return undefined;
  }
}

// The template decides the architecture, so the VM picks its own build.
export function installLines(source: Source, found: Release): string[] {
  const { tool } = source;
  return [
    'case "$(uname -m)" in',
    ...found.map((asset) => `  ${asset.arch}) ${tool}_url=${quote(asset.url)} ${tool}_sum=${asset.sha256} ;;`),
    "esac",
    "install -d -o ec2-user -g ec2-user /home/ec2-user/.local /home/ec2-user/.local/bin",
    `curl -fsSL --retry 3 -o /tmp/${tool} "$${tool}_url"`,
    // User data runs without -e, so a mismatch has to stop the install itself.
    `echo "$${tool}_sum  /tmp/${tool}" | sha256sum -c - &&`,
    `  install -m 755 -o ec2-user -g ec2-user /tmp/${tool} ${source.target}`,
  ];
}
