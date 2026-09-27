import { z } from "zod";
import { awsSpawn, runCommand } from "./aws.ts";
import type { Kind } from "./kinds.ts";
import { hostAlias, PREFIX, quote } from "./ssh.ts";
import { errorMessage, log } from "./process.ts";

// Tailscale reads the client from the secret and ignores client_id.
async function accessToken(api: string, secret: string): Promise<string> {
  const response = await fetch(`${api}/api/v2/oauth/token`, {
    method: "POST",
    body: new URLSearchParams({ client_id: "vm", client_secret: secret }),
  });
  if (!response.ok) throw new Error(`Tailscale OAuth token request failed: ${response.status} ${await response.text()}`);
  return z.object({ access_token: z.string() }).parse(await response.json()).access_token;
}

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

const Parameter = z.object({ Parameter: z.object({ Value: z.string() }) });

// A kind with no tailnet, a missing parameter, or a failed mint launches an
// SSM-only VM.
export async function tailnetKey(kind: Kind, name: string): Promise<string | undefined> {
  if (!kind.tailnet) return undefined;
  const { secret, tag } = kind.tailnet;
  const read = awsSpawn(kind, ["ssm", "get-parameter", "--name", secret, "--with-decryption"]);
  if (read.status !== 0) {
    const missing = read.stderr.includes("ParameterNotFound");
    log(missing ? `no ${secret} parameter, so this VM is reachable through Session Manager only` : read.stderr.trim());
    return undefined;
  }
  try {
    return await mintAuthKey(Parameter.parse(JSON.parse(read.stdout)).Parameter.Value, tag, hostAlias(name), process.env.VM_TAILSCALE_API);
  } catch (error) {
    log(`${errorMessage(error)}; falling back to Session Manager only`);
    return undefined;
  }
}

export function upCommand(authKey: string, hostname: string, tag: string): string {
  return `tailscale up --auth-key=${quote(authKey)} --hostname=${quote(hostname)} --advertise-tags=${quote(tag)}`;
}

// An ephemeral node leaves the tailnet soon after its VM stops.
export async function rejoinTailnet(kind: Kind, instanceId: string, name: string): Promise<string | undefined> {
  const probe = "if ! command -v tailscale >/dev/null; then echo absent; elif tailscale status >/dev/null 2>&1; then echo up; else echo down; fi";
  const status = runCommand(kind, instanceId, probe).trim();
  if (status === "absent") return undefined;
  if (status !== "up") {
    const authKey = await tailnetKey(kind, name);
    if (!authKey || !kind.tailnet) return undefined;
    runCommand(kind, instanceId, upCommand(authKey, hostAlias(name), kind.tailnet.tag));
  }
  return tailnetAddress(kind, instanceId);
}

// Asking the VM sidesteps the -1 suffix a reused hostname gets.
export function tailnetAddress(kind: Kind, instanceId: string): string | undefined {
  try {
    return runCommand(kind, instanceId, "tailscale ip -4").trim().split("\n")[0] || undefined;
  } catch (error) {
    log(`the VM did not join the tailnet, so ${PREFIX} falls back to Session Manager: ${errorMessage(error)}`);
    return undefined;
  }
}
