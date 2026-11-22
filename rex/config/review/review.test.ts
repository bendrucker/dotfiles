import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { quote, repoRoot, run, sandbox, type Sandbox } from "#harness";
import type { Review } from "./state";

const script = join(repoRoot, "rex", "config", "review", "review");
const extension = join(repoRoot, "rex", "config", "review", "hunk-extension.ts");
const agent = "block:agent";
const reviewBlock = "block:review";
const id = "review-1";

let box: Sandbox;
let work: string;

// Each stub call is one record: NUL-terminated arguments closed by an RS byte.
// It goes out in one write, so concurrent calls don't interleave.
const record = String.raw`{ t=$(mktemp); { for arg in "$@"; do printf '%s\0' "$arg"; done; printf '\036'; } > "$t"; cat "$t"; rm -f "$t"; }`;

function readCalls(name: string): string[][] {
  return box
    .read(name)
    .split("\x1e")
    .slice(0, -1)
    .map((call) => call.split("\0").slice(0, -1));
}

const rexCalls = () => readCalls("rex-calls");
const tuicrCalls = () => readCalls("tuicr-calls");
const hunkCalls = () => readCalls("hunk-calls");

beforeEach(() => {
  box = sandbox("rex-review");
  work = box.mkdir("work");
  box.write("work/src/app.ts", "one\ntwo\nthree\nfour\n");
  box.write("tuicr-list", "[]");
  box.write("tuicr-comments", "[]");
  box.write("tuicr-exit", "0");
  box.write("hunk-sessions", '{"sessions":[]}');
  box.write("hunk-notes", '{"comments":[]}');

  // `rex api call -s SESSION METHOD JSON` answers by method. program_status
  // pops the next line of program-states, keeping the last. Without that file
  // the first reports working and every later one idle.
  box.stub(
    "rex",
    `${record} >> ${quote(box.path("rex-calls"))}
states=${quote(box.path("program-states"))}
if [ "$1 $2" = "block ls" ]; then
  if [ -f ${quote(box.path("live-blocks"))} ]; then cat ${quote(box.path("live-blocks"))}; else printf '%s\n' ${agent} ${reviewBlock}; fi
elif [ "$1 $2" = "block call" ] && [ -f "$states" ]; then
  s=$(head -1 "$states")
  if [ "$(wc -l < "$states")" -gt 1 ]; then tail -n +2 "$states" > "$states.next" && mv "$states.next" "$states"; fi
  printf '{"records":[{"state":"%s"}]}\n' "$s"
elif [ "$1 $2" = "api call" ]; then
  case "$5" in
    session.new_split) echo '{"block_ids":["${reviewBlock}"]}' ;;
    block.close) if [ -f ${quote(box.path("closed"))} ]; then echo "block not found (status=404 code=not_found)" >&2; exit 3; fi ;;
  esac
elif [ "$1 $2" = "block call" ]; then
  n=$(cat ${quote(box.path("status-count"))} 2>/dev/null || echo 0)
  echo $((n + 1)) > ${quote(box.path("status-count"))}
  if [ "$n" = 0 ]; then echo '{"records":[{"state":"working"}]}'; else echo '{"records":[{"state":"idle"}]}'; fi
fi`,
  );
  box.stub(
    "tuicr",
    `${record} >> ${quote(box.path("tuicr-calls"))}
case "$1 $2" in
  "review list") cat ${quote(box.path("tuicr-list"))} ;;
  "review comments") sleep "$(cat ${quote(box.path("tuicr-delay"))} 2>/dev/null || echo 0)"; cat ${quote(box.path("tuicr-comments"))} ;;
  "review add") ;;
  *) exit "$(cat ${quote(box.path("tuicr-exit"))})" ;;
esac`,
  );
  box.write("hunk-review", '{"review":{"files":[]}}');
  stubHunk();
});

// `diff` runs `onDiff`, standing in for the Hunk window's lifetime.
function stubHunk(onDiff = ""): void {
  box.stub(
    "hunk",
    `${record} >> ${quote(box.path("hunk-calls"))}
case "$1 $2 $3" in
  "session list --json") cat ${quote(box.path("hunk-sessions"))} ;;
  "session comment list") sleep "$(cat ${quote(box.path("hunk-delay"))} 2>/dev/null || echo 0)"; cat ${quote(box.path("hunk-notes"))} ;;
  "session review "*) cat ${quote(box.path("hunk-review"))} ;;
  diff*) ${onDiff || ":"} ;;
esac`,
  );
}

afterEach(() => {
  box.remove();
});

function review(overrides: Partial<Review> = {}): Review {
  return {
    id,
    session: "sess",
    agent,
    review: reviewBlock,
    cwd: work,
    reviewer: "tuicr",
    delivered: [],
    mode: "live",
    held: false,
    ...overrides,
  };
}

// Relative to the sandbox, which is where `box.read` and `box.write` start.
function statePath(name: string): string {
  return join("home", ".local", "state", "rex-review", name);
}

function seed(state: Omit<Review, "mode" | "held"> & Partial<Pick<Review, "mode" | "held">>): void {
  box.write(statePath(`${state.id}.json`), JSON.stringify(state));
  for (const block of [state.agent, state.review]) if (block) box.write(statePath(join("blocks", block)), state.id);
}

function saved(reviewId = id): Review {
  return JSON.parse(box.read(statePath(`${reviewId}.json`)));
}

function deliveredIds(reviewId = id): string[] {
  return saved(reviewId).delivered.map((d) => d.id);
}

function hash(body: string): string {
  return createHash("sha256").update(body).digest("hex").slice(0, 16);
}

function exists(name: string): boolean {
  return existsSync(box.path(statePath(name)));
}

const eventsFile = statePath(join("blocks", `${agent}.events`));

function events(): string {
  return box.read(eventsFile);
}

function execEnv(env: Record<string, string> = {}): Record<string, string> {
  return {
    HOME: box.path("home"),
    REX_SESSION: "sess",
    REVIEW_POLL_MS: "10",
    REVIEW_SNAPSHOT_MS: "20",
    ZDOTDIR: box.mkdir("empty"),
    ...env,
  };
}

function exec(args: string[], env: Record<string, string> = {}) {
  return run([script, ...args], { path: [box.bin], cwd: work, env: execEnv(env) });
}

