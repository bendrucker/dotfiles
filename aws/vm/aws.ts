// An account through the aws CLI: instances by tag, and commands run on them
// through Session Manager.

import { z } from "zod";
import type { Account } from "./kinds.ts";
import { errorMessage, spawn, until } from "./process.ts";

export const NAME_TAG = "vm-name";
export const KIND_TAG = "vm-kind";
export const EXPIRES_TAG = "expires-at";

export const LIVE_STATES = ["pending", "running", "stopping", "stopped"];

export const RawInstance = z.object({
  InstanceId: z.string(),
  InstanceType: z.string(),
  State: z.object({ Name: z.string() }),
  LaunchTime: z.string(),
  // AWS omits the Tags field for an untagged instance.
  Tags: z.array(z.object({ Key: z.string(), Value: z.string() })).default([]),
});
export const Reservations = z.object({ Reservations: z.array(z.object({ Instances: z.array(RawInstance) })) });
export const Launched = z.object({ Instances: z.tuple([RawInstance]) });
export const InstanceInformation = z.object({ InstanceInformationList: z.array(z.object({ PingStatus: z.string() })) });
export const SentCommand = z.object({ Command: z.object({ CommandId: z.string() }) });
export const Invocation = z.object({
  Status: z.string(),
  StandardOutputContent: z.string().default(""),
  StandardErrorContent: z.string().default(""),
});

export function awsSpawn(account: Account, args: string[]): { status: number; stdout: string; stderr: string } {
  return spawn(["aws", ...args, "--profile", account.profile, "--region", account.region, "--output", "json"]);
}

// A command with nothing to report, like create-tags, is read with z.unknown().
export function aws<T>(account: Account, args: string[], schema: z.ZodType<T>): T {
  const result = awsSpawn(account, args);
  if (result.status !== 0) {
    const stderr = result.stderr.trim();
    throw new Error(`aws ${args.slice(0, 2).join(" ")} failed: ${stderr}${signInHint(account.profile, stderr)}`);
  }
  return parseOutput(args, result.stdout, schema);
}

// The profile is machine-local, since it names the account, so nothing in this
// repo installs it.
function signInHint(profile: string, stderr: string): string {
  const signIn = `aws sso login --profile ${profile}`;
  if (/config profile \(.*\) could not be found/.test(stderr)) {
    return `\nAdd a [profile ${profile}] stanza to ~/.aws/config with sso_session, sso_account_id, sso_role_name, and region, then sign in with: ${signIn}`;
  }
  const expired = /sso|token/i.test(stderr) && /expired|refresh|login/i.test(stderr);
  return expired ? `\nSign in with: ${signIn}` : "";
}

export interface Credentials {
  AccessKeyId: string;
  SecretAccessKey: string;
  SessionToken: string;
}

// A --profile flag outranks credentials in the environment, so this names no
// profile and drops any the caller exported.
export function awsAs<T>(credentials: Credentials, region: string, args: string[], schema: z.ZodType<T>): T {
  const result = spawn(["aws", ...args, "--region", region, "--output", "json"], {
    AWS_ACCESS_KEY_ID: credentials.AccessKeyId,
    AWS_SECRET_ACCESS_KEY: credentials.SecretAccessKey,
    AWS_SESSION_TOKEN: credentials.SessionToken,
    AWS_PROFILE: undefined,
    AWS_DEFAULT_PROFILE: undefined,
  });
  if (result.status !== 0) throw new Error(`aws ${args.slice(0, 2).join(" ")} failed: ${result.stderr.trim()}`);
  return parseOutput(args, result.stdout, schema);
}

function parseOutput<T>(args: string[], stdout: string, schema: z.ZodType<T>): T {
  try {
    return schema.parse(stdout.trim() ? JSON.parse(stdout) : undefined);
  } catch (error) {
    throw new Error(`aws ${args.slice(0, 2).join(" ")} returned unexpected output: ${errorMessage(error)}`);
  }
}

export interface Instance {
  id: string;
  name: string;
  kind: string;
  type: string;
  state: string;
  launchedAt: Date;
  expiresAt?: Date;
}

export function toInstance(raw: z.infer<typeof RawInstance>): Instance {
  const tags = new Map(raw.Tags.map((tag) => [tag.Key, tag.Value]));
  const expires = tags.get(EXPIRES_TAG);
  return {
    id: raw.InstanceId,
    name: tags.get(NAME_TAG) ?? "",
    kind: tags.get(KIND_TAG) ?? "",
    type: raw.InstanceType,
    state: raw.State.Name,
    launchedAt: new Date(raw.LaunchTime),
    expiresAt: expires ? new Date(expires) : undefined,
  };
}

export function instances(account: Account, name?: string): Instance[] {
  const filters = [`Name=instance-state-name,Values=${LIVE_STATES.join(",")}`];
  filters.push(name ? `Name=tag:${NAME_TAG},Values=${name}` : `Name=tag-key,Values=${NAME_TAG}`);
  const answer = aws(account, ["ec2", "describe-instances", "--filters", ...filters], Reservations);
  return answer.Reservations.flatMap((reservation) => reservation.Instances.map(toInstance));
}

export function runCommand(account: Account, instanceId: string, command: string): string {
  const sent = aws(account, [
    "ssm",
    "send-command",
    "--instance-ids",
    instanceId,
    "--document-name",
    "AWS-RunShellScript",
    "--parameters",
    JSON.stringify({ commands: [command] }),
  ], SentCommand);
  const commandId = sent.Command.CommandId;
  return until(`\`${command}\` on ${instanceId}`, () => {
    const args = ["ssm", "get-command-invocation", "--command-id", commandId, "--instance-id", instanceId];
    const invocation = awsSpawn(account, args);
    if (invocation.status !== 0) {
      // The invocation is not queryable for a moment after send-command returns.
      if (invocation.stderr.includes("InvocationDoesNotExist")) return undefined;
      throw new Error(`aws ssm get-command-invocation failed: ${invocation.stderr.trim()}`);
    }
    const answer = parseOutput(args, invocation.stdout, Invocation);
    if (["Pending", "InProgress", "Delayed"].includes(answer.Status)) return undefined;
    if (answer.Status !== "Success") {
      throw new Error(`\`${command}\` on ${instanceId} ended ${answer.Status}: ${answer.StandardErrorContent}`);
    }
    return answer.StandardOutputContent;
  });
}
