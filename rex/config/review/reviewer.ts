// The author an adapter stamps on the agent's replies. A send skips these.
export const AGENT_AUTHOR = "Claude";

export interface Comment {
  id: string;
  author: string;
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
  command(revisions?: string): string[];
  flush(block: string): Promise<void>;
  comments(cwd: string, session?: string): Promise<Comments>;
  reload(block: string): Promise<void>;
  reply(cwd: string, session: string, comment: Comment, text: string): Promise<void>;
}