// `run` blocks, so overlapping calls need their own spawn.
function spawn(args: string[], env: Record<string, string> = {}) {
  return Bun.spawn([script, ...args], {
    cwd: work,
    env: { ...process.env, PATH: `${box.bin}:${process.env.PATH}`, ...execEnv(env) },
    stdout: "ignore",
    stderr: "ignore",
  });
}

async function execAsync(args: string[]): Promise<number> {
  return spawn(args).exited;
}

async function until(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(10);
  }
}

function sessions(...rows: { slug: string; updated_at: string; active: boolean }[]): void {
  box.write("tuicr-list", JSON.stringify(rows.map((row) => ({ kind: "local", ...row }))));
}

function comments(...rows: object[]): void {
  box.write("tuicr-comments", JSON.stringify(rows));
}

function hunkSessions(...rows: { sessionId: string; cwd: string; launchedAt: string }[]): void {
  box.write("hunk-sessions", JSON.stringify({ sessions: rows }));
}

function notes(...rows: object[]): void {
  box.write("hunk-notes", JSON.stringify({ comments: rows }));
}

function apiCalls(method: string): string[][] {
  return rexCalls().filter((c) => c[0] === "api" && c[4] === method);
}

function pasted(): string[] {
  return apiCalls("block.event").map((c) => JSON.parse(c[5]).event.payload.text);
}

// The agent gets a message as a paste, then Enter. Status checks may fall between.
function expectDelivered(message: string): void {
  const calls = rexCalls().filter((c) => c[0] !== "block");
  const paste = calls.findIndex((c) => c[4] === "block.event");
  expect(JSON.parse(calls[paste][5])).toEqual({
    block_id: agent,
    event: { type: "paste", payload: { text: expect.stringContaining(message) } },
  });
  expect(calls[paste + 1]).toEqual(["send-key", "-s", "sess", "-b", agent, "enter"]);
}

