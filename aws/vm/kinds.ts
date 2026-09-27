import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { parseDuration } from "./duration.ts";
import { errorMessage, UsageError } from "./process.ts";

export interface Account {
  profile: string;
  region: string;
}

export interface Kind extends Account {
  name: string;
  template: string;
  defaultTtl: number;
  maxTtl: number;
  tailnet?: { tag: string; secret: string };
  // mise tools added to the shipped set, by backend and version.
  tools: Record<string, string>;
}

const KindFields = z
  .object({
    profile: z.string(),
    region: z.string(),
    template: z.string(),
    default_ttl: z.string().default("4h"),
    max_ttl: z.string().default("12h"),
    tailnet_tag: z.string().optional(),
    tailnet_secret: z.string().optional(),
    tools: z.record(z.string(), z.string()).default({}),
  })
  .refine((kind) => (kind.tailnet_tag === undefined) === (kind.tailnet_secret === undefined), {
    message: "tailnet_tag and tailnet_secret go together",
  });

const KindsFile = z.object({ default: z.string().optional(), kinds: z.record(z.string(), KindFields).default({}) });

export interface Kinds {
  default: string;
  byName: Map<string, Kind>;
}

function toKind(name: string, fields: z.infer<typeof KindFields>): Kind {
  const kind: Kind = {
    name,
    profile: fields.profile,
    region: fields.region,
    template: fields.template,
    defaultTtl: parseDuration(fields.default_ttl),
    maxTtl: parseDuration(fields.max_ttl),
    tools: fields.tools,
  };
  if (kind.defaultTtl > kind.maxTtl) throw new Error(`kind ${name}: default_ttl exceeds max_ttl`);
  if (fields.tailnet_tag && fields.tailnet_secret) kind.tailnet = { tag: fields.tailnet_tag, secret: fields.tailnet_secret };
  return kind;
}

function readKinds(path: string): z.infer<typeof KindsFile> {
  try {
    return KindsFile.parse(Bun.TOML.parse(readFileSync(path, "utf8")));
  } catch (error) {
    throw new Error(`${path}: ${errorMessage(error)}`);
  }
}

export function localKindsPath(): string {
  const config = process.env.XDG_CONFIG_HOME || join(process.env.HOME || homedir(), ".config");
  return join(config, "vm", "kinds.toml");
}

// A local kind replaces a shipped one of the same name whole.
export function loadKinds(paths = [join(import.meta.dir, "kinds.toml"), localKindsPath()]): Kinds {
  const byName = new Map<string, Kind>();
  let fallback: string | undefined;
  for (const path of paths.filter((candidate) => existsSync(candidate))) {
    const file = readKinds(path);
    fallback = file.default ?? fallback;
    for (const [name, fields] of Object.entries(file.kinds)) byName.set(name, toKind(name, fields));
  }
  if (!fallback || !byName.has(fallback)) throw new Error(`no default kind is defined (looked in ${paths.join(", ")})`);
  return { default: fallback, byName };
}

export function kind(kinds: Kinds, name: string): Kind {
  const found = kinds.byName.get(name);
  if (!found) throw new UsageError(`no kind named ${name}; defined: ${[...kinds.byName.keys()].join(", ")}`);
  return found;
}

// Kinds sharing a profile and region share an account, which is listed once.
export function accounts(kinds: Kinds): Kind[] {
  const seen = new Map<string, Kind>();
  for (const entry of kinds.byName.values()) {
    const key = `${entry.profile}@${entry.region}`;
    if (!seen.has(key)) seen.set(key, entry);
  }
  return [...seen.values()];
}
