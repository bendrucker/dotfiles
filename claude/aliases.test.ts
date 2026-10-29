import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { quote, repoRoot, shell } from "#harness";

const stubs = `
source ${quote(join(repoRoot, "claude", "aliases.zsh"))}
wt() {
  print -r -- "wt \${(j:|:)@}"
  [[ \${@[-1]} == fail ]] && return 1
  [[ \${@[-1]} == cancel ]] || cd /
}
cd "$TMPDIR"
claude() { print -r -- "claude \${(j:|:)\${@:#--append-system-prompt=*}}"; }
git() { print feature; }
pbpaste() { print "the prompt"; }
`;

// `eval` parses the command after the source line runs, as an interactive line
// would be, so `ccw` expands as an alias.
function launch(command: string): string[] {
  const r = shell(`${stubs}\neval ${quote(command)}`, { shell: "zsh" });
  return r.stdout.trim().split("\n");
}

describe("cw", () => {
  test("switches, then starts claude named after the branch", () => {
    expect(launch("cw feature")).toEqual(["wt switch|feature", "claude --name=feature"]);
  });

  test("forwards arguments after -- to claude", () => {
    expect(launch("cw feature -- 'fix it' --model x")).toEqual([
      "wt switch|feature",
      "claude --name=feature|fix it|--model|x",
    ]);
  });

  test("starts no claude when the switch fails", () => {
    expect(launch("cw fail || print stopped")).toEqual(["wt switch|fail", "stopped"]);
  });

  test("starts no claude when the switch exits 0 without moving, as a cancelled picker does", () => {
    expect(launch("cw cancel || print stopped")).toEqual(["wt switch|cancel", "stopped"]);
  });
});

describe("ccw", () => {
  test("creates the branch", () => {
    expect(launch("ccw feature -- hi")).toEqual(["wt switch|--create|feature", "claude --name=feature|hi"]);
  });
});

describe("cwp", () => {
  test("creates the branch and plans from the pasteboard", () => {
    expect(launch("cwp feature")).toEqual([
      "wt switch|--create|feature",
      "claude --name=feature|--permission-mode=plan|the prompt",
    ]);
  });
});
