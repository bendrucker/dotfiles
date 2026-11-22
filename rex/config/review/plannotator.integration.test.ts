import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { must, sandbox, type Sandbox } from "#harness";
import { reviewer } from "./plannotator";

let box: Sandbox;
let env: Record<string, string>;

beforeEach(() => {
  box = sandbox("plannotator-pty");
  const home = box.mkdir("home");
  env = { HOME: home, PLANNOTATOR_DATA_DIR: join(home, ".plannotator"), TERM: "xterm-256color" };
});

afterEach(() => {
  box.remove();
});

function storePath(): string {
  const base = join(env.PLANNOTATOR_DATA_DIR, "clients", "plannotator-tui", "annotations");
  const [found] = [...new Bun.Glob("*/*/annotations.json").scanSync(base)];
  if (found === undefined) throw new Error(`no store under ${base}`);
  return join(base, found);
}

function replies(path: string): unknown[] {
  return JSON.parse(readFileSync(path, "utf8")).annotations[0].replies;
}

async function until(check: () => boolean, describe: () => string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out. Screen:\n${describe()}`);
    await Bun.sleep(25);
  }
}

describe("rex/config/review plannotator adapter in plannotator-tui", () => {
  test("the TUI opens a store holding the adapter's reply and keeps it on save", async () => {
    const work = box.mkdir("work");
    const doc = box.write("work/doc.md", "# Doc\n\nFirst paragraph here.\n\n## Deferred Work\n");
    must(["plannotator-tui", "--annotate-block", doc, "1", "rm this"], { cwd: work, env });
    const path = storePath();
    const [note] = JSON.parse(readFileSync(path, "utf8")).annotations;
    await reviewer.reply({ cwd: work, doc }, path, { id: note.id, author: "user", body: "rm this" }, "removed it");
    const written = replies(path);

    let screen = "";
    const decoder = new TextDecoder();
    const tui = Bun.spawn(["plannotator-tui", doc], {
      cwd: work,
      env: { ...process.env, ...env },
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
      // A store the TUI can't parse ends it with the error on screen.
      await until(() => text().includes("Deferred Work") || tui.exitCode !== null, text);
      expect(tui.exitCode, text()).toBeNull();
      tui.terminal?.write("q");
      expect(await tui.exited).toBe(0);
    } finally {
      tui.kill();
    }
    expect(replies(path)).toEqual(written);
  }, 15_000);

  // plannotator-tui rewrites the store from memory on every save, so a reply
  // the adapter appends while it is open is lost on its next save.
  test.todo("the TUI keeps a reply the adapter appends while it is open");
});
