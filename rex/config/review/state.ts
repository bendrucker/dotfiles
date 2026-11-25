import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Status } from "./hunk-extension";

export type { Status } from "./hunk-extension";

// A bare id, or one saved with a body hash, is a delivery recorded before
// versions were tracked.
const Delivered = z.union([
  z.string().transform((id) => ({ id })),
  z.object({ id: z.string(), version: z.string().optional() }),
]);

const Review = z.object({
  id: z.string(),
  session: z.string(),
  agent: z.string(),
  review: z.string().optional(),
  cwd: z.string(),
  reviewer: z.enum(["hunk", "plannotator", "tuicr"]),
  base: z.string().optional(),
  doc: z.string().optional(),
  reviewerSession: z.string().optional(),
  // The reviewer process `run` spawned, while it runs.
  pid: z.number().optional(),
  delivered: z.array(Delivered),
  mode: z.enum(["live", "batch"]).default("live"),
  held: z.boolean().default(false),
  outcome: z.enum(["approved", "closed", "dismissed", "failed"]).optional(),
});

export type Review = z.infer<typeof Review>;

// init.lua builds this same path from $HOME, ignoring XDG_STATE_HOME.
export function stateDir(): string {
  return join(process.env.HOME ?? "", ".local", "state", "rex-review");
}

const LOCK_RETRY_MS = 50;
// A lock older than this belongs to a process that died holding it.
const LOCK_STALE_MS = 30_000;

// Serializes read-modify-write of one review across processes. mkdir is atomic.
export async function locked<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const lock = join(stateDir(), `${id}.lock`);
  mkdirSync(stateDir(), { recursive: true });
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmSync(lock, { recursive: true, force: true });
      } catch {
        // The lock vanished or is held: retry after the sleep.
      }
      await Bun.sleep(LOCK_RETRY_MS);
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

function reviewPath(id: string): string {
  return join(stateDir(), `${id}.json`);
}

// One file per pane, named for its block and holding the review's id.
// init.lua checks a key's pane with a single io.open.
function blockPath(block: string): string {
  return join(stateDir(), "blocks", block);
}

const EVENTS = ".events";
const STATUS = ".status.json";
const SIDECARS = [EVENTS, STATUS];

// The agent's watcher tails this file. Each line is one event.
function eventsPath(block: string): string {
  return blockPath(`${block}${EVENTS}`);
}

// The Hunk extension reads this for its status line.
export function statusPath(block: string): string {
  return blockPath(`${block}${STATUS}`);
}

export function writeStatus(block: string, status: Status): void {
  mkdirSync(join(stateDir(), "blocks"), { recursive: true });
  writeAtomic(statusPath(block), `${JSON.stringify(status)}\n`);
}

export function resetEvents(block: string): void {
  mkdirSync(join(stateDir(), "blocks"), { recursive: true });
  writeFileSync(eventsPath(block), "");
}

export function appendEvent(block: string, line: string): void {
  mkdirSync(join(stateDir(), "blocks"), { recursive: true });
  appendFileSync(eventsPath(block), `${line}\n`);
}

function blocks(review: Review): string[] {
  return [review.agent, review.review].filter((b): b is string => b !== undefined);
}

function writeAtomic(path: string, text: string): void {
  writeFileSync(`${path}.tmp`, text);
  renameSync(`${path}.tmp`, path);
}

export function save(review: Review): void {
  mkdirSync(join(stateDir(), "blocks"), { recursive: true });
  writeAtomic(reviewPath(review.id), `${JSON.stringify(review, null, 2)}\n`);
  for (const block of blocks(review)) writeAtomic(blockPath(block), review.id);
}

export function load(id: string): Review | undefined {
  let text: string;
  try {
    text = readFileSync(reviewPath(id), "utf8");
  } catch {
    return undefined;
  }
  return Review.parse(JSON.parse(text));
}

export function resolve(block: string): Review | undefined {
  let id: string;
  try {
    id = readFileSync(blockPath(block), "utf8").trim();
  } catch {
    return undefined;
  }
  const review = load(id);
  if (review === undefined) rmSync(blockPath(block), { force: true });
  return review;
}

export function remove(review: Review): void {
  for (const block of blocks(review)) rmSync(blockPath(block), { force: true });
  rmSync(statusPath(review.agent), { force: true });
  rmSync(reviewPath(review.id), { force: true });
}

// Drops reviews and block files naming a block that no longer exists, as
// after a Rex restart.
export function prune(live: Set<string>): void {
  let names: string[];
  try {
    names = readdirSync(stateDir());
  } catch {
    return;
  }
  for (const name of names.filter((n) => n.endsWith(".json"))) {
    let review: Review | undefined;
    try {
      review = load(name.slice(0, -".json".length));
    } catch {
      continue;
    }
    if (review !== undefined && blocks(review).some((b) => !live.has(b))) remove(review);
  }
  let files: string[];
  try {
    files = readdirSync(join(stateDir(), "blocks"));
  } catch {
    return;
  }
  for (const name of files) {
    const sidecar = SIDECARS.find((suffix) => name.endsWith(suffix));
    if (sidecar !== undefined) {
      if (!live.has(name.slice(0, -sidecar.length))) rmSync(blockPath(name), { force: true });
    } else if (!live.has(name) || resolve(name) === undefined) rmSync(blockPath(name), { force: true });
  }
}
