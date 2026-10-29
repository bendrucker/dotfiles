import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { quote, repoRoot, shell } from "#harness";

const stubs = `
compdef() { print -r -- "compdef $*"; }
source ${quote(join(repoRoot, "claude", "completion.zsh"))}
_clap_dynamic_completer_wt() { print -r -- "\${(j:|:)words} @\${words[CURRENT]}"; }
`;

function complete(fn: string, words: string[]): string {
  const r = shell(`${stubs}\nwords=(${words.map(quote).join(" ")}); CURRENT=${words.length}; ${fn}`, { shell: "zsh" });
  return r.stdout.trim().split("\n").at(-1) ?? "";
}

describe("worktree launcher completion", () => {
  test("registers cw and cwp", () => {
    const r = shell(stubs, { shell: "zsh" });
    expect(r.stdout.trim().split("\n")).toEqual(["compdef _claude_cw cw", "compdef _claude_cwp cwp"]);
  });

  test("completes cw as wt switch", () => {
    expect(complete("_claude_cw", ["cw", "fe"])).toBe("wt|switch|fe @fe");
  });

  test("completes ccw, which expands to cw --create", () => {
    expect(complete("_claude_cw", ["cw", "--create", "fe"])).toBe("wt|switch|--create|fe @fe");
  });

  test("completes cwp as wt switch --create", () => {
    expect(complete("_claude_cwp", ["cwp", "fe"])).toBe("wt|switch|--create|fe @fe");
  });
});
