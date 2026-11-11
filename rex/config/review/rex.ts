import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

// Rex puts itself on PATH only inside its panes. The server runs this with a bare PATH.
const BUNDLED = join(
  homedir(),
  "Library/Application Support/com.superlogical.rex/RexServer/Versions/Current/Rex Server.app/Contents/MacOS/rex",
);

const TERMINAL = "com.superlogical.terminal.shell";

function bin(): string {
  return Bun.which("rex", { PATH: process.env.PATH ?? "" }) ?? BUNDLED;
}

async function rex(args: string[]): Promise<string> {
  const child = Bun.spawn([bin(), ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`rex ${args[0]} exited ${code}: ${stderr.trim()}`);
  return stdout;
}

async function call(session: string, method: string, args: Record<string, unknown>): Promise<unknown> {
  let stdout: string;
  try {
    stdout = await rex(["api", "call", "-s", session, method, JSON.stringify(args)]);
  } catch (err) {
    throw new Error(`${method}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return stdout.trim() === "" ? {} : JSON.parse(stdout);
}

export class Client {
  constructor(readonly session: string) {}

  // A paste goes through the agent's bracketed paste mode. Its newlines don't
  // submit the prompt. The pause lets the paste settle before Enter.
  async submit(block: string, text: string): Promise<void> {
    await call(this.session, "block.event", { block_id: block, event: { type: "paste", payload: { text } } });
    await Bun.sleep(400);
    await rex(["send-key", "-s", this.session, "-b", block, "enter"]);
  }

  async focus(block: string): Promise<void> {
    await rex(["focus", "-s", this.session, block]);
  }

  // The right three-quarters of the agent's pane, leaving the agent a narrow column.
  async newSplit(anchor: string, cwd: string, command: string[]): Promise<string> {
    const created = z.object({ block_ids: z.array(z.string()).min(1) }).parse(
      await call(this.session, "session.new_split", {
        anchor_id: anchor,
        direction: "horizontal",
        side: "after",
        ratio: 0.75,
        focus: true,
        layout: { block: { flavor: TERMINAL, label: "Review", options: { cwd, command } } },
      }),
    );
    return created.block_ids[0];
  }

  // A pane closed by hand is already gone, which is the outcome asked for.
  async closeBlock(block: string): Promise<void> {
    try {
      await call(this.session, "block.close", { block_id: block });
    } catch (err) {
      if (!(err instanceof Error && err.message.includes("not_found"))) throw err;
    }
  }

  // The state of the record the program itself reports. Claude Code's
  // subagents report their own records, each with an id.
  async programState(block: string): Promise<string> {
    const status = z
      .object({ records: z.array(z.object({ id: z.string().optional(), state: z.string() })).nullish() })
      .parse(JSON.parse(await rex(["block", "call", "-s", this.session, "-b", block, "program_status"])));
    return status.records?.find((r) => r.id === undefined)?.state ?? "none";
  }
}
