// The performance account through the aws CLI: instances by tag, and commands
// run on them through Session Manager.

import { z } from "zod";
import { spawn, until } from "./process.ts";

export const REGION = "us-east-1";
export const NAME_TAG = "perf-vm";
export const EXPIRES_TAG = "expires-at";

export const LIVE_STATES = ["pending", "running", "stopping", "stopped"];

export function profile(): string {
  return process.env.PERF_VM_PROFILE || "performance-admin";
}

export const RawInstance = z.object({
  InstanceId: z.string(),
  InstanceType: z.string(),
  State: z.object({ Name: z.string() }),
  LaunchTime: z.string(),
  // AWS leaves the list out of an untagged instance rather than sending it empty.
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

export function awsSpawn(args: string[]): { status: number; stdout: string; stderr: string } {
  return spawn(["aws", ...args, "--profile", profile(), "--region", REGION, "--output", "json"]);
}

// A command with nothing to report, like create-tags, is read with z.unknown().
export function aws<T>(args: string[], schema: z.ZodType<T>): T {
  const result = awsSpawn(args);
  if (result.status !== 0) {
    const stderr = result.stderr.trim();
    const expired = /sso|token/i.test(stderr) && /expired|refresh|login/i.test(stderr);
    const hint = expired ? "\nSign in with: aws sso login --profile " + profile() : "";
    throw new Error(`aws ${args.slice(0, 2).join(" ")} failed: ${stderr}${hint}`);
  }
  return schema.parse(result.stdout.trim() ? JSON.parse(result.stdout) : undefined);
}

export interface Instance {
  id: string;
  name: string;
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
    type: raw.InstanceType,
    state: raw.State.Name,
    launchedAt: new Date(raw.LaunchTime),
    expiresAt: expires ? new Date(expires) : undefined,
  };
}

export function instances(name?: string): Instance[] {
  const filters = [`Name=instance-state-name,Values=${LIVE_STATES.join(",")}`];
  filters.push(name ? `Name=tag:${NAME_TAG},Values=${name}` : `Name=tag-key,Values=${NAME_TAG}`);
  const answer = aws(["ec2", "describe-instances", "--filters", ...filters], Reservations);
  return answer.Reservations.flatMap((reservation) => reservation.Instances.map(toInstance));
}

export function runCommand(instanceId: string, command: string): string {
  const sent = aws([
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
    const invocation = awsSpawn(["ssm", "get-command-invocation", "--command-id", commandId, "--instance-id", instanceId]);
    // The invocation is not queryable for a moment after send-command returns.
    if (invocation.status !== 0) return undefined;
    const answer = Invocation.parse(JSON.parse(invocation.stdout));
    if (["Pending", "InProgress", "Delayed"].includes(answer.Status)) return undefined;
    if (answer.Status !== "Success") {
      throw new Error(`\`${command}\` on ${instanceId} ended ${answer.Status}: ${answer.StandardErrorContent}`);
    }
    return answer.StandardOutputContent;
  });
}
