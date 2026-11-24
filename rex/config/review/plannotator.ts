import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { connect } from "node:net";
import { isAbsolute, join, relative } from "node:path";
import { z } from "zod";
import { AGENT_AUTHOR, type Comment, type Comments, type Reviewer, type Target } from "./reviewer";

const DiffStore = z.object({
  repo: z.string(),
  scope: z.object({ kind: z.string() }),
  annotations: z.array(
    z.object({
      id: z.string(),
      filePath: z.string().nullish(),
      lineStart: z.number().nullish(),
      lineEnd: z.number().nullish(),
      side: z.enum(["old", "new"]).nullish(),
      text: z.string(),
      authorName: z.string().nullish(),
      createdAt: z.number().nullish(),
      plannotator_tui: z.object({ updatedAt: z.number().nullish() }).nullish(),
    }),
  ),
});

const DocStore = z.object({
  path: z.string(),
  annotations: z.array(
    z.object({
      id: z.string(),
      body: z.string(),
      anchor: z
        .object({
          quote: z.string().nullish(),
          // A byte offset into the document as it was when the note was left.
          plannotator_tui: z.object({ source: z.object({ start: z.number() }).nullish() }).nullish(),
        })
        .nullish(),
      author_name: z.string().nullish(),
      created_at: z.string().nullish(),
      updated_at: z.string().nullish(),
    }),
  ),
});

// A running plannotator-tui's entry in its registry. It takes notes over loopback TCP.
const Entry = z.object({ pid: z.number(), port: z.number(), token: z.string(), files: z.array(z.string()) });

type Entry = z.infer<typeof Entry>;

const Answer = z.object({ ok: z.boolean(), code: z.string().optional(), message: z.string().optional() });

type Answer = z.infer<typeof Answer>;

interface NoteRequest {
  file: string;
  quote?: string;
  line?: number;
}

// plannotator-tui answers `busy` while the reviewer types a note.
const BUSY_RETRY_MS = Number(process.env.REVIEW_NOTE_RETRY_MS ?? 250);
const BUSY_TRIES = 40;

const Result = z.object({ decision: z.string() });

function clientDir(): string {
  return join(process.env.HOME ?? "", ".plannotator", "clients", "plannotator-tui");
}

function storeDir(target: Target): string {
  return join(clientDir(), target.doc === undefined ? "reviews" : "annotations");
}

