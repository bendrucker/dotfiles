// The launcher mints each VM's auth key itself, so no Tailscale credential
// reaches a VM. It authenticates as the kind's role: STS signs a token for the
// federated identity's audience, and Tailscale exchanges that token for an
// access token scoped to auth keys.

import { z } from "zod";
import { aws, awsAs, runCommand } from "./aws.ts";
import type { Kind, Tailnet } from "./kinds.ts";
import { hostAlias, PREFIX, quote } from "./ssh.ts";
import { errorMessage, log } from "./process.ts";

const Parameters = z.object({
  Parameters: z.array(z.object({ Name: z.string(), Value: z.string() })),
  InvalidParameters: z.array(z.string()).default([]),
});
const CallerIdentity = z.object({ Account: z.string() });
const AssumedRole = z.object({
  Credentials: z.object({ AccessKeyId: z.string(), SecretAccessKey: z.string(), SessionToken: z.string() }),
});
const IdentityToken = z.object({ WebIdentityToken: z.string() });
const AccessToken = z.object({ access_token: z.string() });

function identityToken(kind: Kind, tailnet: Tailnet, audience: string, name: string): string {
  const { Account } = aws(kind, ["sts", "get-caller-identity"], CallerIdentity);
  const roleArn = `arn:aws:iam::${Account}:role${tailnet.role}`;
  const { Credentials } = aws(kind, ["sts", "assume-role", "--role-arn", roleArn, "--role-session-name", hostAlias(name)], AssumedRole);
  const args = ["sts", "get-web-identity-token", "--audience", audience, "--signing-algorithm", "RS256"];
  return awsAs(Credentials, kind.region, args, IdentityToken).WebIdentityToken;
}

async function exchangeToken(api: string, clientId: string, jwt: string): Promise<string> {
  const response = await fetch(`${api}/api/v2/oauth/token-exchange`, {
    method: "POST",
    body: new URLSearchParams({ client_id: clientId, jwt }),
  });
  if (!response.ok) throw new Error(`Tailscale token exchange failed: ${response.status} ${await response.text()}`);
  return AccessToken.parse(await response.json()).access_token;
}

export async function mintAuthKey(token: string, tag: string, description: string, api: string): Promise<string> {
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

// A kind with no tailnet, a missing parameter, or any failure on the way to a
// key launches an SSM-only VM.
export async function tailnetKey(kind: Kind, name: string): Promise<string | undefined> {
  if (!kind.tailnet) return undefined;
  const { tailnet } = kind;
  const api = process.env.VM_TAILSCALE_API || "https://api.tailscale.com";
  try {
    const names = [tailnet.clientIdParameter, tailnet.audienceParameter];
    const read = aws(kind, ["ssm", "get-parameters", "--names", ...names], Parameters);
    const values = new Map(read.Parameters.map((parameter) => [parameter.Name, parameter.Value]));
    const [clientId, audience] = names.map((parameter) => values.get(parameter));
    if (!clientId || !audience) {
      const missing = names.filter((parameter) => !values.has(parameter));
      log(`no ${missing.join(" or ")} parameter, so this VM is reachable through Session Manager only`);
      return undefined;
    }
    const token = await exchangeToken(api, clientId, identityToken(kind, tailnet, audience, name));
    return await mintAuthKey(token, tailnet.tag, hostAlias(name), api);
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
