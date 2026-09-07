import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  arrayBody,
  cliChoices,
  cliFlags,
  choiceDrift,
  confirmsCommand,
  declaredChoices,
  declaredCommands,
  declaredFlags,
  defaultCompletionFile,
  difference,
  optionEntries,
  parseChoiceGroup,
  render,
  run,
  scrapedCommandNames,
  scrapedUsageNames,
  specNamesFlag,
  visibleCommands,
} from "./claude-audit-completions";

// The shape `claude --help` really has: a spec and its description separated by a
// gap, continuations indented to the description column, and a spec long enough
// that its description starts on the following line with no gap at all.
const HELP = [
  "Usage: claude [options] [command] [prompt]",
  "",
  "Options:",
  "  --add-dir <directories...>            Additional directories to allow tool",
  "                                        access to",
  "  --allowedTools, --allowed-tools <tools...>",
  '      Comma or space-separated list of tool names to allow (e.g. "Bash(git *)',
  '      Edit")',
  "  --effort <level>                      Effort level for the current session",
  "                                        (low, medium, high, xhigh, max)",
  "  --exclude-dynamic-system-prompt-sections",
  "      Move per-machine sections into the first user message (ignored with",
  "      --system-prompt). (default: false)",
  "  --prompt-suggestions [value]          Enable prompt suggestions (choices:",
  '                                        "true", "false", preset: "true")',
  "  -h, --help                            Display help for command",
  "",
  "Commands:",
  "  install [options] [target]            Install Claude Code native build. Use",
  "                                        [target] to specify version",
  "  plugin|plugins                        Manage Claude Code plugins",
  "  stop|kill <id>                        Stop a background session",
  "",
].join("\n");

// The flags HELP declares, which the clean completion below has to match exactly.
const HELP_FLAGS = [
  "--add-dir",
  "--allowed",
  "--allowed-tools",
  "--effort",
  "--exclude-dynamic-system-prompt-sections",
  "--help",
  "--prompt-suggestions",
];

const COMPLETION_FLAGS = [
  "'--add-dir[Additional directories]:directories:_directories'",
  "'--allowedTools[Tools to allow]:tools:'",
  "'--allowed-tools[Tools to allow]:tools:'",
  "'--effort[Effort level]:level:(low medium high xhigh max)'",
  "'--exclude-dynamic-system-prompt-sections[Move per-machine sections]'",
  "'-h[Display help for command]'",
  "'--help[Display help for command]'",
  "'--prompt-suggestions[Enable prompt suggestions]::value:(true false)'",
];

const COMPLETION_COMMANDS = [
  "'attach:Open a background session'",
  "'install:Install Claude Code native build'",
  "'kill:Stop a background session'",
  "'logs:Print a background session output'",
  "'plugin:Manage Claude Code plugins'",
  "'remote-control:Start the Remote Control server'",
  "'respawn:Restart a background session'",
  "'rm:Delete a background session'",
  "'sandbox:Run in a sandbox'",
  "'stop:Stop a background session'",
];

function completionFile(flags: string[], commands: string[]): string {
  return [
    "#!/usr/bin/env zsh",
    "",
    "_claude() {",
    "  local -a main_options=(",
    ...flags.map((flag) => `    ${flag}`),
    "  )",
    "",
    "  local -a subcommands=(",
    ...commands.map((command) => `    ${command}`),
    "  )",
    "}",
    "",
  ].join("\n");
}

const CLAUDE_STUB = `#!/bin/sh
case "$1" in
  stub-probe) printf 'claude-stub\\n'; exit 0 ;;
  --help) cat "$AUDIT_FIXTURES/help.txt"; exit "\${CLAUDE_HELP_STATUS:-0}" ;;
esac
if [ -f "$AUDIT_FIXTURES/cmd-$1" ]; then
  cat "$AUDIT_FIXTURES/cmd-$1"
  exit 0
fi
printf 'Usage: claude [options] [command] [prompt]\\n'
exit 0
`;

const STRINGS_STUB = `#!/bin/sh
case "$1" in
  stub-probe) printf 'strings-stub\\n'; exit 0 ;;
esac
cat "$AUDIT_FIXTURES/strings-$2.txt"
`;

