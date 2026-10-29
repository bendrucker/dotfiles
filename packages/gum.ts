// gum's log line and picker. gum writes both to stderr, which keeps them out of
// any value read off a child's stdout.

import { $ } from "bun";
import { closeSync, openSync } from "node:fs";
import { writeAll } from "#pipe";

export type Level = "info" | "warn" | "error";

export interface ChooseOptions {
  header?: string;
  limit?: number | "none";
  selected?: string[] | "*";
  // Where gum draws. Defaults to /dev/tty when one opens, and null draws on the
  // inherited stderr.
  terminal?: string | null;
}

export async function log(level: Level, message: string): Promise<void> {
  if ((await $`gum log --level ${level} ${message}`.nothrow()).exitCode !== 0) writeAll(2, `${level}: ${message}\n`);
}

// The selected items, or none when the picker was dismissed. gum sizes its frame
// from the terminal its stderr points at, so a captured stderr would draw an
// invisible prompt that still takes keys.
export async function choose(items: string[], options: ChooseOptions = {}): Promise<string[]> {
  const input = new Response(items.map((item) => `${item}\n`).join(""));
  const flags = [
    ...(options.limit === "none" ? ["--no-limit"] : options.limit === undefined ? [] : [`--limit=${options.limit}`]),
    ...(options.selected === undefined || options.selected.length === 0 ? [] : [`--selected=${[options.selected].flat().join(",")}`]),
    ...(options.header === undefined ? [] : ["--header", options.header]),
  ];
  // Bun Shell takes one redirect per command, so the items arrive through cat.
  const terminal = options.terminal === undefined ? openTerminal() : options.terminal;
  const result = terminal !== null
    ? await $`cat < ${input} | gum choose ${flags} 2>${terminal}`.nothrow().quiet()
    : await $`cat < ${input} | gum choose ${flags}`.nothrow().quiet();
  if (terminal === null) writeAll(2, result.stderr.toString());
  return result.exitCode === 0 ? result.stdout.toString().split("\n").filter((line) => line !== "") : [];
}

function openTerminal(): string | null {
  try {
    closeSync(openSync("/dev/tty", "w"));
    return "/dev/tty";
  } catch {
    return null;
  }
}
