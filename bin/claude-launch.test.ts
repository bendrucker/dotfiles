import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addDirs, agentId, launchCommand, launchDirs, seedFrom, slugify } from "./claude-launch";

// Every stub records its arguments tab-joined, one call per line, so a message
// carrying spaces survives as one field.
const RECORD = `record() { local IFS=$'\\t'; printf '%s\\n' "$*"; }`;

const CLAUDE_STUB = `#!/usr/bin/env bash
${RECORD}
[ "$1" = "--stub-check" ] && { echo "claude stub"; exit 0; }
if [ "$1" = "agents" ]; then
  [ -f "$CLAUDE_AGENTS" ] || exit 1
  cat "$CLAUDE_AGENTS"
  exit 0
fi
record "$@" >>"$CLAUDE_LOG"
pwd >>"$CLAUDE_CWD"
[ -f "$CLAUDE_DISPATCH" ] && cat "$CLAUDE_DISPATCH"
exit "\${CLAUDE_EXIT:-0}"
`;

const ZOXIDE_STUB = `#!/usr/bin/env bash
[ "$1" = "--stub-check" ] && { echo "zoxide stub"; exit 0; }
[ -f "$ZOXIDE_DIRS" ] || exit 1
cat "$ZOXIDE_DIRS"
`;

const FZF_STUB = `#!/usr/bin/env bash
[ "$1" = "--stub-check" ] && { echo "fzf stub"; exit 0; }
cat >"$FZF_STDIN"
[ -n "$FZF_PICK" ] || exit 130
sed -n "\${FZF_PICK}p" "$FZF_STDIN"
`;

const GUM_STUB = `#!/usr/bin/env bash
${RECORD}
[ "$1" = "--stub-check" ] && { echo "gum stub"; exit 0; }
record "$@" >>"$GUM_LOG"
case "$1" in
  choose)
    case "$3" in
      permission-mode) answer="$GUM_PERMISSION" ;;
      model) answer="$GUM_MODEL" ;;
    esac
    ;;
  write) answer="$GUM_PROMPT" ;;
esac
[ -n "\${answer:-}" ] && [ -f "$answer" ] && cat "$answer"
exit 0
`;

const PBPASTE_STUB = `#!/usr/bin/env bash
[ "$1" = "--stub-check" ] && { echo "pbpaste stub"; exit 0; }
[ -f "$PASTEBOARD" ] || exit 1
cat "$PASTEBOARD"
`;

const SCRIPT = join(import.meta.dir, "claude-launch");
const STUBS: Record<string, string> = {
  claude: CLAUDE_STUB,
  zoxide: ZOXIDE_STUB,
  fzf: FZF_STUB,
  gum: GUM_STUB,
  pbpaste: PBPASTE_STUB,
};