describe("rex/config/review outcomes", () => {
  test("send delivers new comments and focuses the agent", () => {
    seed(review());
    sessions({ slug: "t1", updated_at: "1", active: true });
    comments(
      { id: "c1", author: "Ben", path: "src/app.ts", start_line: 2, end_line: 3, side: "new", content: "rename these" },
      { id: "c2", author: "Ben", content: "overall note" },
    );

    const result = exec(["send", agent]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${id}\n`);
    expectDelivered("[review: changes] Ben left 2 comments");
    const [text] = pasted();
    expect(text).toContain("## src/app.ts:2-3 (id c1)\n> two\n> three\nrename these");
    expect(text).toContain("## the review (id c2)\noverall note");
    expect(rexCalls().at(-1)).toEqual(["focus", "-s", "sess", agent]);
    expect(deliveredIds()).toEqual(["c1", "c2"]);
  });

  test.each<{ command: string; message: string }>([
    { command: "approve", message: "[review: approved]" },
    { command: "dismiss", message: "[review: dismissed]" },
  ])("$command delivers its message, ends the events file, removes state, and closes the review pane", ({ command, message }) => {
    seed(review());
    box.write(eventsFile, "[review: comment] the review (id c0) | earlier\n");

    const result = exec([command, agent]);

    expect(result.status).toBe(0);
    expectDelivered(message);
    expect(events()).toBe(`[review: comment] the review (id c0) | earlier\n[review: closed] ${command === "approve" ? "approved" : "dismissed"}\n`);
    expect(apiCalls("block.close")).toHaveLength(1);
    expect(exists(`${id}.json`)).toBe(false);
    expect(exists(join("blocks", agent))).toBe(false);
    expect(exists(join("blocks", reviewBlock))).toBe(false);
  });

  test("a failed paste keeps the events file open", () => {
    seed(review());
    box.write(eventsFile, "");
    box.write("program-states", "blocked\n");

    expect(exec(["dismiss", agent], { REVIEW_SUBMIT_WAIT_MS: "50" }).status).toBe(1);

    expect(events()).toBe("");
  });

  test("dismiss succeeds when the review pane is already closed", () => {
    seed(review());
    box.write("closed", "");

    const result = exec(["dismiss", agent]);

    expect(result.status).toBe(0);
    expectDelivered("[review: dismissed]");
    expect(exists(`${id}.json`)).toBe(false);
  });
});

describe("rex/config/review new-comment filter", () => {
  beforeEach(() => {
    sessions({ slug: "t1", updated_at: "1", active: true });
  });

  test("send skips agent replies and delivered ids", () => {
    seed(review({ delivered: ["old"] }));
    comments(
      { id: "old", author: "Ben", content: "already sent" },
      { id: "reply", author: "Claude", content: "done" },
      { id: "new", author: "Ben", content: "fresh" },
    );

    expect(exec(["send", agent]).status).toBe(0);

    const [text] = pasted();
    expect(text).toContain("Ben left 1 comment ");
    expect(text).toContain("fresh");
    expect(text).not.toContain("already sent");
    expect(text).not.toContain("done");
    expect(deliveredIds()).toEqual(["old", "new"]);
  });

  test("send fails and pastes nothing when no comment is new", () => {
    seed(review({ delivered: ["old"] }));
    comments({ id: "old", author: "Ben", content: "already sent" }, { id: "r", author: "Claude", content: "done" });

    const result = exec(["send", agent]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no new comments to send");
    expect(pasted()).toEqual([]);
  });
});

describe("rex/config/review claim", () => {
  beforeEach(() => {
    sessions({ slug: "t1", updated_at: "1", active: true });
  });

  // Regression: send read `delivered`, listed comments, then saved with no
  // lock, so two overlapping sends both delivered the same comment.
  test("concurrent sends deliver a comment once", async () => {
    seed(review());
    comments({ id: "c1", author: "Ben", content: "fix" });
    box.write("tuicr-delay", "0.3");

    const codes = await Promise.all([execAsync(["send", agent]), execAsync(["send", agent])]);

    expect(codes.toSorted()).toEqual([0, 1]);
    expect(pasted()).toHaveLength(1);
    expect(deliveredIds()).toEqual(["c1"]);
    expect(exists(`${id}.lock`)).toBe(false);
  });

  test("prints one live line per new comment and marks it delivered", () => {
    seed(review());
    comments(
      { id: "c1", author: "Ben", path: "src/app.ts", start_line: 2, end_line: 3, side: "new", content: "rename\nthese" },
      { id: "c2", author: "Ben", content: "overall" },
      { id: "r", author: "Claude", content: "done" },
    );

    const result = exec(["claim", agent]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(
      "[review: comment] src/app.ts:2-3 (id c1) | > two ⏎ > three | rename ⏎ these\n" +
        "[review: comment] the review (id c2) | overall\n",
    );
    expect(pasted()).toEqual([]);
    expect(deliveredIds()).toEqual(["c1", "c2"]);
  });

  test("claim then send reports no new comments", () => {
    seed(review());
    comments({ id: "c1", author: "Ben", content: "fix" });

    expect(exec(["claim", agent]).status).toBe(0);
    const result = exec(["send", agent]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no new comments to send");
    expect(pasted()).toEqual([]);
  });

  test("claim prints nothing when no comment is new", () => {
    seed(review({ delivered: ["c1"] }));
    comments({ id: "c1", author: "Ben", content: "fix" });

    const result = exec(["claim", agent]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  test("state saved before modes existed loads as live", () => {
    const { mode: _, ...old } = review();
    seed(old);
    comments({ id: "c1", author: "Ben", content: "fix" });

    expect(exec(["claim", agent]).status).toBe(0);
    expect(saved().mode).toBe("live");
  });
});

describe("rex/config/review run", () => {
  test.each<{ name: string; exit: string; message: string }>([
    { name: "a clean exit with no notes approves", exit: "0", message: "[review: approved]" },
    { name: "a nonzero exit delivers failed", exit: "3", message: "[review: failed] The reviewer exited with status 3" },
  ])("$name and closes the review pane", ({ exit, message }) => {
    seed(review());
    box.write("tuicr-exit", exit);

    expect(exec(["run", id]).status).toBe(0);

    expect(tuicrCalls()).toContainEqual(["--no-update-check", "-w"]);
    expectDelivered(message);
    expect(apiCalls("block.close")).toHaveLength(1);
  });

  test("delivers nothing once the state is gone", () => {
    seed(review());
    // approve removes the state while the reviewer is still running.
    box.stub("tuicr", `rm ${quote(box.path(statePath(`${id}.json`)))}`);

    expect(exec(["run", id]).status).toBe(0);

    expect(rexCalls()).toEqual([]);
  });
});

describe("rex/config/review block resolution", () => {
  test.each<{ name: string; block: string }>([
    { name: "the agent block", block: agent },
    { name: "the review block", block: reviewBlock },
  ])("approve resolves $name", ({ block }) => {
    seed(review());

    expect(exec(["approve", block]).status).toBe(0);
    expectDelivered("[review: approved]");
  });

  test("send resolves the review block", () => {
    seed(review());
    sessions({ slug: "t1", updated_at: "1", active: true });
    comments({ id: "c1", author: "Ben", content: "fix" });

    expect(exec(["send", reviewBlock]).status).toBe(0);
    expectDelivered("[review: changes]");
  });

  test("an unknown block fails", () => {
    const result = exec(["send", "block:other"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no review is open for block:other");
  });
});

describe("rex/config/review open", () => {
  test("splits the agent's pane running the script and records it with the revisions", () => {
    const result = exec(["open", agent, "--cwd", work, "--revisions", "HEAD~2..HEAD"]);

    expect(result.status).toBe(0);
    const reviewId = box.read(statePath(join("blocks", agent)));
    const [create] = apiCalls("session.new_split");
    const split = JSON.parse(create[5]);
    expect(split).toMatchObject({ anchor_id: agent, direction: "horizontal", side: "after", ratio: 0.25, focus: false });
    expect(split.layout.block.options).toEqual({ cwd: work, command: [script, "run", reviewId] });
    expect(saved(reviewId)).toMatchObject({
      agent,
      review: reviewBlock,
      cwd: work,
      reviewer: "hunk",
      revisions: "HEAD~2..HEAD",
      delivered: [],
      mode: "live",
    });
    expect(box.read(statePath(join("blocks", reviewBlock)))).toBe(reviewId);
  });

  test("empties the agent's events file", () => {
    box.write(eventsFile, "[review: closed] approved\n");

    expect(exec(["open", agent, "--cwd", work]).status).toBe(0);

    expect(events()).toBe("");
  });

  test("records batch mode", () => {
    expect(exec(["open", agent, "--cwd", work, "--mode", "batch"]).status).toBe(0);

    expect(saved(box.read(statePath(join("blocks", agent)))).mode).toBe("batch");
  });

  test("rejects an unknown mode", () => {
    const result = exec(["open", agent, "--cwd", work, "--mode", "eager"]);

    expect(result.status).toBe(2);
    expect(apiCalls("session.new_split")).toEqual([]);
  });
});

describe("rex/config/review reply", () => {
  beforeEach(() => {
    seed(review());
    sessions({ slug: "t1", updated_at: "1", active: true });
    comments({ id: "c1", author: "Ben", path: "src/app.ts", start_line: 2, side: "new", content: "fix" });
  });

  test("adds a reply as Claude at the comment's location", () => {
    expect(exec(["reply", agent, "c1", "done"]).status).toBe(0);

    expect(tuicrCalls().at(-1)).toEqual(
      "review add --session t1 --username Claude --target-file src/app.ts --line 2 --side new done".split(" "),
    );
  });

  test("fails for an unknown comment", () => {
    const result = exec(["reply", agent, "nope", "done"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no comment nope in this review");
    expect(tuicrCalls().some((c) => c[1] === "add")).toBe(false);
  });
});

describe("rex/config/review wait", () => {
  test("focuses the review once the agent goes from working to idle", () => {
    seed(review({ mode: "batch" }));

    const result = exec(["wait", id], { REVIEW_POLL_MS: "10", REVIEW_START_MS: "5000" });

    expect(result.status).toBe(0);
    expect(rexCalls().at(-1)).toEqual(["focus", "-s", "sess", reviewBlock]);
    expect(rexCalls().filter((c) => c[0] === "block")).toHaveLength(2);
  });

  test("returns at once in live mode", () => {
    seed(review());

    const result = exec(["wait", id], { REVIEW_POLL_MS: "10", REVIEW_START_MS: "5000" });

    expect(result.status).toBe(0);
    expect(rexCalls()).toEqual([]);
  });
});

describe("rex/config/review tuicr session choice", () => {
  test("picks the active local session over a newer inactive one", () => {
    seed(review());
    sessions({ slug: "stale", updated_at: "2026-02", active: false }, { slug: "live", updated_at: "2026-01", active: true });
    comments({ id: "c1", author: "Ben", content: "fix" });

    expect(exec(["send", agent]).status).toBe(0);

    expect(tuicrCalls().find((c) => c[1] === "comments")).toEqual(["review", "comments", "--session", "live"]);
    expect(saved().reviewerSession).toBe("live");
  });
});

describe("rex/config/review hunk", () => {
  test.each<{ name: string; revisions?: string; args: string[] }>([
    { name: "the working tree", args: ["diff", "--watch", "--agent-notes", "--extension", extension] },
    {
      name: "a revision range",
      revisions: "main..HEAD",
      args: ["diff", "main..HEAD", "--watch", "--agent-notes", "--extension", extension],
    },
  ])("run opens $name with agent notes shown", ({ revisions, args }) => {
    seed(review({ reviewer: "hunk", revisions }));

    expect(exec(["run", id]).status).toBe(0);

    expect(hunkCalls().find((c) => c[0] === "diff")).toEqual(args);
  });

  test("send delivers the user's notes from the window open in the review's directory", () => {
    seed(review({ reviewer: "hunk" }));
    hunkSessions(
      { sessionId: "elsewhere", cwd: "/other", launchedAt: "2026-11-02" },
      { sessionId: "h1", cwd: realpathSync(work), launchedAt: "2026-11-01" },
    );
    notes(
      { noteId: "user:1", source: "user", filePath: "src/app.ts", hunkIndex: 0, newRange: [2, 3], body: "rename these", author: "user" },
      { noteId: "user:2", source: "user", filePath: "src/app.ts", hunkIndex: 0, oldRange: [1, 1], body: "why drop this", author: "user" },
    );
    box.write("hunk-review", JSON.stringify({ review: { files: [{ path: "src/app.ts", patch: "@@ -1,2 +1,4 @@\n-zero\n one\n+two\n+three\n" }] } }));

    const result = exec(["send", agent]);

    expect(result.status).toBe(0);
    expect(hunkCalls().find((c) => c[1] === "comment")).toEqual(["session", "comment", "list", "h1", "--type", "all", "--json"]);
    const [text] = pasted();
    expect(text).toContain("## src/app.ts:2-3 (id user:1)\n> two\n> three\nrename these");
    expect(text).toContain("## src/app.ts:1 (id user:2)\n> zero\nwhy drop this");
    expect(saved().reviewerSession).toBe("h1");
    expect(deliveredIds()).toEqual(["user:1", "user:2"]);
  });

  test("send keeps the recorded session while its window is open", () => {
    seed(review({ reviewer: "hunk", reviewerSession: "h1" }));
    hunkSessions(
      { sessionId: "h1", cwd: realpathSync(work), launchedAt: "2026-11-01" },
      { sessionId: "h2", cwd: realpathSync(work), launchedAt: "2026-11-02" },
    );
    notes({ noteId: "user:1", source: "user", body: "fix", author: "user" });

    expect(exec(["send", agent]).status).toBe(0);

    expect(hunkCalls().find((c) => c[1] === "comment")?.[3]).toBe("h1");
  });

  test("send fails when no Hunk window is open in the review's directory", () => {
    seed(review({ reviewer: "hunk" }));

    const result = exec(["send", agent]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no open Hunk window");
    expect(pasted()).toEqual([]);
  });

  test("reply answers the note as Claude", () => {
    seed(review({ reviewer: "hunk" }));
    hunkSessions({ sessionId: "h1", cwd: realpathSync(work), launchedAt: "2026-11-01" });
    notes({ noteId: "user:1", source: "user", filePath: "src/app.ts", newRange: [2, 2], body: "fix", author: "user" });

    expect(exec(["reply", agent, "user:1", "done"]).status).toBe(0);

    expect(hunkCalls().at(-1)).toEqual(
      ["session", "comment", "add", "h1", "--reply-to", "user:1", "--summary", "done", "--author", "Claude"],
    );
  });
});

function note(overrides: object = {}): object {
  return { noteId: "user:1", source: "user", author: "user", filePath: "src/app.ts", newRange: [2, 2], body: "fix", ...overrides };
}

function agentNote(overrides: object = {}): object {
  return { noteId: "mcp:1", source: "agent", author: "Claude", parentId: "user:1", filePath: "src/app.ts", newRange: [2, 2], body: "done", ...overrides };
}

function hunkReview(overrides: Partial<Review> = {}): void {
  seed(review({ reviewer: "hunk", reviewerSession: "h1", ...overrides }));
  hunkSessions({ sessionId: "h1", cwd: realpathSync(work), launchedAt: "2026-11-01" });
}

describe("rex/config/review quitting Hunk", () => {
  test.each<{ name: string; delivered: Review["delivered"]; rows: object[]; message: string; absent?: string }>([
    { name: "no notes approves", delivered: [], rows: [], message: "[review: approved] Ben approved the changes. Continue." },
    {
      name: "every delivered note answered approves",
      delivered: [{ id: "user:1", hash: hash("fix") }],
      rows: [note(), agentNote()],
      message: "[review: approved] Ben approved the changes. Continue.",
    },
    {
      name: "a follow-up answered later in the thread approves",
      delivered: [{ id: "user:1", hash: hash("fix") }, { id: "user:2", hash: hash("and this") }],
      rows: [note(), agentNote(), note({ noteId: "user:2", parentId: "user:1", body: "and this" }), agentNote({ noteId: "mcp:2" })],
      message: "[review: approved]",
    },
    {
      name: "an unanswered delivered note asks how to proceed",
      delivered: [{ id: "user:1", hash: hash("fix") }],
      rows: [note()],
      message: "These earlier comments have no reply yet: id user:1.",
    },
    {
      name: "an undelivered note is delivered",
      delivered: [],
      rows: [note({ body: "rename this" })],
      message: "## src/app.ts:2 (id user:1)\n> two\nrename this",
      absent: "no reply yet",
    },
  ])("$name", ({ delivered, rows, message, absent }) => {
    hunkReview({ delivered, mode: "batch" });
    notes(...rows);

    expect(exec(["run", id]).status).toBe(0);

    const [text] = pasted();
    expect(text).toContain(message);
    if (absent !== undefined) expect(text).not.toContain(absent);
    expect(apiCalls("block.close")).toHaveLength(1);
    expect(exists(`${id}.json`)).toBe(false);
  });

  test("a closed review tells the agent to address the notes and ask how to proceed", () => {
    hunkReview({ delivered: [{ id: "user:1", hash: hash("fix") }], mode: "batch" });
    notes(note(), note({ noteId: "user:2", newRange: [3, 3], body: "and this" }));

    expect(exec(["run", id]).status).toBe(0);

    expect(pasted()[0]).toMatchInlineSnapshot(`
      "[review: closed] Ben closed Hunk without approving.

      ## src/app.ts:3 (id user:2)
      > three
      and this

      These earlier comments have no reply yet: id user:1.

      Address each comment, then ask Ben how to proceed. Don't commit."
    `);
  });

  test("delivers notes from the last snapshot once the window is gone", () => {
    seed(review({ reviewer: "hunk", mode: "batch" }));
    hunkSessions({ sessionId: "h1", cwd: realpathSync(work), launchedAt: "2026-11-01" });
    notes(note({ body: "written while open" }));
    stubHunk(`sleep 0.4; printf '{"sessions":[]}' > ${quote(box.path("hunk-sessions"))}`);

    expect(exec(["run", id]).status).toBe(0);

    expectDelivered("[review: closed] Ben closed Hunk without approving.");
    expect(pasted()[0]).toContain("written while open");
  });

  test("dismiss after delivering notes doesn't claim there was no feedback", () => {
    seed(review({ delivered: [{ id: "c1" }] }));

    expect(exec(["dismiss", agent]).status).toBe(0);

    const [text] = pasted();
    expect(text).toBe("[review: dismissed] Ben dismissed the review. Treat this as a successful outcome and continue.");
  });
});

describe("rex/config/review approve", () => {
  test("delivers unsent notes as approved once they are addressed", () => {
    hunkReview({ delivered: [{ id: "user:1", hash: hash("fix") }] });
    notes(note(), agentNote(), note({ noteId: "user:2", newRange: [3, 3], body: "rename" }));

    expect(exec(["approve", agent]).status).toBe(0);

    expect(pasted()[0]).toMatchInlineSnapshot(`
      "[review: approved] Ben approved the changes, once you address the 1 comment below.

      ## src/app.ts:3 (id user:2)
      > three
      rename

      The review is closed, so fix each one without replying, then continue."
    `);
    expect(exists(`${id}.json`)).toBe(false);
  });
});

describe("rex/config/review edits and retractions", () => {
  test("claim redelivers an edited note and reports a deleted one", () => {
    hunkReview({ delivered: [{ id: "user:1", hash: hash("old") }, { id: "user:9", hash: hash("gone") }] });
    notes(note({ body: "new" }));

    const result = exec(["claim", agent]);

    expect(result.status).toBe(0);
    expect(result.stdout).toMatchInlineSnapshot(`
      "[review: retracted] (id user:9) | Ben deleted this comment. Drop it.
      [review: comment edited] src/app.ts:2 (id user:1) | > two | new
      "
    `);
    expect(saved().delivered).toEqual([{ id: "user:1", hash: hash("new") }]);
  });

  test("send carries edits and retractions in the batch", () => {
    hunkReview({ delivered: [{ id: "user:1", hash: hash("old") }, { id: "user:9", hash: hash("gone") }] });
    notes(note({ body: "new" }));

    expect(exec(["send", agent]).status).toBe(0);

    expect(pasted()[0]).toMatchInlineSnapshot(`
      "[review: changes] Ben left 2 comments on your changes.

      ## [review: retracted] (id user:9)
      Ben deleted this comment. Drop it.

      ## [review: comment edited] src/app.ts:2 (id user:1)
      > two
      new

      Fix each one, then answer it with \`rex do review_reply id=<id> text="<reply>"\`. Don't commit. End your turn when every comment has an answer, and Ben will see the review again."
    `);
  });

  test("an unchanged note stays delivered", () => {
    hunkReview({ delivered: [{ id: "user:1", hash: hash("fix") }] });
    notes(note());

    expect(exec(["claim", agent]).stdout).toBe("");
  });

  test("ids saved without hashes take a hash without redelivery", () => {
    box.write(statePath(`${id}.json`), JSON.stringify({ ...review({ reviewer: "hunk", reviewerSession: "h1" }), delivered: ["user:1"] }));
    box.write(statePath(join("blocks", agent)), id);
    hunkSessions({ sessionId: "h1", cwd: realpathSync(work), launchedAt: "2026-11-01" });
    notes(note());

    expect(exec(["claim", agent]).stdout).toBe("");
    expect(saved().delivered).toEqual([{ id: "user:1", hash: hash("fix") }]);
  });

  test("a different Hunk window retracts nothing", () => {
    hunkReview({ reviewerSession: "h0", delivered: [{ id: "user:9", hash: hash("gone") }] });

    const result = exec(["claim", agent]);

    expect(result.stdout).toBe("");
    expect(deliveredIds()).toEqual(["user:9"]);
  });
});

