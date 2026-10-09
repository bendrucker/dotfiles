import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { quote, repoRoot, sandbox, shell, type Sandbox } from "#harness";

const config = join(repoRoot, "git", "config");

let box: Sandbox;
let log: string;

// git/config and config.local.example each add an unscoped helper ahead of the
// github blocks. A stub for each records which one git calls, and GIT_EXEC_PATH
// keeps git from reaching the real git-credential-osxkeychain and its keychain.
beforeEach(() => {
  box = sandbox("git-credential");
  log = box.write("calls", "");
  box.write(".config/git/config.local", "[credential]\n  helper = local\n");
  box.stub("git-credential-osxkeychain", `echo "osxkeychain $1" >> ${quote(log)}`);
  box.stub("git-credential-local", `echo "local $1" >> ${quote(log)}`);
  box.stub(
    "gh",
    `echo "gh $3" >> ${quote(log)}\n[ "$3" = get ] && printf 'username=octocat\\npassword=token\\n'\nexit 0`,
  );
});

afterEach(() => {
  box.remove();
});

function credential(action: "fill" | "approve", host: string): void {
  const input = action === "fill" ? "" : "username=octocat\\npassword=token\\n";
  shell(`printf 'protocol=https\\nhost=%s\\n${input}\\n' "$1" | git credential ${action}`, {
    args: [host],
    path: [box.bin],
    env: {
      HOME: box.dir,
      GIT_EXEC_PATH: box.bin,
      GIT_CONFIG_GLOBAL: config,
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
}

function calls(): string[] {
  return readFileSync(log, "utf8").split("\n").filter(Boolean);
}

// Regression: git calls every helper on approve, so a keychain helper left in
// the list re-prompts even when gh answered the fill.
describe("github credentials", () => {
  test.each(["github.com", "gist.github.com"])("go to gh alone for %s", (host) => {
    credential("fill", host);
    credential("approve", host);
    expect(calls()).toEqual(["gh get", "gh store"]);
  });

  test("leave other hosts on the keychain and machine-local helpers", () => {
    credential("approve", "gitlab.com");
    expect(calls()).toEqual(["osxkeychain store", "local store"]);
  });
});
