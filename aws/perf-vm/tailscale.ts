import { z } from "zod";
import { awsSpawn, runCommand } from "./aws.ts";
import { hostAlias, PREFIX, quote } from "./ssh.ts";
import { log } from "./process.ts";

// Mint the auth key a perf-vm joins the tailnet with, from an OAuth client
// that can create keys for one tag and nothing else.

// Tailscale reads the client from the secret itself and ignores client_id, as
// its own `tailscale up --auth-key=tskey-client-...` path does.
async function accessToken(api: string, secret: string): Promise<string> {
  const response = await fetch(`${api}/api/v2/oauth/token`, {
    method: "POST",
    body: new URLSearchParams({ client_id: "perf-vm", client_secret: secret }),
  });
  if (!response.ok) throw new Error(`Tailscale OAuth token request failed: ${response.status} ${await response.text()}`);
  return z.object({ access_token: z.string() }).parse(await response.json()).access_token;
}

// Single use, ephemeral so the node leaves the tailnet on its own once the VM
// is gone, preauthorized so no one has to approve it, and valid only long
// enough to boot.
export async function mintAuthKey(secret: string, tag: string, description: string, api = "https://api.tailscale.com"): Promise<string> {
  const token = await accessToken(api, secret);
  const response = await fetch(`${api}/api/v2/tailnet/-/keys`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      capabilities: { devices: { create: { reusable: false, ephemeral: true, preauthorized: true, tags: [tag] } } },
      expirySeconds: 3600,
      description,
    }),
  });
  if (!response.ok) throw new Error(`Tailscale auth key request failed: ${response.status} ${await response.text()}`);
  return z.object({ key: z.string() }).parse(await response.json()).key;
}

// Infrastructure stores the secret of an OAuth client that can mint auth keys
// for this tag and nothing else. The tailnet policy lets Ben's devices reach
// tagged VMs and gives the VMs no route to anything else.
export const TAILSCALE_PARAMETER = "/perf-vm/tailscale-oauth-client-secret";
export const TAILSCALE_TAG = "tag:perf-vm";

const Parameter = z.object({ Parameter: z.object({ Value: z.string() }) });

// Tailscale is the direct path and Session Manager the fallback, so a missing
// parameter or a failed mint launches an SSM-only VM rather than no VM.
export async function tailnetKey(name: string): Promise<string | undefined> {
  const read = awsSpawn(["ssm", "get-parameter", "--name", TAILSCALE_PARAMETER, "--with-decryption"]);
  if (read.status !== 0) {
    const missing = read.stderr.includes("ParameterNotFound");
    log(missing ? `no ${TAILSCALE_PARAMETER} parameter, so this VM is reachable through Session Manager only` : read.stderr.trim());
    return undefined;
  }
  try {
    return await mintAuthKey(Parameter.parse(JSON.parse(read.stdout)).Parameter.Value, TAILSCALE_TAG, hostAlias(name), process.env.PERF_VM_TAILSCALE_API);
  } catch (error) {
    log(`${(error as Error).message}; falling back to Session Manager only`);
    return undefined;
  }
}

export function upCommand(authKey: string, hostname: string): string {
  return `tailscale up --auth-key=${quote(authKey)} --hostname=${quote(hostname)} --advertise-tags=${TAILSCALE_TAG}`;
}

// An ephemeral node leaves the tailnet soon after its VM stops, so a resumed VM
// usually needs a fresh key. One that never installed Tailscale stays SSM only.
export async function rejoinTailnet(instanceId: string, name: string): Promise<string | undefined> {
  const probe = "if ! command -v tailscale >/dev/null; then echo absent; elif tailscale status >/dev/null 2>&1; then echo up; else echo down; fi";
  const status = runCommand(instanceId, probe).trim();
  if (status === "absent") return undefined;
  if (status !== "up") {
    const authKey = await tailnetKey(name);
    if (!authKey) return undefined;
    runCommand(instanceId, upCommand(authKey, hostAlias(name)));
  }
  return tailnetAddress(instanceId);
}

// The VM reports its own address, which sidesteps the -1 suffix Tailscale gives
// a hostname an earlier ephemeral node still holds.
export function tailnetAddress(instanceId: string): string | undefined {
  try {
    return runCommand(instanceId, "tailscale ip -4").trim().split("\n")[0] || undefined;
  } catch (error) {
    log(`the VM did not join the tailnet, so ${PREFIX} falls back to Session Manager: ${(error as Error).message}`);
    return undefined;
  }
}
