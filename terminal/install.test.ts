import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { quote, repoRoot, run, sandbox, type Sandbox } from "#harness";

const installer = join(repoRoot, "terminal", "install.sh");

let box: Sandbox;
let env: Record<string, string>;

beforeEach(() => {
  box = sandbox("terminal-install");
  // What an org that standardizes on SSH installs. It undoes an HTTPS clone.
  const global = box.write("gitconfig", '[url "git@github.com:"]\n\tinsteadOf = https://github.com/\n');
  env = { GIT_CONFIG_GLOBAL: global, GIT_CONFIG_SYSTEM: "/dev/null" };
  box.stub(
    "ya",
    [
      `env | grep '^GIT_CONFIG_' | sort > ${quote(box.path("env"))}`,
      `git ls-remote --get-url https://github.com/yazi-rs/flavors.git > ${quote(box.path("url"))}`,
    ].join("\n"),
  );
});

afterEach(() => {
  box.remove();
});

describe("terminal/install.sh", () => {
  test("clones yazi packages over HTTPS past a rule forcing SSH", () => {
    const r = run([installer], { path: [box.bin], env });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(box.read("env")).toContain("=url.https://github.com/yazi-rs/flavors.insteadOf\n");
    expect(box.read("url").trim()).toBe("https://github.com/yazi-rs/flavors.git");
  });
});
