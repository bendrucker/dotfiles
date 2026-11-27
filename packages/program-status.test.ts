import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { sandbox, type Sandbox } from "#harness";
import { encode, report } from "#program-status";

let box: Sandbox;

beforeEach(() => {
  box = sandbox("program-status");
});

afterEach(() => {
  box.remove();
});

describe("encode", () => {
  test("names the record after the title", () => {
    expect(encode("Dotfiles Sync", { state: "working" })).toBe(
      "\x1b]7501;state=working:id=dotfiles-sync:app=dotfiles:title=RG90ZmlsZXMgU3luYw==\x1b\\",
    );
  });

  test("a blocked report carries its kind and message", () => {
    const sequence = encode("Claude Sync", { state: "blocked", kind: "question", msg: "Local changes" });
    expect(sequence).toEndWith(":kind=question:msg=TG9jYWwgY2hhbmdlcw==\x1b\\");
  });
});

describe("report", () => {
  test("writes the sequence to the terminal", () => {
    const tty = box.path("tty");
    report("Claude Sync", { state: "done" }, tty);
    expect(readFileSync(tty, "utf8")).toBe(encode("Claude Sync", { state: "done" }));
  });

  test("does nothing without a terminal", () => {
    expect(() => report("Claude Sync", { state: "done" }, box.path("missing", "tty"))).not.toThrow();
  });
});
