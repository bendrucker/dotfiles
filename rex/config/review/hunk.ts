import { realpathSync } from "node:fs";
import { z } from "zod";
import { AGENT_AUTHOR, type Comment, type Comments, type Reviewer } from "./reviewer";

const Sessions = z.object({
  sessions: z.array(z.object({ sessionId: z.string(), cwd: z.string(), launchedAt: z.string() })),
});

const Range = z.tuple([z.number(), z.number()]);

const Note = z.object({
  noteId: z.string(),
  source: z.string(),
  filePath: z.string().nullish(),
  oldRange: Range.nullish(),
  newRange: Range.nullish(),
  body: z.string(),
  author: z.string().nullish(),
});

const Notes = z.object({ comments: z.array(Note) });

async function hunk(args: string[], cwd: string): Promise<string> {
  const child = Bun.spawn(["hunk", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`hunk ${args.slice(0, 3).join(" ")} exited ${code}: ${stderr.trim()}`);
  return stdout;
}

// Notes live in the Hunk window, so the session must still be open. `run`
// launches Hunk in the review's directory, which the daemon reports resolved.
async function session(cwd: string, known?: string): Promise<string> {
  const { sessions } = Sessions.parse(JSON.parse(await hunk(["session", "list", "--json"], cwd)));
  if (known !== undefined && sessions.some((s) => s.sessionId === known)) return known;
  const dir = realpathSync(cwd);
  const open = sessions.filter((s) => s.cwd === dir).sort((a, b) => b.launchedAt.localeCompare(a.launchedAt))[0];
  if (open === undefined) throw new Error(`no open Hunk window in ${cwd}`);
  return open.sessionId;
}

function normalize(note: z.infer<typeof Note>): Comment {
  const range = note.newRange ?? note.oldRange;
  return {
    id: note.noteId,
    author: note.author ?? note.source,
    path: note.filePath ?? undefined,
    startLine: range?.[0],
    endLine: range?.[1],
    side: note.newRange ? "new" : note.oldRange ? "old" : undefined,
    body: note.body,
  };
}

export const reviewer: Reviewer = {
  // A revisions string like `main..HEAD` is one Hunk target.
  command(revisions) {
    const target = revisions === undefined ? [] : [revisions];
    return ["hunk", "diff", ...target, "--watch", "--agent-notes"];
  },

  // Hunk keeps a note in the window from the moment it is saved.
  async flush() {},

  // Agent notes and replies are skipped. Only notes the user wrote are comments.
  async comments(cwd, known): Promise<Comments> {
    const id = await session(cwd, known);
    const raw: unknown = JSON.parse(await hunk(["session", "comment", "list", id, "--type", "user", "--json"], cwd));
    return { session: id, comments: Notes.parse(raw).comments.map(normalize) };
  },

  // `--watch` reloads the diff, and a reply shows up as soon as it is added.
  async reload() {},

  async reply(cwd, id, comment, text) {
    await hunk(
      ["session", "comment", "add", id, "--reply-to", comment.id, "--summary", text, "--author", AGENT_AUTHOR],
      cwd,
    );
  },
};