describe("rex/config/review thread context", () => {
  test.each<{ name: string; parentId: string }>([
    { name: "the agent's reply", parentId: "mcp:1" },
    { name: "the thread's root", parentId: "user:1" },
  ])("a reply to $name carries the agent's reply it answers", ({ parentId }) => {
    hunkReview({ delivered: [{ id: "user:1", hash: hash("fix") }] });
    notes(note(), agentNote({ body: "renamed it to total" }), note({ noteId: "user:2", parentId, body: "not that name" }));

    const result = exec(["claim", agent]);

    expect(result.stdout).toBe(
      "[review: comment] src/app.ts:2 (id user:2) | > two | In reply to your note: renamed it to total | not that name\n",
    );
  });

  test("notes from other agents are left out", () => {
    hunkReview();
    notes(note(), agentNote({ noteId: "mcp:x", author: "Codex", parentId: undefined, body: "other" }));

    expect(exec(["claim", agent]).stdout).toBe("[review: comment] src/app.ts:2 (id user:1) | > two | fix\n");
  });
});

describe("rex/config/review quotes", () => {
  test("quote the diff Hunk shows rather than the working tree", () => {
    hunkReview();
    box.write("hunk-review", JSON.stringify({ review: { files: [{ path: "src/app.ts", patch: "@@ -1,2 +1,2 @@\n one\n-two\n+TWO\n" }] } }));
    notes(note(), note({ noteId: "user:2", newRange: undefined, oldRange: [2, 2], body: "why" }));

    expect(exec(["claim", agent]).stdout).toBe(
      "[review: comment] src/app.ts:2 (id user:1) | > TWO | fix\n[review: comment] src/app.ts:2 (id user:2) | > two | why\n",
    );
  });

  test("an old-side line outside the diff comes from HEAD", () => {
    const git = (...args: string[]) =>
      expect(Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: work }).exitCode).toBe(0);
    git("init", "-q");
    git("add", ".");
    git("commit", "-qm", "base");
    box.write("work/src/app.ts", "changed\n");
    hunkReview();
    notes(note({ newRange: undefined, oldRange: [3, 3], body: "keep" }));

    expect(exec(["claim", agent]).stdout).toBe("[review: comment] src/app.ts:3 (id user:1) | > three | keep\n");
  });
});

