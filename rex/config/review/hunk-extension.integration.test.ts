import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { must, sandbox, type Sandbox } from "#harness";
import type { Status } from "./hunk-extension";

const extension = join(import.meta.dir, "hunk-extension.ts");
const CTRL_G = "\x07";

let box: Sandbox;

beforeEach(() => {
  box = sandbox("hunk-extension-pty");
});

afterEach(() => {
  box.remove();
});

function scratchRepo(): string {
  const repo = box.mkdir("repo");
  const git = (...args: string[]) =>
    must(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: repo });
  git("init", "-q");
  box.write("repo/app.ts", "one\n");
  git("add", ".");
  git("commit", "-qm", "init");
  box.write("repo/app.ts", "one\ntwo\n");
  return repo;
}

function writeStatus(overrides: Partial<Status>): void {
  const status: Status = { id: "review-1", held: false, pending: 0, open: 0, answered: 0, agent: "idle", ...overrides };
  box.write("status.json", JSON.stringify(status));
}

async function until(check: () => boolean, describe: () => string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out. Screen:\n${describe()}`);
    await Bun.sleep(25);
  }
}

describe("rex/config/review hunk extension in Hunk", () => {
  test("shows the review status and signals run to hold on ctrl+g", async () => {
    const repo = scratchRepo();
    writeStatus({ open: 1, answered: 2, agent: "working" });
    // A stand-in for `run`. SIGUSR2's default action ends it, which records the signal.
    const run = Bun.spawn(["sleep", "60"]);
    let screen = "";
    const decoder = new TextDecoder();
    const hunk = Bun.spawn(["hunk", "diff", "--extension", extension], {
      cwd: repo,
      env: {
        ...process.env,
        XDG_CONFIG_HOME: box.mkdir("config"),
        XDG_STATE_HOME: box.mkdir("state"),
        HUNK_MCP_DISABLE: "1",
        HUNK_DISABLE_UPDATE_NOTICE: "1",
        TERM: "xterm-256color",
        REX_REVIEW_ID: "review-1",
        REX_REVIEW_PID: String(run.pid),
        REX_REVIEW_STATUS: box.path("status.json"),
      },
      terminal: {
        cols: 120,
        rows: 30,
        data: (_terminal, chunk) => {
          screen += decoder.decode(chunk);
        },
      },
    });
    const text = () => Bun.stripANSI(screen);

    try {
      await until(() => text().includes("live · 1 open · 2 answered · Claude: working"), text);

      writeStatus({ held: true, pending: 1, open: 1, answered: 2 });
      await until(() => text().includes("held (1 waiting) · 1 open · 2 answered"), text);

      hunk.terminal?.write(CTRL_G);
      await run.exited;
      expect(run.signalCode).toBe("SIGUSR2");
      await until(() => text().includes("Releasing notes"), text);

      hunk.terminal?.write("q");
      expect(await hunk.exited).toBe(0);
    } finally {
      run.kill();
      hunk.kill();
    }
  });
});
