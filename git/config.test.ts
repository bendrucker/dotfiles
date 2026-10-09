import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { quote, repoRoot, sandbox, shell, type Sandbox } from "#harness";

const config = join(repoRoot, "git", "config");

let box: Sandbox;
let log: string;

// config.local.example writes an unscoped helper, and config.local is included
// before the github blocks. A stub for each records which one git calls.
beforeEach(() => {
  box = sandbox("git-credential");
  log = box.write("calls", "");
  box.write(".config/git/config.local", "[credential]\n  helper = local\n");
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
    env: { HOME: box.dir, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0" },
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

  test("leave other hosts on the machine-local helper", () => {
    credential("approve", "gitlab.com");
    expect(calls()).toEqual(["local store"]);
  });
});
