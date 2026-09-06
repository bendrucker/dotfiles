import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { run } from "./herdr-agent-detection";
import {
  composeText,
  overlayWithout,
  parseManifest,
  recordedWorkingRuleIds,
  ruleIdsOf,
  versionOf,
  workingRuleIds,
} from "../scripts/lib/herdr-agent-manifest.ts";
import {
  compareVersions,
  malformedScreens,
  screenField,
  screenText,
  screensBehindClaude,
  screensDir,
} from "../scripts/lib/herdr-agent-screens.ts";

// The repo this file sits in, which is also the overlay and screen corpus every
// subcommand reads. Only the two XDG roots are redirected, exactly as the
// shellspec did, so the examples run against the real herdr/agent-detection.
const REPO = dirname(import.meta.dir);

// Stands in for herdr's own manifest, carrying the working rules the shipped
// overlay records and the idle rule it outranks.
const BASE_MANIFEST = `id = "claude"
version = "2026.01.01.1"
min_engine_version = 2

[[rules]]
id = "osc_title_working"
state = "working"
priority = 1100
region = "osc_title"

[[rules]]
id = "btw_overlay_working"
state = "working"
priority = 975
region = "bottom_non_empty_lines(5)"

[[rules]]
id = "live_prompt_box"
state = "idle"
priority = 950
region = "prompt_box_body"
`;

const environment = {
  PATH: process.env.PATH,
  XDG_STATE_HOME: process.env.XDG_STATE_HOME,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
};

let sandbox: string;
let stubs: string;
let basePath: string;
let overrideDir: string;
let installedPath: string;

// Answers as herdr would for the three subcommands this program calls. `explain`
// has to report a manifest path without herdr's `remote:` prefix, or the scorer
// reads it as herdr having fallen back to its own manifest, and a `state:` line,
// or it reads it as herdr having failed to answer.
//
// Shell builtins only. $PATH holds nothing but the stub directory, so a stub that
// reached for cat or sed would answer with silence and read as a herdr that said
// something else.
function herdrStub(): string {
  return `#!/bin/sh
printf '%s\\n' "$*" >> "${join(sandbox, "herdr-calls")}"
if [ "$1" = "server" ] && [ "$2" = "agent-manifests" ]; then
  [ -f "${join(sandbox, "served")}" ] || exit 0
  read -r source < "${join(sandbox, "served")}"
  printf '{"result":{"manifests":[{"agent":"claude","source":"%s"}]}}\\n' "$source"
fi
if [ "$1" = "agent" ] && [ "$2" = "explain" ]; then
  printf 'agent: claude\\nstate: idle\\nmanifest: /stub/claude.toml 1\\nrule: none\\n'
fi
exit 0
`;
}

function writeStub(name: string, script: string): void {
  const path = join(stubs, name);
  writeFileSync(path, script);
  chmodSync(path, 0o755);
}