const environment = {
  PATH: process.env.PATH,
  CLAUDE_COMPLETION_FILE: process.env.CLAUDE_COMPLETION_FILE,
  AUDIT_FIXTURES: process.env.AUDIT_FIXTURES,
  CLAUDE_HELP_STATUS: process.env.CLAUDE_HELP_STATUS,
};

let sandbox: string;
let stubs: string;
let tools: string;
let fixtures: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "claude-audit-completions-"));
  stubs = join(sandbox, "stub");
  tools = join(sandbox, "tools");
  fixtures = join(sandbox, "fixtures");
  mkdirSync(stubs);
  mkdirSync(tools);
  mkdirSync(fixtures);

  // The only real binary the stubs use, linked in by the path this process
  // resolved it at, so $PATH below can hold nothing else. A `strings` inherited
  // from a system directory would answer the missing-strings example with the
  // real one and scrape a shell script instead.
  const cat = Bun.which("cat", { PATH: environment.PATH });
  if (cat === null) throw new Error("cat is not on PATH");
  symlinkSync(cat, join(tools, "cat"));

  writeStub(join(stubs, "claude"), CLAUDE_STUB);
  writeStub(join(stubs, "strings"), STRINGS_STUB);

  writeFixture("help.txt", HELP);
  // Two names the scrape finds and the oracle then splits: `sandbox` is a real
  // hidden command, `xaa` is the kind of junk token the binary is full of.
  writeFixture("strings-8.txt", ['"claude sandbox', '"claude xaa'].join("\n"));
  writeFixture("strings-4.txt", '.command("serve"');
  writeFixture("cmd-sandbox", "Usage: claude sandbox [options] [command]");
  writeFixture("cmd-attach", "Usage: claude attach <id>");
  // An alias resolving to its target, which the oracle has to accept.
  writeFixture("cmd-kill", "Usage: claude stop <id>");
  writeFixture("cmd-logs", "Usage: claude logs <id>");
  writeFixture("cmd-rm", "Usage: claude rm <id>");
  writeFixture("cmd-respawn", "Usage: claude respawn [options] [id]");

  process.env.PATH = `${stubs}:${tools}`;
  process.env.AUDIT_FIXTURES = fixtures;
  delete process.env.CLAUDE_HELP_STATUS;
  process.env.CLAUDE_COMPLETION_FILE = writeCompletion(COMPLETION_FLAGS, COMPLETION_COMMANDS);

  // A stub that failed to shadow the real command would run the machine's own
  // `claude` roughly ten times per example and audit whatever it reports, so
  // prove the shadowing before every one rather than reading it out of a
  // report that looks plausible.
  proveStub("claude", "claude-stub");
  proveStub("strings", "strings-stub");
});

