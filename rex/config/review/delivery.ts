import { createHash } from "node:crypto";
import { AGENT_AUTHOR, type Comment } from "./reviewer";

// State saved before edits were tracked has no hash.
export interface Delivered {
  id: string;
  hash?: string;
}

export type Event =
  | { kind: "comment" | "edited"; comment: Comment; context?: string; quote?: string }
  | { kind: "retracted"; id: string };

export function hash(body: string): string {
  return createHash("sha256").update(body).digest("hex").slice(0, 16);
}

function root(comment: Comment, byId: Map<string, Comment>): string {
  let current = comment;
  const seen = new Set<string>();
  while (current.parentId !== undefined && !seen.has(current.id)) {
    seen.add(current.id);
    const parent = byId.get(current.parentId);
    if (parent === undefined) return current.parentId;
    current = parent;
  }
  return current.id;
}

// The agent's reply a threaded note answers: its parent, or else the latest
// agent reply in its thread before it.
function context(comment: Comment, comments: Comment[]): string | undefined {
  if (comment.parentId === undefined) return undefined;
  const byId = new Map(comments.map((c) => [c.id, c]));
  const parent = byId.get(comment.parentId);
  if (parent?.author === AGENT_AUTHOR) return parent.body;
  const thread = root(comment, byId);
  const before = comments.slice(0, comments.indexOf(comment));
  return before.findLast((c) => c.author === AGENT_AUTHOR && root(c, byId) === thread)?.body;
}

// Compares the user's notes with what was delivered. `complete` says the list
// is the same record the delivered ids came from, so a missing id was deleted.
export function reconcile(
  comments: Comment[],
  delivered: Delivered[],
  complete: boolean,
): { events: Event[]; delivered: Delivered[] } {
  const mine = comments.filter((c) => c.author !== AGENT_AUTHOR);
  const present = new Set(mine.map((c) => c.id));
  const previous = new Map(delivered.map((d) => [d.id, d]));
  const events: Event[] = [];
  const next: Delivered[] = [];

  for (const d of delivered) {
    if (present.has(d.id)) continue;
    if (complete) events.push({ kind: "retracted", id: d.id });
    else next.push(d);
  }
  for (const comment of mine) {
    const sum = hash(comment.body);
    const before = previous.get(comment.id);
    if (before === undefined) events.push({ kind: "comment", comment, context: context(comment, comments) });
    else if (before.hash !== undefined && before.hash !== sum)
      events.push({ kind: "edited", comment, context: context(comment, comments) });
    next.push({ id: comment.id, hash: sum });
  }
  return { events, delivered: next };
}

// Delivered notes no agent note follows in the same thread.
export function unanswered(comments: Comment[], delivered: Delivered[]): string[] {
  const byId = new Map(comments.map((c) => [c.id, c]));
  return delivered
    .map((d) => byId.get(d.id))
    .filter((c): c is Comment => c !== undefined)
    .filter((c) => {
      const thread = root(c, byId);
      const after = comments.slice(comments.indexOf(c) + 1);
      return !after.some((n) => n.author === AGENT_AUTHOR && root(n, byId) === thread);
    })
    .map((c) => c.id);
}