let sandbox: string;
let cwd: string;
// The two launch directories zoxide offers. Real ones, because a dispatch runs
// in the directory that was picked and cannot enter one that is not there.
let first: string;
let second: string;
let path: string;
let variables: Record<string, string>;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "claude-launch-"));
  cwd = join(sandbox, "cwd");
  first = join(sandbox, "one");
  second = join(sandbox, "two");
  for (const dir of [cwd, first, second]) mkdirSync(dir);

  const stubs = join(sandbox, "stub");
  mkdirSync(stubs);
  for (const [name, script] of Object.entries(STUBS)) {
    writeFileSync(join(stubs, name), script);
    chmodSync(join(stubs, name), 0o755);
  }

  // The stub directory ahead of the two system ones, which hold none of the
  // tools under stub and do hold the bash every stub runs on.
  path = `${stubs}:/usr/bin:/bin`;
  variables = {
    PATH: path,
    CLAUDE_LOG: join(sandbox, "claude.log"),
    CLAUDE_CWD: join(sandbox, "claude.cwd"),
    CLAUDE_AGENTS: join(sandbox, "agents.json"),
    CLAUDE_DISPATCH: join(sandbox, "dispatch.out"),
    ZOXIDE_DIRS: join(sandbox, "zoxide.list"),
    FZF_STDIN: join(sandbox, "fzf.stdin"),
    GUM_LOG: join(sandbox, "gum.log"),
    GUM_PERMISSION: join(sandbox, "permission"),
    GUM_MODEL: join(sandbox, "model"),
    GUM_PROMPT: join(sandbox, "prompt"),
    PASTEBOARD: join(sandbox, "pasteboard"),
  };

  for (const log of ["CLAUDE_LOG", "CLAUDE_CWD", "GUM_LOG"]) {
    writeFileSync(variables[log] as string, "");
  }
  writeFileSync(variables.CLAUDE_AGENTS as string, "[]");
  writeFileSync(variables.ZOXIDE_DIRS as string, `${first}\n${second}\n`);
  writeFileSync(variables.CLAUDE_DISPATCH as string, "backgrounded \u00b7 abc123 \u00b7 a-task\n");
  writeFileSync(variables.GUM_PERMISSION as string, "default\n");
  writeFileSync(variables.GUM_MODEL as string, "default\n");
  writeFileSync(variables.GUM_PROMPT as string, "Fix the parser bug\n");
  writeFileSync(variables.PASTEBOARD as string, "");

  proveStubs();
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

// The PATH these cases hand the script is their whole isolation. A stub that
// did not shadow its real binary would let a case dispatch a real background
// agent, open a picker on the terminal, or read the real pasteboard and still
// look like it passed.
function proveStubs(): void {
  for (const name of Object.keys(STUBS)) {
    const run = Bun.spawnSync({
      cmd: [name, "--stub-check"],
      env: { PATH: path },
      stdin: "ignore",
    });
    const said = run.stdout.toString().trim();
    if (said !== `${name} stub`) {
      throw new Error(`the ${name} stub is not on PATH: --stub-check said ${JSON.stringify(said)}`);
    }
  }
}

interface Outcome {
  status: number;
  stdout: string;
}

// Run through bun by path rather than by shebang, so PATH can hold only what
// the case wants the script to find.
function run(args: string[], extra: Record<string, string> = {}): Outcome {
  const spawned = Bun.spawnSync({
    cmd: [process.execPath, SCRIPT, ...args],
    cwd,
    env: { ...process.env, ...variables, ...extra },
    stdin: "ignore",
  });
  return { status: spawned.exitCode, stdout: spawned.stdout.toString() };
}

