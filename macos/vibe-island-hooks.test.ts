import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { must, run, sandbox, stubGum, type Sandbox } from "#harness";
import type { Output } from "#jobs/output";
import { isRemoteHookRewrite, revertRemoteHookRewrite } from "./vibe-island-hooks";

const LOCAL_HOOK = "$HOME/.claude/hooks/guard.sh";
const REMOTE_HOOK = "VIBE_ISLAND_PORTS=1 ~/.vibe-island/bin/vibe-island-hook --host user@example";
const FILE = "user/settings.json";

function settings(hooks: Record<string, string>, env = "bar"): string {
  const events = Object.fromEntries(
    Object.entries(hooks).map(([event, command]) => [event, [{ hooks: [{ type: "command", command }] }]]),
  );
  return `${JSON.stringify({ env: { EXAMPLE: env }, hooks: events }, null, 2)}\n`;
}

const COMMITTED = settings({ SessionStart: LOCAL_HOOK });

describe("isRemoteHookRewrite", () => {
  test.each<{ name: string; working: string; expected: boolean }>([
    { name: "a rewrite to the remote hook", working: settings({ SessionStart: REMOTE_HOOK }), expected: true },
    {
      name: "a rewrite that also reordered the file",
      working: JSON.stringify({ hooks: JSON.parse(settings({ SessionStart: REMOTE_HOOK })).hooks, env: { EXAMPLE: "bar" } }),
      expected: true,
    },
    { name: "the committed file", working: COMMITTED, expected: false },
    { name: "a rewrite that reaches outside the hooks", working: settings({ SessionStart: REMOTE_HOOK }, "changed"), expected: false },
    {
      name: "a rewrite mixed with a hook edit of its own",
      working: settings({ SessionStart: REMOTE_HOOK, Stop: "echo local" }),
      expected: false,
    },
    { name: "a hook change naming some other command", working: settings({ SessionStart: "echo hello" }), expected: false },
    { name: "a working copy that is not JSON", working: "{ truncated", expected: false },
  ])("$name", ({ working, expected }) => {
    expect(isRemoteHookRewrite(COMMITTED, working)).toBe(expected);
  });
});

describe("revertRemoteHookRewrite", () => {
  let box: Sandbox;
  let repo: string;
  let logged: string[];
  const path = process.env.PATH;

  const out: Output = {
    write(_fd, text) {
      logged.push(text);
    },
    run(cmd, options) {
      const result = run(cmd, { env: options?.env, cwd: options?.cwd });
      logged.push(result.stdout, result.stderr);
      return result.status;
    },
    read(cmd, options) {
      const result = run(cmd, { env: options?.env, cwd: options?.cwd });
      logged.push(result.stderr);
      return { status: result.status, stdout: result.stdout };
    },
  };

  beforeEach(() => {
    box = sandbox("vibe-island-hooks");
    stubGum(box);
    box.stub("osascript", `printf '%s\\n' "$2" >>"${box.path("notifications")}"`);
    process.env.PATH = `${box.bin}:${path}`;
    logged = [];

    repo = box.mkdir("repo");
    box.write(`repo/${FILE}`, COMMITTED);
    must(["git", "init", "-q"], { cwd: repo });
    must(["git", "add", "."], { cwd: repo });
    must(["git", "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-qm", "init"], { cwd: repo });
  });

  afterEach(() => {
    process.env.PATH = path;
    box.remove();
  });

  function status(): string {
    return must(["git", "status", "--porcelain"], { cwd: repo });
  }

  test("restores the committed file and says so", () => {
    box.write(`repo/${FILE}`, settings({ SessionStart: REMOTE_HOOK }));
    revertRemoteHookRewrite(out, repo, FILE, "Claude Sync");

    expect(status()).toBe("");
    expect(logged.join("")).toContain("Reverting Vibe Island's remote hook rewrite");
    expect(box.read("notifications")).toContain("remote hook rewrite");
  });

  test("does not claim a revert it could not make", () => {
    box.write(`repo/${FILE}`, settings({ SessionStart: REMOTE_HOOK }));
    box.write("repo/.git/index.lock", "");
    revertRemoteHookRewrite(out, repo, FILE, "Claude Sync");

    expect(logged.join("")).toContain(`Could not revert ${FILE}`);
    expect(box.read("notifications")).toBe("");
  });

  test("leaves any other change for the gate", () => {
    box.write(`repo/${FILE}`, settings({ SessionStart: REMOTE_HOOK }, "changed"));
    revertRemoteHookRewrite(out, repo, FILE, "Claude Sync");

    expect(status()).not.toBe("");
    expect(box.read("notifications")).toBe("");
  });
});
