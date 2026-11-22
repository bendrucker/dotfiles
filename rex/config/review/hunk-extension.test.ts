import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sandbox, type Sandbox } from "#harness";
import { extension, spans, type HunkAPI, type Status } from "./hunk-extension";

let box: Sandbox;

beforeEach(() => {
  box = sandbox("hunk-extension");
});

afterEach(() => {
  box.remove();
});

function makeStatus(overrides: Partial<Status> = {}): Status {
  return { id: "review-1", held: false, pending: 0, open: 0, answered: 0, agent: "idle", ...overrides };
}

type Handler = (payload: unknown, ctx: unknown) => void;

// A fake Hunk that records what the extension registers and does.
function fakeHunk(env: Record<string, string | undefined> = {}) {
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, { key: string; run: (ctx: unknown) => void }>();
  const signals: string[] = [];
  const statusLines: unknown[][] = [];
  const notices: string[] = [];
  const ctx = {
    statusLine: { set: (item: { spans: readonly unknown[] }) => statusLines.push([...item.spans]) },
    notify: (message: string, type = "info") => notices.push(`${type}: ${message}`),
  };
  // The maps are untyped. The cast covers the API's per-event overloads.
  const api = {
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    registerCommand: (command: { id: string; key: string }, run: (ctx: unknown) => void) =>
      commands.set(command.id, { key: command.key, run }),
  } as unknown as HunkAPI;
  extension(api, {
    env: { REX_REVIEW_ID: "review-1", REX_REVIEW_PID: "4242", REX_REVIEW_STATUS: box.path("status.json"), ...env },
    kill: (pid, signal) => {
      if (pid !== 4242) throw new Error("ESRCH");
      signals.push(signal);
    },
    refreshMs: 10,
  });
  const emit = (event: string, payload: unknown = {}) => handlers.get(event)?.(payload, ctx);
  return { handlers, commands, signals, statusLines, notices, emit, run: (id: string) => commands.get(id)?.run(ctx) };
}

function writeStatus(status: Status): void {
  box.write("status.json", JSON.stringify(status));
}

describe("rex/config/review hunk extension", () => {
  test("does nothing outside a review", () => {
    const hunk = fakeHunk({ REX_REVIEW_PID: undefined });

    expect(hunk.handlers.size).toBe(0);
    expect(hunk.commands.size).toBe(0);
  });

  test.each<{ name: string; event: string; draft: boolean; signals: string[] }>([
    { name: "a new note", event: "note_created", draft: false, signals: ["SIGUSR1"] },
    { name: "a saved edit", event: "note_edited", draft: false, signals: ["SIGUSR1"] },
    { name: "a draft edit", event: "note_edited", draft: true, signals: [] },
  ])("$name signals run: $signals", ({ event, draft, signals }) => {
    const hunk = fakeHunk();

    hunk.emit(event, { note: { draft } });

    expect(hunk.signals).toEqual(signals);
  });

  test.each<{ name: string; held: boolean; notice: string }>([
    { name: "a live review", held: false, notice: "info: Holding notes" },
    { name: "a held review", held: true, notice: "info: Releasing notes" },
  ])("ctrl+g toggles $name", ({ held, notice }) => {
    writeStatus(makeStatus({ held }));
    const hunk = fakeHunk();

    hunk.run("hold");

    expect(hunk.commands.get("hold")?.key).toBe("ctrl+g");
    expect(hunk.signals).toEqual(["SIGUSR2"]);
    expect(hunk.notices).toEqual([notice]);
  });

  test.each<{ name: string; status?: Status; pid?: string }>([
    { name: "no status", status: undefined },
    { name: "another review's status", status: makeStatus({ id: "review-0" }) },
    { name: "a gone run", status: makeStatus(), pid: "1" },
  ])("ctrl+g warns with $name", ({ status, pid }) => {
    if (status !== undefined) writeStatus(status);
    const hunk = fakeHunk(pid === undefined ? {} : { REX_REVIEW_PID: pid });

    hunk.run("hold");

    expect(hunk.signals).toEqual([]);
    expect(hunk.notices).toEqual(["warning: Hold works only in a live review"]);
  });

  test("shows the status at startup and follows changes", async () => {
    writeStatus(makeStatus({ open: 1 }));
    const hunk = fakeHunk();

    hunk.emit("startup");
    writeStatus(makeStatus({ held: true, pending: 2, open: 1 }));
    await Bun.sleep(50);
    hunk.emit("shutdown");

    expect(hunk.statusLines.map((s) => s.map((span) => (span as { text: string }).text).join(""))).toEqual([
      "live · 1 open · 0 answered",
      "held (2 waiting) · 1 open · 0 answered",
    ]);
  });

  test("status line spans", () => {
    const rows: Record<string, Status> = {
      "live and idle": makeStatus({ open: 2, answered: 3 }),
      "live with Claude working": makeStatus({ open: 1, agent: "working" }),
      "held with nothing waiting": makeStatus({ held: true }),
      "held with notes waiting": makeStatus({ held: true, pending: 2, answered: 1 }),
    };

    expect(Object.fromEntries(Object.entries(rows).map(([name, status]) => [name, spans(status)]))).toMatchInlineSnapshot(`
      {
        "held with notes waiting": [
          {
            "text": "held (2 waiting)",
            "tone": "removed",
          },
          {
            "text": " · 0 open · 1 answered",
            "tone": "muted",
          },
        ],
        "held with nothing waiting": [
          {
            "text": "held",
            "tone": "removed",
          },
          {
            "text": " · 0 open · 0 answered",
            "tone": "muted",
          },
        ],
        "live and idle": [
          {
            "text": "live",
            "tone": "added",
          },
          {
            "text": " · 2 open · 3 answered",
            "tone": "muted",
          },
        ],
        "live with Claude working": [
          {
            "text": "live",
            "tone": "added",
          },
          {
            "text": " · 1 open · 0 answered",
            "tone": "muted",
          },
          {
            "text": " · Claude: working",
            "tone": "accent",
          },
        ],
      }
    `);
  });
});
