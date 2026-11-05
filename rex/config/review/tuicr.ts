import { z } from "zod";
import { AGENT_AUTHOR, type Comment, type Comments, type Reviewer } from "./reviewer";

const Session = z.object({
  slug: z.string(),
  kind: z.string(),
  updated_at: z.string(),
  active: z.boolean(),
});

const TuicrComment = z.object({
  id: z.string(),
  author: z.string().nullish(),
  path: z.string().nullish(),
  start_line: z.number().nullish(),
  end_line: z.number().nullish(),
  side: z.enum(["old", "new"]).nullish(),
  content: z.string(),
});

async function tuicr(args: string[], cwd: string): Promise<string> {
  const child = Bun.spawn(["tuicr", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`tuicr ${args.slice(0, 2).join(" ")} exited ${code}: ${stderr.trim()}`);
  return stdout;
}

// The session a running tuicr has open, else the one an earlier call found.
// The most recently updated session can be a stale one from an earlier commit.
async function session(cwd: string, known?: string): Promise<string> {
  const sessions = z.array(Session).parse(JSON.parse(await tuicr(["review", "list"], cwd)));
  const open = sessions
    .filter((s) => s.kind === "local" && s.active)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
  const slug = open?.slug ?? known;
  if (slug === undefined) throw new Error(`no open tuicr review in ${cwd}`);
  return slug;
}

function normalize(c: z.infer<typeof TuicrComment>): Comment {
  return {
    id: c.id,
    author: c.author ?? "user",
    path: c.path ?? undefined,
    startLine: c.start_line ?? undefined,
    endLine: c.end_line ?? undefined,
    side: c.side ?? undefined,
    body: c.content,
  };
}

function location(comment: Comment): string[] {
  if (comment.path === undefined) return [];
  const args = ["--target-file", comment.path];
  if (comment.startLine === undefined) return args;
  args.push("--line", String(comment.startLine), "--side", comment.side ?? "new");
  if (comment.endLine !== undefined && comment.endLine !== comment.startLine) {
    args.push("--end-line", String(comment.endLine));
  }
  return args;
}

export const reviewer: Reviewer = {
  command(revisions) {
    return revisions === undefined
      ? ["tuicr", "--no-update-check", "-w"]
      : ["tuicr", "--no-update-check", "-r", revisions, "-w"];
  },

  // tuicr writes the session each time a comment is saved.
  async flush() {},

  async comments(cwd, known): Promise<Comments> {
    const slug = await session(cwd, known);
    const raw: unknown = JSON.parse(await tuicr(["review", "comments", "--session", slug], cwd));
    return { session: slug, comments: z.array(TuicrComment).parse(raw).map(normalize) };
  },

  // tuicr/config.toml sets diff_watch_interval_ms, and tuicr polls the session
  // for comments added from outside.
  async reload() {},

  async reply(cwd, slug, comment, text) {
    await tuicr(["review", "add", "--session", slug, "--username", AGENT_AUTHOR, ...location(comment), text], cwd);
  },
};