function list(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function parse<T>(schema: z.ZodType<T>, path: string): T {
  return schema.parse(JSON.parse(readFileSync(path, "utf8")));
}

function matches(target: Target, path: string): boolean {
  try {
    if (target.doc !== undefined) return real(parse(DocStore, path).path) === real(target.doc);
    const diffStore = parse(DiffStore, path);
    return real(diffStore.repo) === real(target.cwd) && (diffStore.scope.kind === "uncommitted") === (target.revisions === undefined);
  } catch {
    return false;
  }
}

// Stores sit two levels down, as <group>/<scope>-<hash>/<file>.
function store(target: Target, known?: string, strict = false): string {
  if (known !== undefined && existsSync(known)) return known;
  if (known !== undefined && strict) throw new Error(`plannotator store ${known} is gone`);
  const base = storeDir(target);
  const file = target.doc === undefined ? "review.json" : "annotations.json";
  const found = list(base)
    .flatMap((group) => list(join(base, group)).map((entry) => join(base, group, entry, file)))
    .filter((path) => existsSync(path) && matches(target, path))
    .toSorted((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  if (found === undefined) throw new Error(`no plannotator notes for ${target.doc ?? target.cwd}`);
  return found;
}

function author(name: string | null | undefined): string {
  return name === AGENT_AUTHOR ? AGENT_AUTHOR : "user";
}

function version(stamp: string | number | null | undefined): string | undefined {
  return stamp === null || stamp === undefined ? undefined : String(stamp);
}

// The agent's reply is a sibling note on the anchor it answers, so it threads
// under the latest earlier note there.
function thread(comments: Comment[]): Comment[] {
  return comments.map((comment, i) => {
    if (comment.author !== AGENT_AUTHOR) return comment;
    const before = comments.slice(0, i).filter((c) => c.author !== AGENT_AUTHOR && c.path === comment.path);
    const parent = before.findLast((c) => c.startLine === comment.startLine && c.quote === comment.quote) ?? before.at(-1);
    return { ...comment, parentId: parent?.id };
  });
}

function diffComments(path: string): Comment[] {
  return thread(
    parse(DiffStore, path).annotations.map((a) => ({
      id: a.id,
      author: author(a.authorName),
      path: a.filePath ?? undefined,
      startLine: a.lineStart ?? undefined,
      endLine: a.lineEnd ?? undefined,
      side: a.side ?? undefined,
      body: a.text,
      version: version(a.plannotator_tui?.updatedAt ?? a.createdAt),
    })),
  );
}

function docComments(cwd: string, path: string): Comment[] {
  const doc = parse(DocStore, path);
  const inside = relative(real(cwd), real(doc.path));
  const shown = inside.startsWith("..") || isAbsolute(inside) ? doc.path : inside;
  return thread(
    doc.annotations.map((a) => ({
      id: a.id,
      author: author(a.author_name),
      path: shown,
      quote: a.anchor?.quote ?? undefined,
      body: a.body,
      version: version(a.updated_at ?? a.created_at),
    })),
  );
}

// A diff note answers on its new-side line, or else on the whole file.
function diffAnchor(target: Target, comment: Comment): NoteRequest {
  if (comment.path === undefined) throw new Error(`note ${comment.id} has no file`);
  const file = join(real(target.cwd), comment.path);
  return comment.side === "new" && comment.startLine !== undefined ? { file, line: comment.startLine } : { file };
}

// A doc note answers on its quote, nearest the line it was left on.
function docAnchor(doc: string, path: string, comment: Comment): NoteRequest {
  const annotation = parse(DocStore, path).annotations.find((a) => a.id === comment.id);
  if (annotation === undefined) throw new Error(`no note ${comment.id} in ${path}`);
  const start = annotation.anchor?.plannotator_tui?.source?.start;
  let line: number | undefined;
  if (start !== undefined) {
    try {
      const before = readFileSync(doc).subarray(0, start).toString("utf8");
      line = before.split("\n").length;
    } catch {
      // An unreadable doc leaves the note anchored by its quote alone.
    }
  }
  return { file: doc, quote: annotation.anchor?.quote ?? undefined, line };
}

function entries(): Entry[] {
  const dir = join(clientDir(), "sessions", "tui");
  return list(dir).flatMap((name) => {
    try {
      return [parse(Entry, join(dir, name))];
    } catch {
      return [];
    }
  });
}

// The TUI `run` spawned, then any other that has the file open.
function candidates(target: Target, file: string): Entry[] {
  const all = entries();
  const own = all.filter((e) => e.pid === target.pid);
  const others = all.filter((e) => e.pid !== target.pid && e.files.some((f) => real(f) === real(file)));
  return [...own, ...others];
}

// Sends one request line and reads one answer line.
async function ask(port: number, request: object): Promise<Answer> {
  const socket = connect({ host: "127.0.0.1", port });
  socket.setEncoding("utf8");
  socket.write(`${JSON.stringify(request)}\n`);
  let text = "";
  try {
    for await (const chunk of socket) {
      text += String(chunk);
      if (text.includes("\n")) break;
    }
  } finally {
    socket.destroy();
  }
  return Answer.parse(JSON.parse(text.split("\n")[0]));
}

async function note(entry: Entry, request: object): Promise<Answer> {
  for (let tries = 1; ; tries++) {
    const answer = await ask(entry.port, { v: 1, token: entry.token, op: "note", ...request });
    if (answer.code !== "busy" || tries >= BUSY_TRIES) return answer;
    await Bun.sleep(BUSY_RETRY_MS);
  }
}

// plannotator-tui diffs from one base ref, so a range has to end at HEAD.
function baseRef(revisions: string): string {
  const range = /^(.+?)\.{2,3}(?:HEAD)?$/.exec(revisions);
  if (range !== null) return range[1];
  if (revisions.includes("..")) throw new Error(`plannotator-tui reviews from a base ref, not the range ${revisions}`);
  return revisions;
}

export const reviewer: Reviewer = {
  ephemeral: false,

  command({ revisions, doc }, result) {
    if (doc !== undefined) return ["plannotator-tui", doc, "--gate", "--json", "--require-approval", "--result-file", result];
    return ["plannotator-tui", "review", ...(revisions === undefined ? [] : ["--base", baseRef(revisions)])];
  },

  async flush() {
    // plannotator-tui rewrites its store on every save.
  },

  async comments(target, known, strict): Promise<Comments> {
    const path = store(target, known, strict);
    return { session: path, comments: target.doc === undefined ? diffComments(path) : docComments(target.cwd, path) };
  },

  async reload() {
    // Nothing to do.
  },

  // plannotator-tui adds the reply as its own note, which keeps it across saves.
  async reply(target, path, comment, text) {
    const anchor = target.doc === undefined ? diffAnchor(target, comment) : docAnchor(target.doc, path, comment);
    const request = { ...anchor, note: text, author: AGENT_AUTHOR };
    let reason = "no running plannotator-tui has it open";
    for (const entry of candidates(target, anchor.file)) {
      let answer: Answer;
      try {
        answer = await note(entry, request);
        // The agent may have edited the quoted text away. The line still places it.
        if (answer.code === "quote_not_found" && anchor.line !== undefined) answer = await note(entry, { ...request, quote: undefined });
      } catch (error) {
        reason = error instanceof Error ? error.message : String(error);
        continue;
      }
      if (answer.ok) return;
      reason = `${answer.code ?? "failed"}: ${answer.message ?? ""}`;
      if (answer.code !== "not_open") break;
    }
    throw new Error(`plannotator-tui took no reply on ${anchor.file}: ${reason}`);
  },

  watch: storeDir,

  decision(result) {
    let decision: string;
    try {
      decision = parse(Result, result).decision;
    } catch {
      return undefined;
    }
    if (decision === "approved" || decision === "approved-with-notes") return "approved";
    if (decision === "dismissed") return "dismissed";
    return undefined;
  },
};
