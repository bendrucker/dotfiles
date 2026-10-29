import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { type Sandbox, sandbox } from "#harness";
import { call } from "#harness/call";

const module = join(import.meta.dir, "gum.ts");

let box: Sandbox;

beforeEach(() => {
  box = sandbox("gum");
});

afterEach(() => {
  box.remove();
});

function env(): Record<string, string | undefined> {
  return { ...process.env, PATH: `${box.bin}:${process.env.PATH}`, ARGS_LOG: box.path("args") };
}

describe("log", () => {
  test("lets gum write the line", async () => {
    box.stub("gum", 'printf "%s %s\\n" "$3" "$4" >&2');

    const { output } = await call(module, "log", ["warn", "Failed to update alpha"], env());
    expect(output).toBe("warn Failed to update alpha\n");
  });

  test("falls back to a plain line when gum fails", async () => {
    box.stub("gum", "exit 1");

    const { output } = await call(module, "log", ["error", "Sync failed"], env());
    expect(output).toBe("error: Sync failed\n");
  });
});

describe("choose", () => {
  // Echoes the first offered item, after recording its flags.
  const picker = ['printf "%s\\n" "$*" >"$ARGS_LOG"', "head -n 1", 'printf "drawn\\n" >&2'].join("\n");

  test("returns what gum printed and hands it the items on stdin", async () => {
    box.stub("gum", picker);

    const { value } = await call<string[]>(module, "choose", [["one", "two"]], env());
    expect(value).toEqual(["one"]);
    expect(box.read("args")).toBe("choose\n");
  });

  test("draws on the inherited stderr off a terminal", async () => {
    box.stub("gum", picker);

    const { value, output } = await call<string[]>(module, "choose", [["one"], { terminal: null }], env());
    expect(value).toEqual(["one"]);
    expect(output).toBe("drawn\n");
  });

  test("draws on the terminal and keeps the drawing out of the answer", async () => {
    box.stub("gum", picker);
    const terminal = box.path("tty");

    const { value, output } = await call<string[]>(module, "choose", [["one"], { terminal }], env());
    expect(value).toEqual(["one"]);
    expect(output).toBe("");
    expect(box.read("tty")).toBe("drawn\n");
  });

  test.each<{ name: string; options: object; args: string }>([
    { name: "header", options: { header: "Pick" }, args: "choose --header Pick" },
    { name: "no limit", options: { limit: "none" }, args: "choose --no-limit" },
    { name: "limit", options: { limit: 2 }, args: "choose --limit=2" },
    { name: "every item selected", options: { selected: "*" }, args: "choose --selected=*" },
    { name: "some selected", options: { selected: ["one", "two"] }, args: "choose --selected=one,two" },
    { name: "none selected", options: { selected: [] }, args: "choose" },
  ])("passes $name", async ({ options, args }) => {
    box.stub("gum", picker);

    await call(module, "choose", [["one"], options], env());
    expect(box.read("args")).toBe(`${args}\n`);
  });

  test("returns nothing when dismissed", async () => {
    box.stub("gum", 'printf "one\\n"; exit 130');

    const { value } = await call<string[]>(module, "choose", [["one"]], env());
    expect(value).toEqual([]);
  });
});