function writeText(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function serve(source: string): void {
  writeFileSync(join(sandbox, "served"), `${source}\n`);
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "herdr-agent-detection-"));
  stubs = join(sandbox, "stub");
  mkdirSync(stubs);

  const state = join(sandbox, "state");
  const config = join(sandbox, "config");
  basePath = join(state, "herdr", "agent-detection", "remote", "claude.toml");
  overrideDir = join(config, "herdr", "agent-detection");
  installedPath = join(overrideDir, "claude.toml");
  mkdirSync(dirname(basePath), { recursive: true });
  mkdirSync(overrideDir, { recursive: true });

  process.env.XDG_STATE_HOME = state;
  process.env.XDG_CONFIG_HOME = config;

  // `sync` reloads herdr after it writes and gives up on a machine with no herdr
  // at all, and neither belongs in a test of what it writes.
  //
  // `open`, `gum` and `osascript` are here for a different reason. A drifting run
  // files a Things to-do, and on the Mac this suite also runs on that is a real
  // to-do in the real Things. The drift path is one edited fixture away at all
  // times, so the stubs are not optional.
  writeStub("herdr", herdrStub());
  writeStub("open", `#!/bin/sh\nprintf '%s\\n' "$1" >> "${join(sandbox, "todos")}"\n`);
  writeStub("gum", "#!/bin/sh\nexit 0\n");
  writeStub("osascript", "#!/bin/sh\nexit 0\n");

  // Nothing but the stubs is reachable, so a call that escapes one fails loudly
  // instead of reaching Things or the machine's real herdr. It also keeps
  // `claude` and `git` off the path, which pins the version-age finding and the
  // to-do revision to one answer.
  process.env.PATH = stubs;
  serve(installedPath);

  // A stub that failed to shadow the real command would file real Things to-dos
  // and drive the real herdr, so prove the shadowing before every example rather
  // than discovering it from the Today list.
  Bun.spawnSync({ cmd: ["open", "stub-probe"], env: process.env });
  const filed = readFileSync(join(sandbox, "todos"), "utf8");
  if (!filed.startsWith("stub-probe")) throw new Error(`open resolved to ${filed}`);
  rmSync(join(sandbox, "todos"));

  Bun.spawnSync({ cmd: ["herdr", "stub-probe"], env: process.env });
  const called = readFileSync(join(sandbox, "herdr-calls"), "utf8");
  if (!called.startsWith("stub-probe")) throw new Error(`herdr resolved to ${called}`);
  rmSync(join(sandbox, "herdr-calls"));
});

