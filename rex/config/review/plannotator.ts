import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
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
    }),
  ),
});

const DocStore = z.object({
  path: z.string(),
  annotations: z.array(
    z.object({
      id: z.string(),
      body: z.string(),
      anchor: z.object({ quote: z.string().nullish() }).nullish(),
      replies: z.array(z.object({ id: z.string(), body: z.string(), author: z.string().nullish() })).default([]),
    }),
  ),
});

// Keeps the fields plannotator-tui writes that the reply leaves alone.
const WritableDocStore = z.looseObject({
  annotations: z.array(z.looseObject({ id: z.string(), replies: z.array(z.unknown()).default([]) })),
});

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
    const store = parse(DiffStore, path);
    return real(store.repo) === real(target.cwd) && (store.scope.kind === "uncommitted") === (target.revisions === undefined);
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

function diffComments(path: string): Comment[] {
  return parse(DiffStore, path).annotations.map((a) => ({
    id: a.id,
    author: "user",
    path: a.filePath ?? undefined,
    startLine: a.lineStart ?? undefined,
    endLine: a.lineEnd ?? undefined,
    side: a.side ?? undefined,
    body: a.text,
  }));
}

function docComments(cwd: string, path: string): Comment[] {
  const doc = parse(DocStore, path);
  const inside = relative(real(cwd), real(doc.path));
  const shown = inside.startsWith("..") || isAbsolute(inside) ? doc.path : inside;
  return doc.annotations.flatMap((a) => [
    { id: a.id, author: "user", path: shown, quote: a.anchor?.quote ?? undefined, body: a.body },
    ...a.replies.map((r) => ({ id: r.id, author: r.author ?? "user", parentId: a.id, path: shown, body: r.body })),
  ]);
}

export const reviewer: Reviewer = {
  ephemeral: false,

  command({ revisions, doc }, result) {
    if (doc !== undefined) return ["plannotator-tui", doc, "--gate", "--json", "--require-approval", "--result-file", result];
    return ["plannotator-tui", "review", ...(revisions === undefined ? [] : ["--base", revisions])];
  },

  // plannotator-tui rewrites its store on every save.
  async flush() {},

  async comments(target, known, strict): Promise<Comments> {
    const path = store(target, known, strict);
    return { session: path, comments: target.doc === undefined ? diffComments(path) : docComments(target.cwd, path) };
  },

  async reload() {},

  async reply(target, path, comment, text) {
    if (target.doc === undefined) throw new Error("plannotator diff notes take no replies. Answer in your turn instead.");
    const doc = parse(WritableDocStore, path);
    const id = comment.parentId ?? comment.id;
    const note = doc.annotations.find((a) => a.id === id);
    if (note === undefined) throw new Error(`no note ${id} in ${path}`);
    const now = new Date().toISOString();
    note.replies.push({ id: `reply_${randomUUID()}`, annotation_id: id, body: text, author: AGENT_AUTHOR, created_at: now, updated_at: now });
    writeFileSync(`${path}.tmp`, `${JSON.stringify(doc, null, 2)}\n`);
    renameSync(`${path}.tmp`, path);
  },

  watch: storeDir,

  threads: (target) => target.doc !== undefined,

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
