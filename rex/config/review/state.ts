import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const Review = z.object({
  id: z.string(),
  session: z.string(),
  agent: z.string(),
  review: z.string().optional(),
  cwd: z.string(),
  reviewer: z.enum(["hunk", "tuicr"]),
  revisions: z.string().optional(),
  reviewerSession: z.string().optional(),
  delivered: z.array(z.string()),
  outcome: z.enum(["approved", "dismissed", "failed"]).optional(),
});

export type Review = z.infer<typeof Review>;

// init.lua builds this same path from $HOME, ignoring XDG_STATE_HOME.
export function stateDir(): string {
  return join(process.env.HOME ?? "", ".local", "state", "rex-review");
}

function reviewPath(id: string): string {
  return join(stateDir(), `${id}.json`);
}

// One file per pane, named for its block and holding the review's id.
// init.lua checks a key's pane with a single io.open.
function blockPath(block: string): string {
  return join(stateDir(), "blocks", block);
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
  rmSync(reviewPath(review.id), { force: true });
}