afterEach(() => {
  restore("PATH", environment.PATH);
  restore("XDG_STATE_HOME", environment.XDG_STATE_HOME);
  restore("XDG_CONFIG_HOME", environment.XDG_CONFIG_HOME);
  rmSync(sandbox, { recursive: true, force: true });
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

interface Result {
  status: number;
  stdout: string;
  stderr: string;
}

function invoke(...args: string[]): Result {
  const out: string[] = [];
  const err: string[] = [];
  const status = run(args, { out: (l) => out.push(l), err: (l) => err.push(l) }, "had");
  return { status, stdout: out.join("\n"), stderr: err.join("\n") };
}

function writeBase(): void {
  writeFileSync(basePath, BASE_MANIFEST);
}

function todos(): string[] {
  try {
    return readFileSync(join(sandbox, "todos"), "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function clearTodos(): void {
  rmSync(join(sandbox, "todos"), { force: true });
}

function herdrCalls(): string {
  try {
    return readFileSync(join(sandbox, "herdr-calls"), "utf8");
  } catch {
    return "";
  }
}

describe("sync", () => {
  test("installs the cached manifest with the overlay appended", () => {
    writeBase();
    expect(invoke("sync").status).toBe(0);

    const installed = readFileSync(installedPath, "utf8");
    expect(installed).toContain('id = "live_prompt_box"');
    expect(installed).toContain('id = "local_spinner_line_working"');
  });

  test("installs nothing when herdr has cached no manifest", () => {
    const result = invoke("sync");
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("nothing to compose");
    expect(existsSync(installedPath)).toBe(false);
  });

  // The other direction of the same situation: something is installed, so herdr
  // is serving a composed manifest, and the cache it was composed from is gone.
  // Silence here would leave that file frozen for good.
  test("fails when a cache it already composed from has gone missing", () => {
    writeBase();
    expect(invoke("sync").status).toBe(0);
    rmSync(basePath);

    const result = invoke("sync");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("can no longer be recomposed");
  });

  // Installing to a path herdr no longer reads composes, validates and writes
  // without complaint. Only herdr can say whether the file landed anywhere.
  test("fails when herdr reports it is reading a different manifest", () => {
    writeBase();
    expect(invoke("sync").status).toBe(0);
    serve("/somewhere/else.toml");

    const result = invoke("sync");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("herdr is reading /somewhere/else.toml");
  });

  test("passes when herdr reports it is reading what was installed", () => {
    writeBase();
    expect(invoke("sync").status).toBe(0);
    serve(installedPath);

    expect(invoke("sync").status).toBe(0);
  });

  // A server that is not running answers nothing, and no answer must not read as
  // a bad one.
  test("skips the serving check when herdr cannot be asked", () => {
    writeBase();
    expect(invoke("sync").status).toBe(0);
    rmSync(join(sandbox, "served"));

    const result = invoke("sync");
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("herdr is reading");
  });

  test("takes back a file it generated once its overlay is gone", () => {
    writeBase();
    writeText(join(overrideDir, "codex.toml"), "# Generated by bin/herdr-agent-detection: codex\n");

    const result = invoke("sync");
    expect(result.status).toBe(0);
    expect(existsSync(join(overrideDir, "codex.toml"))).toBe(false);
    expect(result.stdout).toContain("removed codex, its overlay is gone");
  });

  test("leaves an override it did not generate alone", () => {
    writeBase();
    writeText(join(overrideDir, "codex.toml"), 'id = "codex"\n');

    expect(invoke("sync").status).toBe(0);
    expect(existsSync(join(overrideDir, "codex.toml"))).toBe(true);
  });

  test("refuses to overwrite a claude override it did not generate", () => {
    writeBase();
    writeFileSync(installedPath, 'id = "claude"\n');

    const result = invoke("sync");
    expect(result.status).toBe(1);
    expect(readFileSync(installedPath, "utf8")).toBe('id = "claude"\n');
    expect(result.stderr).toContain("was not written by this script");
  });

  // Composing is what herdr has to be told about. A run that wrote nothing has
  // nothing to hand it, and the reload is the one call that interrupts a running
  // server.
  test("reloads herdr only when something was written", () => {
    writeBase();
    invoke("sync");
    expect(herdrCalls()).toContain("server reload-agent-manifests");

    rmSync(join(sandbox, "herdr-calls"));
    invoke("sync");
    expect(herdrCalls()).not.toContain("server reload-agent-manifests");
  });
});

// The to-do latch keys on what is wrong, not on the sentence describing it. Both
// of these findings name a version in their message, and both versions move on
// their own: herdr publishes a manifest most weeks and Claude Code ships patches
// most days. A latch holding either would refile the same untouched to-do on
// every release, which is the churn the fingerprint exists to stop.
describe("drift to-do latch", () => {
  const DRIFTING_RULE = `
[[rules]]
id = "screen_spinner_working"
state = "working"
priority = 960
region = "bottom_non_empty_lines(10)"
`;

  function driftAt(version: string): void {
    writeFileSync(
      basePath,
      `${BASE_MANIFEST.replace("2026.01.01.1", version)}${DRIFTING_RULE}`,
    );
  }

  test("stays quiet while the same drift stands", () => {
    writeBase();
    invoke("sync");
    driftAt("2026.01.01.1");
    invoke("sync");

    clearTodos();
    invoke("sync");
    invoke("sync");
    expect(todos()).toEqual([]);
  });

  test("stays quiet when the same drift arrives under a newer manifest", () => {
    writeBase();
    invoke("sync");
    driftAt("2026.01.01.1");
    invoke("sync");

    clearTodos();
    driftAt("2026.02.02.1");
    invoke("sync");
    driftAt("2026.03.03.1");
    invoke("sync");
    expect(todos()).toEqual([]);
  });

  // The latch still has to reopen for a finding that is actually new, which is
  // what keeps the stable key from turning into a permanently closed to-do.
  test("reopens when the rules that disagree change", () => {
    writeBase();
    invoke("sync");
    driftAt("2026.01.01.1");
    invoke("sync");

    clearTodos();
    writeFileSync(
      basePath,
      `${BASE_MANIFEST}${DRIFTING_RULE}
[[rules]]
id = "screen_transcript_working"
state = "working"
priority = 950
region = "bottom_non_empty_lines(10)"
`,
    );
    invoke("sync");
    expect(todos()).toHaveLength(1);
  });
});

describe("check", () => {
  test("reports an install left behind by a newer manifest", () => {
    writeBase();
    invoke("sync");
    writeFileSync(basePath, BASE_MANIFEST.replace("2026.01.01.1", "2026.02.02.1"));

    const result = invoke("check");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("is behind manifest 2026.02.02.1");
  });

  test("reports a manifest that changed which of its rules score working", () => {
    writeBase();
    invoke("sync");
    writeFileSync(
      basePath,
      `${BASE_MANIFEST}
[[rules]]
id = "screen_spinner_working"
state = "working"
priority = 960
region = "bottom_non_empty_lines(10)"
`,
    );

    const result = invoke("check");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("scores working from");
    expect(result.stdout).toContain("screen_spinner_working");
  });

  // A cache herdr truncated mid-write parses as TOML and lists no rules at all.
  // Reading that as a manifest whose working rules went away is the false report
  // the manifest guard exists to stop.
  test("reports a cache holding no rules as one it could not read", () => {
    writeBase();
    invoke("sync");
    writeFileSync(basePath, 'id = "claude"\nversion = "2026.01.01.1"\n');

    const result = invoke("check");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("cached manifest could not be read");
    expect(result.stdout).not.toContain("scores working from");
  });

  test("reports a cache it has nothing to compose from", () => {
    const result = invoke("check");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("claude: herdr has no cached manifest to compose from");
  });
});

describe("invocation", () => {
  test("names the program it was invoked as and exits 2 on anything else", () => {
    const result = invoke("bogus");
    expect(result.status).toBe(2);
    expect(result.stderr).toBe("usage: had [sync|check|verify|ablate]");
  });

  test("defaults to sync", () => {
    writeBase();
    expect(invoke().status).toBe(0);
    expect(existsSync(installedPath)).toBe(true);
  });

  // Positionals past the first have never meant anything here.
  test("ignores extra positionals", () => {
    expect(invoke("check", "and", "more").status).toBe(invoke("check").status);
  });
});

describe("composing", () => {
  test("stamps the base version into the header and appends the overlay", () => {
    const composed = composeText("claude", BASE_MANIFEST, '# base-working-rules: a\nid = "x"\n');
    expect(composed).toBeDefined();
    const lines = (composed ?? "").split("\n");
    expect(lines[0]).toBe(
      "# Generated by bin/herdr-agent-detection: herdr's cached claude manifest",
    );
    expect(lines[1]).toStartWith("# 2026.01.01.1, with herdr/agent-detection/claude.toml appended");
    expect(composed).toEndWith('id = "x"');
  });

  // Streaming the base straight out would let a base that vanished mid-run
  // produce an overlay-only manifest: valid TOML, installs cleanly, and silently
  // drops every upstream rule including the blocked-prompt ones.
  test("fails when either half is empty", () => {
    expect(composeText("claude", "", "rules")).toBeUndefined();
    expect(composeText("claude", BASE_MANIFEST, "\n\n")).toBeUndefined();
  });

  test("reads the version as unknown when the base does not declare one", () => {
    expect(versionOf('id = "claude"\n')).toBe("unknown");
    expect(versionOf("id = \n")).toBe("unknown");
  });
});

describe("manifest reading", () => {
  test("keeps a manifest that could not be read apart from one with no working rules", () => {
    expect(workingRuleIds('[[rules]]\nid = "a"\nstate = "idle"\n')).toEqual([]);
    expect(workingRuleIds('id = "claude"\n')).toBeUndefined();
    expect(workingRuleIds("id = \n")).toBeUndefined();
  });

  test("orders both sides of the drift comparison the same way", () => {
    const manifest = '[[rules]]\nid = "Zulu"\nstate = "working"\n' +
      '[[rules]]\nid = "alpha"\nstate = "working"\n';
    expect(workingRuleIds(manifest)).toEqual(["Zulu", "alpha"]);
    expect(recordedWorkingRuleIds("# base-working-rules:  alpha   Zulu\n")).toEqual([
      "Zulu",
      "alpha",
    ]);
  });

  test("records the empty set for an overlay carrying no recorded line", () => {
    expect(recordedWorkingRuleIds("# nothing here\n")).toEqual([]);
  });

  // herdr's own parser refuses a duplicate top-level key and falls back to its
  // cached remote with a warning nobody reads, so the install gate has to refuse
  // it too.
  test("refuses a manifest that redefines a key", () => {
    expect(parseManifest('id = "a"\nid = "b"\n')).toBeUndefined();
    expect(parseManifest('id = "a"\n')).toEqual({ id: "a" });
  });
});

describe("overlay ablation", () => {
  const overlay = `# base-working-rules: a
# leading comment

[[rules]]
id = "first"
state = "working"

# a comment between the two
[[rules]]
id = "second"
state = "working"
`;

  test("cuts one rule out and keeps everything else, comments included", () => {
    const reduced = overlayWithout(overlay, "second");
    expect(reduced).toContain("# base-working-rules: a");
    expect(reduced).toContain('id = "first"');
    expect(reduced).not.toContain('id = "second"');
    expect(ruleIdsOf(reduced)).toEqual(["first"]);
  });

  test("names the rules in manifest order", () => {
    expect(ruleIdsOf(overlay)).toEqual(["first", "second"]);
  });

  // The cut keys on one exact spelling, so a reformatted overlay silently loses
  // nothing and the rule then reports as moving no screen, which is the sentence
  // that says delete it. Ablation checks for exactly this before it scores.
  test("leaves a differently spelled id in place, which the caller has to catch", () => {
    const reformatted = '[[rules]]\nid="first"\nstate = "working"\n';
    expect(ruleIdsOf(overlayWithout(reformatted, "first"))).toEqual(["first"]);
  });
});

describe("screens", () => {
  let screens: string;

  beforeEach(() => {
    screens = join(sandbox, "screens");
    mkdirSync(screens);
  });

  test("strips the prefix and reads the metadata", () => {
    const text = "# state: working\n# claude-code: 2.1.234\n|>  one\n|>two\n";
    expect(screenText(text)).toBe("  one\ntwo\n");
    expect(screenField(text, "state")).toBe("working");
    expect(screenField(text, "claude-code")).toBe("2.1.234");
    expect(screenField(text, "missing")).toBe("");
  });

  test("names a screen missing either required field", () => {
    writeFileSync(join(screens, "bare.txt"), "|>hello\n");
    expect(malformedScreens("claude", screens).map((found) => found.message)).toEqual([
      "claude: bare.txt has no `# state:` line",
      "claude: bare.txt has no `# claude-code:` line",
    ]);
  });

  // A blank line is neither, and a line missing its `|>` is dropped rather than
  // kept, so every line-counted region under it shifts.
  test("names a screen holding a line that is neither capture nor metadata", () => {
    writeFileSync(
      join(screens, "stray.txt"),
      "# state: idle\n# claude-code: 2.1.234\n|>hello\n\n|>there\n",
    );
    expect(malformedScreens("claude", screens).map((found) => found.message)).toEqual([
      "claude: stray.txt has a line that is neither `|>` screen text nor `#` metadata",
    ]);
  });

  test("passes a well formed screen", () => {
    writeFileSync(join(screens, "good.txt"), "# state: idle\n# claude-code: 2.1.234\n|>hello\n");
    expect(malformedScreens("claude", screens)).toEqual([]);
  });

  test("orders versions numerically rather than as text", () => {
    expect(compareVersions("2.1.9", "2.1.10")).toBeLessThan(0);
    expect(compareVersions("2.1.234", "2.1.234")).toBe(0);
    expect(compareVersions("3.0", "2.99")).toBeGreaterThan(0);
  });
});

describe("screens against the installed Claude Code", () => {
  function stubClaude(version: string): void {
    writeStub("claude", `#!/bin/sh\nprintf '%s (Claude Code)\\n' "${version}"\n`);
    const run = Bun.spawnSync({ cmd: ["claude", "--version"], env: process.env });
    const reported = run.stdout.toString();
    if (!reported.startsWith(version)) throw new Error(`claude resolved to ${reported}`);
  }

  // The screens shipped in this repo were all captured under the same version,
  // so the machine's side is the only thing these move.
  const dir = () => screensDir(REPO, "claude");

  test("reports nothing while the machine is level with the screens", () => {
    stubClaude("2.1.999");
    expect(screensBehindClaude("claude", dir())).toEqual([]);
  });

  test("reports nothing while the machine is pinned behind the screens", () => {
    stubClaude("2.0.1");
    expect(screensBehindClaude("claude", dir())).toEqual([]);
  });

  test("names the gap once the machine has drawn a newer minor", () => {
    stubClaude("3.4.5");
    expect(screensBehindClaude("claude", dir())).toEqual([
      {
        message: "screens were captured under Claude Code 2.1.234, this machine runs 3.4.5",
        key: "claude: screens captured under 2.1, machine runs 3.4",
      },
    ]);
  });

  // The version has to come from the CLI itself, and resolving it rather than
  // reading process.platform is what lets a stub answer for it.
  test("reports nothing where claude does not resolve", () => {
    expect(screensBehindClaude("claude", dir())).toEqual([]);
  });

  test("reports nothing for an agent whose version it cannot ask for", () => {
    stubClaude("3.4.5");
    expect(screensBehindClaude("codex", dir())).toEqual([]);
  });
});

// The rules the whole overlay exists for, scored by herdr rather than by a copy
// of its matching semantics.
//
// Composing needs the manifest herdr fetched, which only exists once herdr has
// run on this machine. On a CI box that has never started it there is nothing to
// compose onto and nothing to score, so both of these skip themselves.
const HERDR = Bun.which("herdr", { PATH: environment.PATH });
const CACHED = join(
  environment.XDG_STATE_HOME || join(process.env.HOME ?? "", ".local", "state"),
  "herdr",
  "agent-detection",
  "remote",
  "claude.toml",
);

function noHerdrToScoreWith(): boolean {
  if (HERDR === null) return true;
  try {
    return readFileSync(CACHED, "utf8") === "";
  } catch {
    return true;
  }
}

describe.skipIf(noHerdrToScoreWith())("scoring against the real herdr", () => {
  // Runs the real herdr, which the setup above shadows with a stub for every
  // other example, since scoring is what is under test. The XDG roots still point
  // at the sandbox, so this scores against a copy of the cached manifest and
  // leaves the machine's own alone.
  function againstCached(subcommand: string): Result {
    writeFileSync(basePath, readFileSync(CACHED, "utf8"));
    process.env.PATH = environment.PATH ?? "";
    return invoke(subcommand);
  }

  // Which screens currently disagree is a property of the manifest herdr last
  // fetched, not of this code, so asserting a particular verdict would fail on
  // any machine whose corpus has drifted. What must hold either way is that the
  // status follows the report and every line it prints is a scored screen.
  test("reports a scored verdict for every screen that disagrees", () => {
    const result = againstCached("verify");
    const reported = result.stdout.split("\n").filter((line) => line !== "");
    for (const line of reported) {
      expect(line).toMatch(/^\S+: \S+ scores \S+, and records \S+$/);
    }
    expect(result.status).toBe(reported.length === 0 ? 0 : 1);
  });

  // Ablation is only worth reading if the manifest under test actually loaded.
  // herdr falls back to the one it fetched when it cannot parse an override, and
  // taking a rule out is exactly the edit that produces unparseable TOML, so a
  // broken harness reports every rule as moving nothing, which reads as evidence
  // that no rule is doing anything. A screen that moves when the overlay comes
  // out is proof the overlay was in.
  test("reports which screens each overlay rule is holding up", () => {
    const result = againstCached("ablate");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("without local_spinner_line_working");
    expect(result.stdout).toContain("without local_background_agent_working");
    expect(result.stdout).toContain("without the overlay");

    // Which screen moves depends on the cached manifest, so name none. That one
    // moves at all is the proof the harness wanted: it can only happen if the
    // composed manifest loaded, and a manifest herdr rejected scores every rule
    // as moving nothing.
    const withoutOverlay = result.stdout.split("without the overlay\n")[1] ?? "";
    expect(withoutOverlay).toMatch(/\S+: \S+ → \S+/);
  });
});