describe("rex/config/review paste guard", () => {
  test("waits out a permission prompt before pasting", () => {
    seed(review());
    box.write("program-states", "blocked\nblocked\nidle\n");

    expect(exec(["approve", agent]).status).toBe(0);

    const calls = rexCalls();
    const paste = calls.findIndex((c) => c[4] === "block.event");
    expect(calls.slice(0, paste).filter((c) => c[0] === "block")).toHaveLength(4);
    expectDelivered("[review: approved]");
  });

  test("gives up on a prompt that stays open and keeps the review", () => {
    seed(review());
    box.write("program-states", "blocked\n");

    const result = exec(["approve", agent], { REVIEW_SUBMIT_WAIT_MS: "50" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("permission prompt");
    expect(pasted()).toEqual([]);
    expect(saved().outcome).toBeUndefined();
  });
});

describe("rex/config/review state hygiene", () => {
  beforeEach(() => {
    seed(review({ id: "stale", agent: "block:gone", review: "block:gone-review" }));
    seed(review({ id: "other", agent: "block:live", review: "block:live-review" }));
    box.write(statePath(join("blocks", "block:orphan")), "missing");
    box.write(statePath(join("blocks", "block:gone.events")), "");
    box.write(statePath(join("blocks", "block:live.events")), "");
    box.write(statePath(join("blocks", "block:gone.status.json")), "{}");
    box.write(statePath(join("blocks", "block:live.status.json")), "{}");
  });

  test("open drops reviews and block files whose blocks are gone", () => {
    box.write("live-blocks", [agent, reviewBlock, "block:live", "block:live-review", "block:orphan"].join("\n"));

    expect(exec(["open", agent, "--cwd", work]).status).toBe(0);

    expect(exists("stale.json")).toBe(false);
    expect(exists(join("blocks", "block:gone"))).toBe(false);
    expect(exists(join("blocks", "block:gone-review"))).toBe(false);
    expect(exists(join("blocks", "block:orphan"))).toBe(false);
    expect(exists(join("blocks", "block:gone.events"))).toBe(false);
    expect(exists(join("blocks", "block:gone.status.json"))).toBe(false);
    expect(exists("other.json")).toBe(true);
    expect(exists(join("blocks", "block:live"))).toBe(true);
    expect(exists(join("blocks", "block:live.events"))).toBe(true);
    expect(exists(join("blocks", "block:live.status.json"))).toBe(true);
  });

  test("open keeps state when the block list lacks the agent", () => {
    box.write("live-blocks", "");

    expect(exec(["open", agent, "--cwd", work]).status).toBe(0);

    expect(exists("stale.json")).toBe(true);
  });
});

describe("rex/config/review events file", () => {
  const quitFile = () => box.path("quit");

  // Hunk stays open until the test writes the quit file. `run` handles the
  // signal once Hunk is up.
  async function startRun(mode: Review["mode"], env: Record<string, string> = {}) {
    seed(review({ reviewer: "hunk", mode }));
    hunkSessions({ sessionId: "h1", cwd: realpathSync(work), launchedAt: "2026-11-01" });
    stubHunk(`while [ ! -f ${quote(quitFile())} ]; do sleep 0.02; done`);
    const child = spawn(["run", id], env);
    await until(() => existsSync(box.path("hunk-calls")) && hunkCalls().some((c) => c[0] === "diff"));
    return child;
  }

  async function quit(child: ReturnType<typeof spawn>): Promise<void> {
    box.write("quit", "");
    expect(await child.exited).toBe(0);
  }

  const lines = () => events().split("\n").filter((l) => l !== "");

  test("a signal claims a saved note before the next tick", async () => {
    const child = await startRun("live", { REVIEW_SNAPSHOT_MS: "60000" });
    // The first claim records the window, so a note written after it waits for a signal.
    await until(() => exists(`${id}.json`) && saved().reviewerSession === "h1");
    notes(note());

    child.kill("SIGUSR1");
    await until(() => exists(join("blocks", `${agent}.events`)) && lines().length === 1, 2000);
    await quit(child);

    expect(events()).toMatchInlineSnapshot(`
      "[review: comment] src/app.ts:2 (id user:1) | > two | fix
      [review: closed] closed
      "
    `);
  });

  test("signal and timer claims append each note once, in order", async () => {
    box.write("hunk-delay", "0.05");
    const child = await startRun("live");
    const rows: object[] = [];
    for (const n of [1, 2, 3, 4]) {
      rows.push(note({ noteId: `user:${n}`, newRange: [n, n], body: `note ${n}` }));
      notes(...rows);
      for (let i = 0; i < 5; i++) {
        child.kill("SIGUSR1");
        await Bun.sleep(5);
      }
      await until(() => exists(join("blocks", `${agent}.events`)) && lines().length === n);
    }
    await quit(child);

    expect(lines()).toEqual([
      "[review: comment] src/app.ts:1 (id user:1) | > one | note 1",
      "[review: comment] src/app.ts:2 (id user:2) | > two | note 2",
      "[review: comment] src/app.ts:3 (id user:3) | > three | note 3",
      "[review: comment] src/app.ts:4 (id user:4) | > four | note 4",
      "[review: closed] closed",
    ]);
  });

  const statusFile = statePath(join("blocks", `${agent}.status.json`));
  const status = () => (existsSync(box.path(statusFile)) ? JSON.parse(box.read(statusFile)) : undefined);

  test("held notes wait for release, then arrive in order", async () => {
    const child = await startRun("live");
    await until(() => exists(`${id}.json`) && saved().reviewerSession === "h1");

    child.kill("SIGUSR2");
    await until(() => saved().held);
    notes(note({ noteId: "user:1", newRange: [1, 1], body: "first" }), note({ noteId: "user:2", newRange: [2, 2], body: "second" }));
    child.kill("SIGUSR1");
    await until(() => status()?.pending === 2);
    expect(lines()).toEqual([]);
    expect(deliveredIds()).toEqual([]);

    child.kill("SIGUSR2");
    await until(() => lines().length === 2);
    expect(saved().held).toBe(false);
    await quit(child);

    expect(lines()).toEqual([
      "[review: comment] src/app.ts:1 (id user:1) | > one | first",
      "[review: comment] src/app.ts:2 (id user:2) | > two | second",
      "[review: closed] closed",
    ]);
  });

  test("writes the extension's status beside the events file", async () => {
    box.write("program-states", "working\n");
    const child = await startRun("live");
    notes(note(), agentNote(), note({ noteId: "user:2", newRange: [3, 3], body: "and this" }));
    await until(() => status()?.open === 1);
    const shown = status();
    await quit(child);

    expect(shown).toEqual({ id, held: false, pending: 0, open: 1, answered: 1, agent: "working" });
    expect(exists(join("blocks", `${agent}.status.json`))).toBe(false);
  });

  test("passes the extension the review, its own pid, and the status file", async () => {
    seed(review({ reviewer: "hunk" }));
    stubHunk(`env | grep '^REX_REVIEW_' > ${quote(box.path("hunk-env"))}`);

    expect(exec(["run", id]).status).toBe(0);

    const env = Object.fromEntries(box.read("hunk-env").trim().split("\n").map((l) => l.split("=")));
    expect(env.REX_REVIEW_ID).toBe(id);
    expect(Number(env.REX_REVIEW_PID)).toBeGreaterThan(0);
    expect(env.REX_REVIEW_STATUS).toBe(box.path(statusFile));
  });

  test("batch mode appends only the closed line", async () => {
    const child = await startRun("batch");
    notes(note());
    child.kill("SIGUSR1");
    await until(() => hunkCalls().filter((c) => c[1] === "comment").length > 1);
    await quit(child);

    expect(events()).toBe("[review: closed] closed\n");
  });
});

describe("rex/config/review plannotator", () => {
  const client = join("home", ".plannotator", "clients", "plannotator-tui");
  const diffStorePath = join(client, "reviews", "work", "uncommitted-abc", "review.json");
  const docStorePath = join(client, "annotations", "work", "annotate-doc-md-abc", "annotations.json");
  const doc = () => join(work, "doc.md");
  const plannotatorCalls = () => readCalls("plannotator-calls");

  // `onRun` stands in for the TUI's lifetime. A `decision` file becomes the
  // gate's result file.
  function stubPlannotator(onRun = ""): void {
    box.stub(
      "plannotator-tui",
      `${record} >> ${quote(box.path("plannotator-calls"))}
decision=${quote(box.path("decision"))}
while [ $# -gt 0 ]; do
  if [ "$1" = --result-file ] && [ -f "$decision" ]; then cp "$decision" "$2"; fi
  shift
done
${onRun || ":"}`,
    );
  }

  function diffNote(overrides: object = {}): object {
    return {
      id: "local_1",
      type: "comment",
      scope: "line",
      filePath: "src/app.ts",
      lineStart: 2,
      lineEnd: 2,
      side: "new",
      text: "fix",
      anchorText: "two",
      createdAt: 1,
      plannotator_tui: { patchKey: "k", updatedAt: 1, resolution: "still_there" },
      ...overrides,
    };
  }

  function docNote(overrides: object = {}): object {
    return {
      id: "local_d1",
      document_id: "",
      anchor: { originalText: "Deferred Work", quote: "## Deferred Work" },
      body: "rm Work",
      author: null,
      state: "open",
      created_at: "2026-11-21T00:00:00.000Z",
      updated_at: "2026-11-21T00:00:00.000Z",
      replies: [],
      ...overrides,
    };
  }

  function diffStore(...annotations: object[]): void {
    box.write(diffStorePath, JSON.stringify({ repo: realpathSync(work), scope: { kind: "uncommitted" }, annotations, deliveries: [], archived: [] }));
  }

  function docStore(...annotations: object[]): void {
    box.write(docStorePath, JSON.stringify({ path: doc(), annotations, deliveries: [] }));
  }

  function diffReview(overrides: Partial<Review> = {}): void {
    seed(review({ reviewer: "plannotator", ...overrides }));
  }

  function docReview(overrides: Partial<Review> = {}): void {
    seed(review({ reviewer: "plannotator", doc: doc(), mode: "batch", ...overrides }));
  }

  beforeEach(() => {
    box.write("work/doc.md", "# Doc\n\n## Deferred Work\n");
    stubPlannotator();
  });

  test.each<{ name: string; revisions?: string; doc?: boolean; args: string[] }>([
    { name: "the working tree", args: ["review"] },
    { name: "a base ref", revisions: "main", args: ["review", "--base", "main"] },
    { name: "a doc behind an approval gate", doc: true, args: ["doc.md", "--gate", "--json", "--require-approval", "--result-file", "result"] },
  ])("run opens $name", ({ revisions, doc: isDoc, args }) => {
    diffReview({ revisions, doc: isDoc ? doc() : undefined, mode: "batch" });

    expect(exec(["run", id]).status).toBe(0);

    const result = box.path(statePath(`${id}.result.json`));
    const [call] = plannotatorCalls();
    expect(call.map((arg) => (arg === doc() ? "doc.md" : arg === result ? "result" : arg))).toEqual(args);
  });

  test("a store write claims a new diff note without waiting for the timer", async () => {
    diffReview();
    stubPlannotator(`while [ ! -f ${quote(box.path("quit"))} ]; do sleep 0.02; done`);
    const child = spawn(["run", id], { REVIEW_SNAPSHOT_MS: "60000" });
    await until(() => existsSync(box.path("plannotator-calls")));
    const lines = () => (exists(join("blocks", `${agent}.events`)) ? events().split("\n").filter((l) => l !== "") : []);

    diffStore(diffNote());
    await until(() => lines().length === 1, 2000);
    box.write("quit", "");
    expect(await child.exited).toBe(0);

    expect(events()).toMatchInlineSnapshot(`
      "[review: comment] src/app.ts:2 (id local_1) | > two | fix | Reply here in chat. This note takes no review_reply.
      [review: closed] approved
      "
    `);
  });

  test.each<{ name: string; store: () => void; delivered: Review["delivered"]; doc: boolean }>([
    {
      name: "diff",
      store: () => diffStore(diffNote({ text: "fix it now", plannotator_tui: { patchKey: "k", updatedAt: 2, resolution: "still_there" } })),
      delivered: [{ id: "local_1", hash: hash("fix") }],
      doc: false,
    },
    {
      name: "doc",
      store: () => docStore(docNote({ body: "drop Work", updated_at: "2026-11-21T01:00:00.000Z" })),
      delivered: [{ id: "local_d1", hash: hash("rm Work") }],
      doc: true,
    },
  ])("claim redelivers an edited $name note", ({ store, delivered, doc: isDoc }) => {
    diffReview({ doc: isDoc ? doc() : undefined, delivered });
    store();

    expect(exec(["claim", agent]).stdout).toMatchSnapshot();
  });

  test("claim delivers a doc note with its anchor and a user's reply in its thread", () => {
    docReview({ delivered: [{ id: "local_d1", hash: hash("rm Work") }] });
    docStore(
      docNote({
        replies: [
          { id: "reply_claude_1", body: "removed", author: "Claude", created_at: "", updated_at: "" },
          { id: "reply_2", body: "and the heading", author: null, created_at: "", updated_at: "" },
        ],
      }),
    );

    expect(exec(["claim", agent]).stdout).toMatchInlineSnapshot(`
      "[review: comment] doc.md (id reply_2) | In reply to your note: removed | and the heading
      "
    `);
  });

  test("reply appends to the doc note's replies and keeps the store's other fields", () => {
    docReview();
    docStore(docNote());

    expect(exec(["reply", agent, "local_d1", "done"]).status).toBe(0);

    const store = JSON.parse(box.read(docStorePath));
    expect(store.deliveries).toEqual([]);
    expect(store.annotations[0].anchor.originalText).toBe("Deferred Work");
    expect(store.annotations[0].replies).toEqual([
      { id: expect.stringMatching(/^reply_/), body: "done", author: "Claude", created_at: expect.any(String), updated_at: expect.any(String) },
    ]);
  });

  test("reply to a diff note tells the agent to answer in its turn", () => {
    diffReview();
    diffStore(diffNote());

    const result = exec(["reply", agent, "local_1", "done"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Answer in your turn instead.");
  });

  test.each<{ decision: string; unsent: boolean; message: string }>([
    { decision: "approved", unsent: false, message: "[review: approved] Ben approved the changes. Continue." },
    {
      decision: "approved-with-notes",
      unsent: true,
      message: "[review: approved] Ben approved the changes, once you address the 1 comment below.\n\n## doc.md (id local_d2)\n> # Doc\nretitle",
    },
    { decision: "dismissed", unsent: false, message: "[review: dismissed] Ben dismissed the review." },
  ])("a $decision result file delivers its outcome", ({ decision, unsent, message }) => {
    docReview({ delivered: [{ id: "local_d1", hash: hash("rm Work") }] });
    docStore(docNote(), ...(unsent ? [docNote({ id: "local_d2", anchor: { quote: "# Doc" }, body: "retitle" })] : []));
    box.write("decision", JSON.stringify({ decision }));

    expect(exec(["run", id]).status).toBe(0);

    expectDelivered(message);
    expect(exists(`${id}.result.json`)).toBe(false);
    expect(exists(`${id}.json`)).toBe(false);
  });

  test.each<{ name: string; replies: object[]; message: string }>([
    {
      name: "approves when every note has a reply",
      replies: [{ id: "reply_claude_1", body: "removed", author: "Claude", created_at: "", updated_at: "" }],
      message: "[review: approved] Ben approved the changes. Continue.",
    },
    { name: "asks how to proceed when a note has none", replies: [], message: "These earlier comments have no reply yet: id local_d1." },
  ])("quitting a doc without a result $name", ({ replies, message }) => {
    docReview({ delivered: [{ id: "local_d1", hash: hash("rm Work") }] });
    docStore(docNote({ replies }));

    expect(exec(["run", id]).status).toBe(0);

    expectDelivered(message);
  });

  test("quitting a diff approves once every note was delivered", () => {
    diffReview({ delivered: [{ id: "local_1", hash: hash("fix") }], mode: "batch" });
    diffStore(diffNote());

    expect(exec(["run", id]).status).toBe(0);

    expectDelivered("[review: approved] Ben approved the changes. Continue.");
  });

  test.each<{ name: string; args: string[]; reviewer?: Review["reviewer"]; doc?: string; status: number }>([
    { name: "--reviewer plannotator reviews the diff", args: ["--reviewer", "plannotator"], reviewer: "plannotator", status: 0 },
    { name: "--doc picks plannotator", args: ["--doc", "doc.md"], reviewer: "plannotator", doc: "doc.md", status: 0 },
    { name: "--doc rejects hunk", args: ["--doc", "doc.md", "--reviewer", "hunk"], status: 2 },
    { name: "an unknown reviewer is rejected", args: ["--reviewer", "vim"], status: 2 },
  ])("open: $name", ({ args, reviewer, doc: file, status }) => {
    const result = exec(["open", agent, "--cwd", work, ...args]);

    expect(result.status).toBe(status);
    if (status !== 0) return;
    const state = saved(box.read(statePath(join("blocks", agent))));
    expect(state.reviewer).toBe(reviewer);
    expect(state.doc).toBe(file && join(work, file));
  });
});