afterEach(() => {
  restore("PATH", environment.PATH);
  restore("CLAUDE_COMPLETION_FILE", environment.CLAUDE_COMPLETION_FILE);
  restore("AUDIT_FIXTURES", environment.AUDIT_FIXTURES);
  restore("CLAUDE_HELP_STATUS", environment.CLAUDE_HELP_STATUS);
  rmSync(sandbox, { recursive: true, force: true });
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function writeStub(path: string, script: string): void {
  writeFileSync(path, script);
  chmodSync(path, 0o755);
}

function writeFixture(name: string, content: string): void {
  writeFileSync(join(fixtures, name), `${content}\n`);
}

function writeCompletion(flags: string[], commands: string[]): string {
  const path = join(sandbox, "completion.zsh");
  writeFileSync(path, completionFile(flags, commands));
  return path;
}

function proveStub(command: string, expected: string): void {
  const probed = Bun.spawnSync({ cmd: [command, "stub-probe"], env: process.env });
  const said = probed.stdout.toString().trim();
  if (said !== expected) {
    const resolved = Bun.which(command, { PATH: process.env.PATH });
    throw new Error(`${command} resolved to ${resolved} and said ${said}`);
  }
}

describe("options block folding", () => {
  test("joins a wrapped description onto its flag with a single space", () => {
    const entries = optionEntries(HELP);
    expect(entries[0].folded).toBe(
      "  --add-dir <directories...>            Additional directories to allow tool access to",
    );
  });

  test("starts a new entry at each two-space hyphen line", () => {
    expect(optionEntries(HELP).map((entry) => entry.spec)).toEqual([
      "  --add-dir <directories...>",
      "  --allowedTools, --allowed-tools <tools...>",
      "  --effort <level>",
      "  --exclude-dynamic-system-prompt-sections",
      "  --prompt-suggestions [value]",
      "  -h, --help",
    ]);
  });

  test("ends the block at Commands: and keeps its entries out", () => {
    expect(optionEntries(HELP).some((entry) => entry.folded.includes("install"))).toBe(false);
  });

  test("flushes the entry left pending at end of input", () => {
    const entries = optionEntries(["Options:", "  --only <x>   The only flag"].join("\n"));
    expect(entries).toEqual([{ spec: "  --only <x>", folded: "  --only <x>   The only flag" }]);
  });

  test("ignores a line before the block opens", () => {
    expect(optionEntries("  --before <x>  Not in a block")).toEqual([]);
  });
});

describe("CLI flag extraction", () => {
  test("takes long flags from every spec", () => {
    expect(cliFlags(optionEntries(HELP))).toEqual(HELP_FLAGS);
  });

  test("truncates a camelCase flag at the first character outside [a-z-]", () => {
    expect(cliFlags(optionEntries(HELP))).toContain("--allowed");
    expect(cliFlags(optionEntries(HELP))).not.toContain("--allowedTools");
  });

  test("excludes short flags", () => {
    expect(cliFlags(optionEntries(HELP))).not.toContain("-h");
  });

  // The spec is cut from the unfolded first line, where the gap that separates it
  // from the description is still intact. The bash cut after folding, so a
  // description that began on the following line was scanned whole and
  // `--exclude-dynamic-system-prompt-sections` contributed `--system-prompt` as a
  // flag of its own.
  test("keeps a flag named only in another flag's description out of the set", () => {
    expect(cliFlags(optionEntries(HELP))).not.toContain("--system-prompt");
  });

  test("keeps a flag named behind the gap on its own line out of the set", () => {
    const help = ["Options:", "  --real <x>   Behaves like --imaginary does"].join("\n");
    expect(cliFlags(optionEntries(help))).toEqual(["--real"]);
  });
});

describe("visible commands", () => {
  test("splits alias forms and ignores wrapped description lines", () => {
    expect(visibleCommands(HELP)).toEqual(["install", "plugin", "stop"]);
  });

  test("drops the alias half, which is why kill needs the oracle", () => {
    expect(visibleCommands(HELP)).not.toContain("kill");
    expect(visibleCommands(HELP)).not.toContain("plugins");
  });
});

describe("the command oracle", () => {
  test("accepts a usage line naming the command", () => {
    expect(confirmsCommand("Usage: claude sandbox [options] [command]")).toBe(true);
  });

  test("accepts an alias resolving to its target", () => {
    expect(confirmsCommand("Usage: claude stop <id>")).toBe(true);
  });

  test("rejects the top-level fallback", () => {
    expect(confirmsCommand("Usage: claude [options] [command] [prompt]")).toBe(false);
  });

  test("rejects an empty first line, which is why remote-control is allowlisted", () => {
    expect(confirmsCommand("")).toBe(false);
  });
});

describe("binary scrape", () => {
  test("reads command names out of usage strings", () => {
    expect(scrapedUsageNames('"claude sandbox\n"claude remote-control\n"claude X')).toEqual([
      "sandbox",
      "remote-control",
    ]);
  });

  test("reads command names out of .command() calls", () => {
    expect(scrapedCommandNames('.command("serve"\n.command("Login"')).toEqual(["serve"]);
  });
});

describe("choice group parsing", () => {
  test("reads a choices: list", () => {
    expect(parseChoiceGroup('choices: "text", "stream-json"')).toEqual({
      kind: "values",
      values: ["stream-json", "text"],
    });
  });

  test("reads a bare comma-separated list", () => {
    expect(parseChoiceGroup("low, medium, high, xhigh, max")).toEqual({
      kind: "values",
      values: ["high", "low", "max", "medium", "xhigh"],
    });
  });

  // The bash kept only double quotes, so `preset: "true"` survived as a field
  // that failed the token test and took the whole list with it. Dropping the
  // field that names a default is what lets the eight spellings through.
  test("drops a field naming a default", () => {
    expect(parseChoiceGroup('choices: "true", "false", "on", "off", preset: "true"')).toEqual({
      kind: "values",
      values: ["false", "off", "on", "true"],
    });
    expect(parseChoiceGroup('choices: "host", "none", default: "host"')).toEqual({
      kind: "values",
      values: ["host", "none"],
    });
  });

  test("rejects a prose aside with no comma", () => {
    expect(parseChoiceGroup("only works with --print")).toEqual({ kind: "none" });
  });

  test("rejects a prose aside that has one", () => {
    expect(parseChoiceGroup("auto, or 100k-1M tokens")).toEqual({ kind: "none" });
  });

  // Stripping single quotes is not enough to rescue this one: `e.g. fable` and
  // `or sonnet` are still multi-word fields. The contract expected the strip
  // alone to make --model readable, and it does not.
  test("rejects an example list even with its single quotes stripped", () => {
    expect(parseChoiceGroup("e.g. 'fable', 'opus', or 'sonnet'")).toEqual({ kind: "none" });
  });

  test("rejects a single value", () => {
    expect(parseChoiceGroup("default")).toEqual({ kind: "none" });
  });

  // A group the CLI marks as choices and this cannot read is a different answer
  // from a flag that declares none, so the report can say the flag went
  // unchecked instead of passing it silently.
  test("reports an unreadable choices: list as unparsed", () => {
    expect(parseChoiceGroup('choices: "a b", "c d"')).toEqual({
      kind: "unparsed",
      text: 'choices: "a b", "c d"',
    });
  });
});

describe("CLI choice lookup", () => {
  test("finds the list for a flag whose description wrapped", () => {
    expect(cliChoices(optionEntries(HELP), "--effort")).toEqual({
      kind: "values",
      values: ["high", "low", "max", "medium", "xhigh"],
    });
  });

  test("walks past prose groups to the choices one", () => {
    const help = [
      "Options:",
      '  --input-format <format>   Input format (only works with --print): "text"',
      '                            (default) (choices: "text", "stream-json")',
    ].join("\n");
    expect(cliChoices(optionEntries(help), "--input-format")).toEqual({
      kind: "values",
      values: ["stream-json", "text"],
    });
  });

  test("reports no list for a flag the help does not declare", () => {
    expect(cliChoices(optionEntries(HELP), "--nowhere")).toEqual({ kind: "none" });
  });

  // `index(spec, flag)` accepted the first spec containing the flag anywhere, so
  // a flag that is a prefix of a longer one listed first took the wrong list.
  test("matches the flag as a token rather than a substring", () => {
    const help = [
      "Options:",
      "  --debug-file <path>   Debug file (alpha, beta)",
      "  --debug <filter>      Debug (gamma, delta)",
    ].join("\n");
    expect(cliChoices(optionEntries(help), "--debug")).toEqual({
      kind: "values",
      values: ["delta", "gamma"],
    });
  });

  test("names a flag listed first in a comma-separated spec", () => {
    expect(specNamesFlag("  --allowedTools, --allowed-tools <tools...>", "--allowed-tools")).toBe(
      true,
    );
    expect(specNamesFlag("  --allowedTools, --allowed-tools <tools...>", "--allowed")).toBe(false);
  });
});

describe("completion file extraction", () => {
  const source = completionFile(COMPLETION_FLAGS, COMPLETION_COMMANDS);

  test("reads the top-level flag array", () => {
    expect(declaredFlags(source)).toEqual(HELP_FLAGS);
  });

  test("reads the top-level command array", () => {
    expect(declaredCommands(source)).toEqual([
      "attach",
      "install",
      "kill",
      "logs",
      "plugin",
      "remote-control",
      "respawn",
      "rm",
      "sandbox",
      "stop",
    ]);
  });

  test("stops at the two-space closing paren", () => {
    expect(arrayBody(source, "main_options")).toHaveLength(COMPLETION_FLAGS.length);
  });

  test("reports a missing array rather than an empty one", () => {
    expect(declaredFlags("nothing here")).toBeUndefined();
    expect(declaredCommands("nothing here")).toBeUndefined();
  });

  test("ignores a nested per-subcommand array", () => {
    const nested = `${source}\n  local -a plugin_subcommands=(\n    '--nested[Nested]'\n  )\n`;
    expect(declaredFlags(nested)).toEqual(HELP_FLAGS);
  });

  test("reads a flag's action values", () => {
    expect(declaredChoices(source, "--effort")).toEqual([
      "high",
      "low",
      "max",
      "medium",
      "xhigh",
    ]);
  });

  test("takes the first occurrence in the file", () => {
    const twice = `${source}\n    '--effort[Later]:level:(second later)'\n`;
    expect(declaredChoices(twice, "--effort")).toEqual(["high", "low", "max", "medium", "xhigh"]);
  });

  test("reads no values from a flag with no action", () => {
    expect(declaredChoices(source, "--help")).toEqual([]);
  });

  // An action holding only whitespace killed the bash run outright: the
  // non-empty guard passed and the `grep -vx ''` behind it matched nothing.
  test("reads no values from an action holding only spaces", () => {
    expect(declaredChoices("    '--blank[Blank]:value:(   )'", "--blank")).toEqual([]);
  });
});

describe("set differences", () => {
  test("keeps only what the other side lacks", () => {
    expect(difference(["a", "b", "c"], ["b"])).toEqual(["a", "c"]);
    expect(difference(["a"], ["a"])).toEqual([]);
  });
});

describe("choice drift", () => {
  const source = completionFile(COMPLETION_FLAGS, COMPLETION_COMMANDS);
  const entries = optionEntries(HELP);

  test("finds nothing when both sides agree", () => {
    expect(choiceDrift(entries, source, HELP_FLAGS)).toEqual({ rows: [], unchecked: [] });
  });

  test("reports a flag whose lists differ", () => {
    const narrowed = source.replace("(low medium high xhigh max)", "(low medium)");
    expect(choiceDrift(entries, narrowed, HELP_FLAGS).rows).toEqual([
      {
        flag: "--effort",
        cli: ["high", "low", "max", "medium", "xhigh"],
        completion: ["low", "medium"],
      },
    ]);
  });

  test("lists a flag whose CLI choices could not be read", () => {
    const help = [
      "Options:",
      '  --shape <shape>   Shape (choices: "a b", "c d")',
    ].join("\n");
    const completion = completionFile(["'--shape[Shape]:shape:(a b)'"], COMPLETION_COMMANDS);
    const drift = choiceDrift(optionEntries(help), completion, ["--shape"]);
    expect(drift.rows).toEqual([]);
    expect(drift.unchecked).toEqual([
      '--shape: CLI declares choices this audit cannot read: (choices: "a b", "c d")',
    ]);
  });
});

describe("report rendering", () => {
  const empty = {
    missingCommands: [],
    staleCommands: [],
    missingFlags: [],
    staleFlags: [],
    choices: [],
    notes: [],
  };

  test("prints every section and the clean verdict", () => {
    expect(render(empty, "/repo/claude/completion.zsh")).toEqual({
      status: 0,
      stderr: "",
      stdout: [
        "",
        "Commands in CLI but missing from completion.zsh:",
        "  (none)",
        "",
        "Commands in completion.zsh but not confirmed in the CLI:",
        "  (none)",
        "",
        "Flags in CLI but missing from completion.zsh:",
        "  (none)",
        "",
        "Flags in completion.zsh but not in current CLI --help:",
        "  (none)",
        "",
        "Choice-value drift:",
        "  (none)",
        "",
        "No drift. completion.zsh matches the installed claude CLI.",
        "",
      ].join("\n"),
    });
  });

  test("indents each entry by two spaces and exits 1", () => {
    const outcome = render({ ...empty, missingCommands: ["import", "sandbox"] }, "/c.zsh");
    expect(outcome.status).toBe(1);
    expect(outcome.stdout).toContain(
      "\nCommands in CLI but missing from completion.zsh:\n  import\n  sandbox\n",
    );
    expect(outcome.stdout).toEndWith("\nDrift found. Reconcile /c.zsh and re-run.\n");
  });

  test("prints a choice row as cli and completion lists", () => {
    const outcome = render(
      { ...empty, choices: [{ flag: "--effort", cli: ["a", "b"], completion: ["a"] }] },
      "/c.zsh",
    );
    expect(outcome.stdout).toContain("\n  --effort  cli=(a b) completion=(a)\n");
  });

  // A note says what could not be checked, not what drifted, so it prints
  // without moving the exit status.
  test("prints notes without calling them drift", () => {
    const outcome = render({ ...empty, notes: ["strings is not on PATH"] }, "/c.zsh");
    expect(outcome.status).toBe(0);
    expect(outcome.stdout).toContain("\nNotes:\n  strings is not on PATH\n");
    expect(outcome.stdout).toEndWith(
      "\nNo drift. completion.zsh matches the installed claude CLI.\n",
    );
  });
});

describe("invocation", () => {
  test("prints usage for --help", () => {
    const outcome = run(["--help"]);
    expect(outcome.status).toBe(0);
    expect(outcome.stdout).toStartWith("Usage: claude-audit-completions\n");
  });

  // The bash ignored every argument. A misspelt one now says so.
  test("refuses an unknown argument", () => {
    const outcome = run(["--some-flag"]);
    expect(outcome.status).toBe(2);
    expect(outcome.stdout).toBe("");
    expect(outcome.stderr).toContain("--some-flag");
  });

  test("refuses a positional argument", () => {
    expect(run(["positional"]).status).toBe(2);
  });

  test("defaults to the completion file beside the real script", () => {
    expect(defaultCompletionFile()).toEndWith("/claude/completion.zsh");
    expect(statSync(defaultCompletionFile()).isFile()).toBe(true);
  });
});

describe("missing inputs", () => {
  test("exits 2 when claude is not on PATH", () => {
    process.env.PATH = tools;
    expect(run([])).toEqual({ status: 2, stdout: "", stderr: "claude not found on PATH\n" });
  });

  test("exits 2 when the completion file is absent", () => {
    const path = join(sandbox, "absent.zsh");
    process.env.CLAUDE_COMPLETION_FILE = path;
    expect(run([])).toEqual({
      status: 2,
      stdout: "",
      stderr: `completion file not found: ${path}\n`,
    });
  });

  test("exits 2 when the completion path is a directory", () => {
    process.env.CLAUDE_COMPLETION_FILE = fixtures;
    expect(run([]).status).toBe(2);
  });

  test("exits 2 when the completion path is a dangling symlink", () => {
    const path = join(sandbox, "dangling.zsh");
    symlinkSync(join(sandbox, "nowhere.zsh"), path);
    process.env.CLAUDE_COMPLETION_FILE = path;
    expect(run([]).stderr).toBe(`completion file not found: ${path}\n`);
  });

  test("names claude first when both inputs are broken", () => {
    process.env.PATH = tools;
    process.env.CLAUDE_COMPLETION_FILE = join(sandbox, "absent.zsh");
    expect(run([]).stderr).toBe("claude not found on PATH\n");
  });
});

// Each of these killed the bash run with status 1 and no output at all, which is
// the status a caller reads as ordinary drift.
describe("shapeless inputs", () => {
  test("exits 2 on a completion file with no subcommands array", () => {
    const path = join(sandbox, "shapeless.zsh");
    writeFileSync(path, "nothing here\n");
    process.env.CLAUDE_COMPLETION_FILE = path;
    expect(run([])).toEqual({
      status: 2,
      stdout: "",
      stderr: `completion file declares no subcommands array: ${path}\n`,
    });
  });

  test("exits 2 on a completion file with no main_options array", () => {
    const path = join(sandbox, "commands-only.zsh");
    writeFileSync(
      path,
      ["  local -a subcommands=(", ...COMPLETION_COMMANDS.map((c) => `    ${c}`), "  )", ""].join(
        "\n",
      ),
    );
    process.env.CLAUDE_COMPLETION_FILE = path;
    expect(run([]).stderr).toBe(`completion file declares no main_options array: ${path}\n`);
  });

  test("exits 2 when claude --help declares no options", () => {
    writeFixture("help.txt", "boom");
    process.env.CLAUDE_HELP_STATUS = "1";
    expect(run([])).toEqual({
      status: 2,
      stdout: "",
      stderr: "claude --help declared no options\n",
    });
  });
});

describe("end to end", () => {
  test("reports no drift when the completion matches", () => {
    const outcome = run([]);
    expect(outcome.stderr).toBe("");
    expect(outcome.stdout).toBe(
      [
        "",
        "Commands in CLI but missing from completion.zsh:",
        "  (none)",
        "",
        "Commands in completion.zsh but not confirmed in the CLI:",
        "  (none)",
        "",
        "Flags in CLI but missing from completion.zsh:",
        "  (none)",
        "",
        "Flags in completion.zsh but not in current CLI --help:",
        "  (none)",
        "",
        "Choice-value drift:",
        "  (none)",
        "",
        "No drift. completion.zsh matches the installed claude CLI.",
        "",
      ].join("\n"),
    );
    expect(outcome.status).toBe(0);
  });

  test("reports every kind of drift at once", () => {
    const path = writeCompletion(
      [
        ...COMPLETION_FLAGS.filter((flag) => !flag.startsWith("'--add-dir")).map((flag) =>
          flag.replace("(low medium high xhigh max)", "(low medium)"),
        ),
        "'--legacy[A flag the CLI dropped]'",
      ],
      [
        ...COMPLETION_COMMANDS.filter((command) => !command.startsWith("'install")),
        "'gone:A command the CLI dropped'",
      ],
    );
    process.env.CLAUDE_COMPLETION_FILE = path;

    const outcome = run([]);
    expect(outcome.status).toBe(1);
    expect(outcome.stdout).toBe(
      [
        "",
        "Commands in CLI but missing from completion.zsh:",
        "  install",
        "",
        "Commands in completion.zsh but not confirmed in the CLI:",
        "  gone",
        "",
        "Flags in CLI but missing from completion.zsh:",
        "  --add-dir",
        "",
        "Flags in completion.zsh but not in current CLI --help:",
        "  --legacy",
        "",
        "Choice-value drift:",
        "  --effort  cli=(high low max medium xhigh) completion=(low medium)",
        "",
        `Drift found. Reconcile ${path} and re-run.`,
        "",
      ].join("\n"),
    );
  });

  test("confirms a hidden command the scrape found and the oracle accepted", () => {
    // `sandbox` reaches the confirmed set only through the scrape, so with the
    // scrape working the completion's entry for it is not stale.
    expect(run([]).stdout).not.toContain("sandbox");
  });

  test("rejects the junk tokens the scrape picks up alongside real commands", () => {
    const path = writeCompletion(COMPLETION_FLAGS, [
      ...COMPLETION_COMMANDS,
      "'xaa:A junk token'",
      "'serve:A nested subcommand'",
    ]);
    process.env.CLAUDE_COMPLETION_FILE = path;
    expect(run([]).stdout).toContain(
      "Commands in completion.zsh but not confirmed in the CLI:\n  serve\n  xaa\n",
    );
  });

  test("falls back to the seed list and says so when strings is absent", () => {
    rmSync(join(stubs, "strings"));
    expect(Bun.which("strings", { PATH: process.env.PATH })).toBeNull();

    const outcome = run([]);
    expect(outcome.status).toBe(1);
    expect(outcome.stdout).toContain(
      "Notes:\n  strings is not on PATH, so no hidden command was scraped from the binary\n",
    );
    // The seed list still confirms every hidden command it names, so only the
    // scrape's own find is lost.
    expect(outcome.stdout).toContain(
      "Commands in completion.zsh but not confirmed in the CLI:\n  sandbox\n",
    );
  });

  // A shell script shadowing the real CLI on $PATH yields nothing from `strings`,
  // and the bash reported that as a clean scrape.
  test("says when the scrape came back empty off a script", () => {
    writeFixture("strings-8.txt", "");
    writeFixture("strings-4.txt", "");
    const expected =
      `Notes:\n  no hidden command was scraped from ${join(stubs, "claude")}, ` +
      "which holds a script rather than a binary\n";
    expect(run([]).stdout).toContain(expected);
  });
});
