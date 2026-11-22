// Loaded into the Hunk window `review run` launches. It signals `run` when the
// user saves or deletes a note, toggles holding notes on ctrl+g, and shows the review's
// status. Hunk may load it from a clone without node_modules. It imports only
// node builtins and declares the slice of Hunk's API it uses.
import { readFileSync } from "node:fs";

interface StatusSpan {
  text: string;
  tone?: "muted" | "accent" | "accent-muted" | "added" | "removed";
}

interface StatusLine {
  set(item: { id: string; spans: readonly StatusSpan[] }): void;
}

interface Context {
  statusLine: StatusLine;
  notify(message: string, type?: "info" | "warning"): void;
}

// Hunk emits this only for saved notes, never drafts.
interface NoteChange {
  kind: "created" | "updated" | "removed";
  note: { source: string };
}

export interface HunkAPI {
  on(event: "startup" | "session_reload" | "shutdown", handler: (payload: unknown, ctx: Context) => void): void;
  on(event: "note_changed", handler: (payload: NoteChange, ctx: Context) => void): void;
  registerCommand(command: { id: string; title: string; key: string }, handler: (ctx: Context) => void): void;
}

export interface Status {
  id: string;
  held: boolean;
  pending: number;
  open: number;
  answered: number;
  agent: string;
}

function isStatus(v: unknown): v is Status {
  return (
    typeof v === "object" &&
    v !== null &&
    "id" in v &&
    typeof v.id === "string" &&
    "held" in v &&
    typeof v.held === "boolean" &&
    "agent" in v &&
    typeof v.agent === "string" &&
    "pending" in v &&
    typeof v.pending === "number" &&
    "open" in v &&
    typeof v.open === "number" &&
    "answered" in v &&
    typeof v.answered === "number"
  );
}

export function spans(status: Status): StatusSpan[] {
  const out: StatusSpan[] = status.held
    ? [{ text: status.pending > 0 ? `held (${status.pending} waiting)` : "held", tone: "removed" }]
    : [{ text: "live", tone: "added" }];
  out.push({ text: ` · ${status.open} open · ${status.answered} answered`, tone: "muted" });
  if (status.agent === "working") out.push({ text: " · Claude: working", tone: "accent" });
  return out;
}

interface Options {
  env: Record<string, string | undefined>;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  refreshMs: number;
}

export function extension(hunk: HunkAPI, { env, kill, refreshMs }: Options): void {
  const id = env.REX_REVIEW_ID;
  const pid = Number(env.REX_REVIEW_PID);
  const path = env.REX_REVIEW_STATUS;
  if (id === undefined || path === undefined || !Number.isInteger(pid)) return;

  let statusLine: StatusLine | undefined;
  let shown = "";
  let timer: ReturnType<typeof setInterval> | undefined;

  // A status file left by an earlier review on the same agent pane is ignored.
  const read = (): Status | undefined => {
    try {
      const status: unknown = JSON.parse(readFileSync(path, "utf8"));
      return isStatus(status) && status.id === id ? status : undefined;
    } catch {
      return undefined;
    }
  };

  const refresh = (): void => {
    const status = read();
    const next = status === undefined ? [] : spans(status);
    const key = JSON.stringify(next);
    if (statusLine === undefined || key === shown) return;
    statusLine.set({ id: "review", spans: next });
    shown = key;
  };

  const signal = (name: NodeJS.Signals): boolean => {
    try {
      kill(pid, name);
      return true;
    } catch {
      return false;
    }
  };

  // Retained controls can go inert after a reload. Each event hands over fresh ones.
  const adopt = (ctx: Context): void => {
    if (ctx.statusLine !== statusLine) shown = "";
    statusLine = ctx.statusLine;
    refresh();
  };

  hunk.on("startup", (_payload, ctx) => {
    adopt(ctx);
    timer ??= setInterval(refresh, refreshMs);
    timer.unref?.();
  });
  hunk.on("session_reload", (_payload, ctx) => adopt(ctx));
  hunk.on("shutdown", () => clearInterval(timer));

  // `run` reads the notes back from `comment list`. This is only the wake-up.
  hunk.on("note_changed", ({ note }, ctx) => {
    if (note.source !== "user") return;
    signal("SIGUSR1");
    adopt(ctx);
  });

  hunk.registerCommand({ id: "hold", title: "Hold notes / release", key: "ctrl+g" }, (ctx) => {
    const status = read();
    if (status === undefined || !signal("SIGUSR2")) {
      ctx.notify("Hold works only in a live review", "warning");
      return;
    }
    ctx.notify(status.held ? "Releasing notes" : "Holding notes");
    adopt(ctx);
  });
}

export default function (hunk: HunkAPI): void {
  extension(hunk, { env: process.env, kill: (pid, name) => process.kill(pid, name), refreshMs: 1000 });
}