function read(name: keyof typeof variables): string {
  const file = variables[name] as string;
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

function dispatched(): string[] {
  return read("CLAUDE_LOG").split("\n").filter(Boolean)[0]?.split("\t") ?? [];
}

describe("launchDirs", () => {
  test("puts the in-flight agent directories first", () => {
    expect(launchDirs(["/agent"], ["/frecent"])).toEqual(["/agent", "/frecent"]);
  });

  // fzf is asked not to sort, so the slot a directory wins here is the slot it
  // keeps on screen.
  test("keeps a directory in the first slot it won", () => {
    expect(launchDirs(["/both"], ["/frecent", "/both"])).toEqual(["/both", "/frecent"]);
  });

  test("drops the empty lines a query with no answer contributes", () => {
    expect(launchDirs([], ["", "/frecent", ""])).toEqual(["/frecent"]);
  });
});

describe("slugify", () => {
  test.each<{ name: string; prompt: string; expected: string }>([
    { name: "lowercases and hyphenates", prompt: "Fix The Parser", expected: "fix-the-parser" },
    {
      name: "stops after six words",
      prompt: "one two three four five six seven",
      expected: "one-two-three-four-five-six",
    },
    { name: "reads only the first line", prompt: "first line\nsecond", expected: "first-line" },
    {
      name: "replaces what a name cannot hold",
      prompt: "fix pkg/parse.go",
      expected: "fix-pkg-parse-go",
    },
    { name: "collapses a run of hyphens", prompt: "fix -- the ++ bug", expected: "fix-the-bug" },
    { name: "trims the hyphens off both ends", prompt: "(scoped)", expected: "scoped" },
    { name: "falls back when nothing survives", prompt: "!!! ???", expected: "agent" },
    { name: "falls back on an empty prompt", prompt: "", expected: "agent" },
  ])("$name", ({ prompt, expected }) => {
    expect(slugify(prompt)).toBe(expected);
  });
});

describe("seedFrom", () => {
  test.each<{ name: string; clipboard: string; expected: string }>([
    { name: "a sentence seeds the editor", clipboard: "fix the bug", expected: "fix the bug" },
    {
      name: "a url seeds the editor",
      clipboard: "https://example.test/x",
      expected: "https://example.test/x",
    },
    // The space would otherwise read as a sentence, which is what makes a path
    // carrying one the case the leading-slash guard exists for.
    { name: "a path does not", clipboard: "/src/my repo/file.ts", expected: "" },
    { name: "a bare word does not", clipboard: "deploy", expected: "" },
    { name: "an empty pasteboard does not", clipboard: "", expected: "" },
  ])("$name", ({ clipboard, expected }) => {
    expect(seedFrom(clipboard)).toBe(expected);
  });

  test("a pasteboard past the size limit does not", () => {
    expect(seedFrom(`${"a ".repeat(2001)}`)).toBe("");
  });
});

describe("addDirs", () => {
  test.each<{ name: string; setting: string | undefined; expected: string[] }>([
    { name: "unset adds nothing", setting: undefined, expected: [] },
    { name: "empty adds nothing", setting: "", expected: [] },
    { name: "one directory", setting: "/a", expected: ["/a"] },
    { name: "a colon-separated list", setting: "/a:/b", expected: ["/a", "/b"] },
    { name: "an empty field is not a directory", setting: "/a::/b:", expected: ["/a", "/b"] },
  ])("$name", ({ setting, expected }) => {
    expect(addDirs(setting)).toEqual(expected);
  });
});

describe("launchCommand", () => {
  const launch = { slug: "a-task", permission: "", model: "", addDirs: [], prompt: "do it" };

  test("names the agent and passes the prompt last", () => {
    expect(launchCommand(launch)).toEqual(["claude", "--bg", "--name", "a-task", "do it"]);
  });

  test.each(["", "default"])("leaves the flags off for %p", (skipped) => {
    const command = launchCommand({ ...launch, permission: skipped, model: skipped });
    expect(command).not.toContain("--permission-mode");
    expect(command).not.toContain("--model");
  });

  test("passes a chosen permission mode and model", () => {
    expect(launchCommand({ ...launch, permission: "plan", model: "opus" })).toEqual([
      "claude",
      "--bg",
      "--name",
      "a-task",
      "--permission-mode",
      "plan",
      "--model",
      "opus",
      "do it",
    ]);
  });

  test("repeats --add-dir once per directory", () => {
    expect(launchCommand({ ...launch, addDirs: ["/a", "/b"] })).toEqual([
      "claude",
      "--bg",
      "--name",
      "a-task",
      "--add-dir",
      "/a",
      "--add-dir",
      "/b",
      "do it",
    ]);
  });
});

describe("agentId", () => {
  test("reads the id out of a colored dispatch line", () => {
    const colored = "\u001b[32mbackgrounded\u001b[0m \u00b7 abc123 \u00b7 a-task\nmore\n";
    expect(agentId(colored)).toBe("abc123");
  });

  test("answers with nothing when the line has no id", () => {
    expect(agentId("something else entirely\n")).toBe("");
  });
});

describe("the executable", () => {
  test("prints the usage on --help", () => {
    const outcome = run(["--help"]);
    expect(outcome.status).toBe(0);
    expect(outcome.stdout).toStartWith("usage: claude-launch [--here]");
    expect(read("CLAUDE_LOG")).toBe("");
  });

  test("--here launches where it stands without a picker", () => {
    expect(run(["--here"]).status).toBe(0);
    expect(read("FZF_STDIN")).toBe("");
    expect(read("CLAUDE_CWD").trim()).toBe(realpathSync(cwd));
  });

  test("offers the agent directories above zoxide's", () => {
    writeFileSync(variables.CLAUDE_AGENTS as string, JSON.stringify([{ cwd: second }]));

    expect(run([], { FZF_PICK: "1" }).status).toBe(0);
    expect(read("FZF_STDIN")).toBe(`${second}\n${first}\n`);
    expect(read("CLAUDE_CWD").trim()).toBe(realpathSync(second));
  });

  test("carries on when the agent listing is unavailable", () => {
    rmSync(variables.CLAUDE_AGENTS as string);

    expect(run([], { FZF_PICK: "2" }).status).toBe(0);
    expect(read("FZF_STDIN")).toBe(`${first}\n${second}\n`);
    expect(read("CLAUDE_CWD").trim()).toBe(realpathSync(second));
  });

  test("stops when there is nothing to pick from", () => {
    rmSync(variables.ZOXIDE_DIRS as string);

    expect(run([]).status).toBe(1);
    expect(read("GUM_LOG")).toContain("log\t--level\terror\tno directories from zoxide\n");
    expect(read("CLAUDE_LOG")).toBe("");
  });

  test("stops when the directory picker is dismissed", () => {
    expect(run([]).status).toBe(1);
    expect(read("GUM_LOG")).toContain("log\t--level\twarn\tno directory selected\n");
    expect(read("CLAUDE_LOG")).toBe("");
  });

  test("stops when the task is left empty", () => {
    writeFileSync(variables.GUM_PROMPT as string, "");

    expect(run(["--here"]).status).toBe(1);
    expect(read("GUM_LOG")).toContain("log\t--level\twarn\tno prompt entered\n");
    expect(read("CLAUDE_LOG")).toBe("");
  });

  test("dispatches under a name taken from the task", () => {
    expect(run(["--here"]).status).toBe(0);
    expect(dispatched()).toEqual(["--bg", "--name", "fix-the-parser-bug", "Fix the parser bug"]);
  });

  test("passes the chosen permission mode and model through", () => {
    writeFileSync(variables.GUM_PERMISSION as string, "plan\n");
    writeFileSync(variables.GUM_MODEL as string, "opus\n");

    run(["--here"]);
    expect(dispatched()).toContain("--permission-mode");
    expect(dispatched()).toContain("plan");
    expect(dispatched()).toContain("--model");
    expect(dispatched()).toContain("opus");
  });

  test("adds a tool-access directory per entry in the setting", () => {
    run(["--here"], { CLAUDE_AGENTS_ADD_DIR: "/shared:/notes" });
    expect(dispatched().join(" ")).toContain("--add-dir /shared --add-dir /notes");
  });

  test("seeds the editor from a pasteboard that reads like a task", () => {
    writeFileSync(variables.PASTEBOARD as string, "port the launcher");

    run(["--here"]);
    expect(read("GUM_LOG")).toContain("\t--value\tport the launcher\t");
  });

  test("leaves the editor empty for a pasteboard holding a path", () => {
    writeFileSync(variables.PASTEBOARD as string, "/src/my repo/file.ts");

    run(["--here"]);
    expect(read("GUM_LOG")).toContain("\t--value\t\t");
  });

  test("reports the agent it dispatched", () => {
    const outcome = run(["--here"]);
    expect(outcome.stdout).toContain("backgrounded");
    expect(read("GUM_LOG")).toContain(
      "log\t--level\tinfo\tagent abc123 \u00b7 attach with: claude attach abc123\n",
    );
  });

  test("answers with the status a refused launch exited on", () => {
    const outcome = run(["--here"], { CLAUDE_EXIT: "3" });
    expect(outcome.status).toBe(3);
    expect(read("GUM_LOG")).toContain("log\t--level\terror\tlaunch failed\n");
  });
});
