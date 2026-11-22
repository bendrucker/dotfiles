// The author an adapter stamps on the agent's replies. A send skips these.
export const AGENT_AUTHOR = "Claude";

export interface Comment {
  id: string;
  author: string;
  // The note this one replies to, when the reviewer threads replies.
  parentId?: string;
  path?: string;
  startLine?: number;
  endLine?: number;
  side?: "old" | "new";
  body: string;
}

// `session` names the reviewer's own record of the review. Later calls pass it
// back to reach the same record after the reviewer exits.
export interface Comments {
  session: string;
  comments: Comment[];
}

export interface Reviewer {
  // Notes vanish when the reviewer exits, so `run` snapshots them while it runs.
  ephemeral: boolean;
  command(revisions?: string): string[];
  flush(block: string): Promise<void>;
  // Includes the agent's replies. `strict` fails rather than fall back to
  // another record when `session` is gone.
  comments(cwd: string, session?: string, strict?: boolean): Promise<Comments>;
  // The unified diff the reviewer shows, keyed by path.
  patches?(cwd: string, session: string): Promise<Record<string, string>>;
  reload(block: string): Promise<void>;
  reply(cwd: string, session: string, comment: Comment, text: string): Promise<void>;
}
