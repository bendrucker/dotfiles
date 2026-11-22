import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { must, sandbox, type Sandbox } from "#harness";

// A child bun, since the bootstrap job has no node_modules and only `bun run`
// auto-installs the adapter's zod.
const REPLY = `
const { reviewer } = await import(${JSON.stringify(join(import.meta.dir, "plannotator.ts"))});
const [doc, path, id, pid] = process.argv.slice(1);
await reviewer.reply({ cwd: process.cwd(), doc, pid: Number(pid) }, path, { id, author: "user", body: "" }, "removed it");
`;

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

const Store = z.object({
  annotations: z.array(z.object({ id: z.string(), body: z.string(), author_name: z.string().optional() })),
});

function annotations(path: string): z.infer<typeof Store>["annotations"] {
  return Store.parse(JSON.parse(readFileSync(path, "utf8"))).annotations;
}

async function until(check: () => boolean, describe: () => string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out. Screen:\n${describe()}`);
    await Bun.sleep(25);
  }
}

describe("rex/config/review plannotator adapter in plannotator-tui", () => {
  test("the TUI shows the adapter's reply at once and keeps it on save", async () => {
    const work = box.mkdir("work");
    const doc = box.write("work/doc.md", "# Doc\n\nFirst paragraph here.\n\n## Deferred Work\n");
    must(["plannotator-tui", "--annotate-block", doc, "1", "rm this"], { cwd: work, env });
    const path = storePath();
    const [note] = annotations(path);

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
    const entry = join(env.PLANNOTATOR_DATA_DIR, "clients", "plannotator-tui", "sessions", "tui", `${tui.pid}.json`);

    try {
      await until(() => existsSync(entry) || tui.exitCode !== null, text);
      expect(tui.exitCode, text()).toBeNull();
      must([process.execPath, "-e", REPLY, doc, path, note.id, String(tui.pid)], { cwd: work, env });
      await until(() => text().includes("· Claude") && annotations(path).length === 2, text);
      tui.terminal?.write("q");
      expect(await tui.exited).toBe(0);
    } finally {
      tui.kill();
    }
    expect(annotations(path).map((a) => ({ body: a.body, author_name: a.author_name }))).toEqual([
      { body: "rm this", author_name: undefined },
      { body: "removed it", author_name: "Claude" },
    ]);
  }, 15_000);
});
