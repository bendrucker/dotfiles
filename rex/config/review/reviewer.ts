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
  // The text a note anchors to, when the reviewer records it.
  quote?: string;
  body: string;
  // Changes when the note is edited. A note without one is never redelivered.
  version?: string;
}

// What a review covers: a diff in `cwd`, or one document.
export interface Target {
  cwd: string;
  // A ref the diff runs from, to the working tree.
  base?: string;
  doc?: string;
  // The reviewer process `run` spawned, whose record is the only one to read.
  pid?: number;
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
  // `result` is where a gated reviewer writes its decision.
  command(target: Target, result: string): string[];
  flush(block: string): Promise<void>;
  // Includes the agent's replies. `strict` fails rather than fall back to
  // another record when `session` is gone.
  comments(target: Target, session?: string, strict?: boolean): Promise<Comments>;
  // The unified diff the reviewer shows, keyed by path.
  patches?(target: Target, session: string): Promise<Record<string, string>>;
  reload(block: string): Promise<void>;
  reply(target: Target, session: string, comment: Comment, text: string): Promise<void>;
  // The decision a gated reviewer wrote to `result`, if any.
  decision?(result: string): "approved" | "dismissed" | undefined;
}
