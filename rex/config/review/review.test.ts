import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { quote, repoRoot, run, sandbox, type Sandbox } from "#harness";
import type { Review } from "./state";

const script = join(repoRoot, "rex", "config", "review", "review");
const agent = "block:agent";
const reviewBlock = "block:review";
const id = "review-1";

let box: Sandbox;
let work: string;

// Each stub call is one record: NUL-terminated arguments closed by an RS byte.
const record = String.raw`{ for arg in "$@"; do printf '%s\0' "$arg"; done; printf '\036'; }`;

function readCalls(name: string): string[][] {
  return box
    .read(name)
    .split("\x1e")
    .slice(0, -1)
    .map((call) => call.split("\0").slice(0, -1));
}

const rexCalls = () => readCalls("rex-calls");
const tuicrCalls = () => readCalls("tuicr-calls");

beforeEach(() => {
  box = sandbox("rex-review");
  work = box.mkdir("work");
  box.write("work/src/app.ts", "one\ntwo\nthree\nfour\n");
  box.write("tuicr-list", "[]");
  box.write("tuicr-comments", "[]");
  box.write("tuicr-exit", "0");

  // `rex api call -s SESSION METHOD JSON` answers by method. The first
  // program_status reports working and every later one idle.
  box.stub(
    "rex",
    `${record} >> ${quote(box.path("rex-calls"))}
if [ "$1 $2" = "api call" ]; then
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
  "review comments") cat ${quote(box.path("tuicr-comments"))} ;;
  "review add") ;;
  *) exit "$(cat ${quote(box.path("tuicr-exit"))})" ;;
esac`,
  );
});

afterEach(() => {
  box.remove();
});

function review(overrides: Partial<Review> = {}): Review {
  return { id, session: "sess", agent, review: reviewBlock, cwd: work, reviewer: "tuicr", delivered: [], ...overrides };
}

// Relative to the sandbox, which is where `box.read` and `box.write` start.
function statePath(name: string): string {
  return join("home", ".local", "state", "rex-review", name);
}

function seed(state: Review): void {
  box.write(statePath(`${state.id}.json`), JSON.stringify(state));
  for (const block of [state.agent, state.review]) if (block) box.write(statePath(join("blocks", block)), state.id);
}

function saved(reviewId = id): Review {
  return JSON.parse(box.read(statePath(`${reviewId}.json`)));
}

function exists(name: string): boolean {
  return existsSync(box.path(statePath(name)));
}

function exec(args: string[], env: Record<string, string> = {}) {
  return run([script, ...args], {
    path: [box.bin],
    cwd: work,
    env: { HOME: box.path("home"), REX_SESSION: "sess", ZDOTDIR: box.mkdir("empty"), ...env },
  });
}

function sessions(...rows: { slug: string; updated_at: string; active: boolean }[]): void {
  box.write("tuicr-list", JSON.stringify(rows.map((row) => ({ kind: "local", ...row }))));
}

function comments(...rows: object[]): void {
  box.write("tuicr-comments", JSON.stringify(rows));
}

function apiCalls(method: string): string[][] {
  return rexCalls().filter((c) => c[0] === "api" && c[4] === method);
}

function pasted(): string[] {
  return apiCalls("block.event").map((c) => JSON.parse(c[5]).event.payload.text);
}

// The agent gets a message as a paste, then Enter.
function expectDelivered(message: string): void {
  const calls = rexCalls();
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
    expect(saved().delivered).toEqual(["c1", "c2"]);
  });

  test.each<{ command: string; message: string }>([
    { command: "approve", message: "[review: approved]" },
    { command: "dismiss", message: "[review: dismissed]" },
  ])("$command delivers its message, removes state, and closes the review pane", ({ command, message }) => {
    seed(review());

    const result = exec([command, agent]);

    expect(result.status).toBe(0);
    expectDelivered(message);
    expect(apiCalls("block.close")).toHaveLength(1);
    expect(exists(`${id}.json`)).toBe(false);
    expect(exists(join("blocks", agent))).toBe(false);
    expect(exists(join("blocks", reviewBlock))).toBe(false);
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
    expect(saved().delivered).toEqual(["old", "new"]);
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

describe("rex/config/review run", () => {
  test.each<{ name: string; exit: string; message: string }>([
    { name: "a clean exit delivers dismissed", exit: "0", message: "[review: dismissed]" },
    { name: "a nonzero exit delivers failed", exit: "3", message: "[review: failed] The reviewer exited with status 3" },
  ])("$name and closes the review pane", ({ exit, message }) => {
    seed(review());
    box.write("tuicr-exit", exit);

    expect(exec(["run", id]).status).toBe(0);

    expect(tuicrCalls()[0]).toEqual(["--no-update-check", "-w"]);
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
    expect(split).toMatchObject({ anchor_id: agent, direction: "horizontal", side: "before", focus: true });
    expect(split.layout.block.options).toEqual({ cwd: work, command: [script, "run", reviewId] });
    expect(saved(reviewId)).toMatchObject({
      agent,
      review: reviewBlock,
      cwd: work,
      revisions: "HEAD~2..HEAD",
      delivered: [],
    });
    expect(box.read(statePath(join("blocks", reviewBlock)))).toBe(reviewId);
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
    seed(review());

    const result = exec(["wait", id], { REVIEW_POLL_MS: "10", REVIEW_START_MS: "5000" });

    expect(result.status).toBe(0);
    expect(rexCalls().at(-1)).toEqual(["focus", "-s", "sess", reviewBlock]);
    expect(rexCalls().filter((c) => c[0] === "block")).toHaveLength(2);
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
