import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ignoresModes, writeStub } from "#harness";
import { fixture } from "#harness/fixture";
import type { Capture, SpawnOptions } from "#jobs/output";
import {
  claudeRepoHome,
  failureFields,
  failureFingerprint,
  installAgentHooks,
  installDependencies,
  main,
  pruneMarketplaces,
  prunePlugins,
  repoRevision,
  revertCosmeticJsonChanges,
  sync,
  syncRepo,
  updateMarketplaces,
  updatePlugins,
  versionMeta,
} from "./claude-sync";

let sandbox: string;
let stubs: string;
let repo: string;
let out: Capture;

const environment = {
  HOME: process.env.HOME,
  PATH: process.env.PATH,
  XDG_STATE_HOME: process.env.XDG_STATE_HOME,
  THINGS_DATABASE: process.env.THINGS_DATABASE,
  CLAUDE_REPO_HOME: process.env.CLAUDE_REPO_HOME,
};

// Every branch under test is a sequence of real git and CLI calls, so the
// children run for real. What they write is kept rather than let through to the
// test runner's own streams, which is also how an example reads the log the job
// produced.
function recording(): Capture {
  const chunks: string[] = [];
  const keep = (text: string): void => {
    if (text !== "") chunks.push(text);
  };

  const spawn = (
    cmd: string[],
    options?: SpawnOptions,
  ): { status: number; stdout: string; stderr: string } => {
    try {
      const run = Bun.spawnSync({
        cmd,
        cwd: options?.cwd,
        env: options?.env ?? process.env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      return {
        status: run.exitCode,
        stdout: run.stdout.toString(),
        stderr: run.stderr.toString(),
      };
    } catch {
      return { status: 127, stdout: "", stderr: "" };
    }
  };

  return {
    write(_fd, text) {
      keep(text);
    },
    run(cmd, options) {
      // Answer `gum log` in-process. The job logs a few lines per step, and a
      // spawn for each is most of a test.
      if (cmd[0] === "gum" && cmd[1] === "log") {
        keep(`${cmd.at(-1)}\n`);
        return 0;
      }
      const result = spawn(cmd, options);
      keep(result.stdout);
      keep(result.stderr);
      return result.status;
    },
    read(cmd, options) {
      const result = spawn(cmd, options);
      keep(result.stderr);
      return { status: result.status, stdout: result.stdout };
    },
    captured() {
      return chunks.join("");
    },
  };
}

function readLog(name: string): string {
  try {
    return readFileSync(join(sandbox, name), "utf8");
  } catch {
    return "";
  }
}

function todoCount(): number {
  return readLog("todos").split("\n").filter(Boolean).length;
}

function run(cmd: string[]): void {
  const result = Bun.spawnSync({ cmd, env: process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`${cmd.join(" ")} exited ${result.exitCode}: ${result.stderr.toString()}`);
  }
}

function git(...args: string[]): string {
  const result = Bun.spawnSync({
    cmd: ["git", "-C", repo, ...args],
    env: process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return result.stdout.toString();
}

function settingsStatus(): "clean" | "dirty" {
  return git("status", "--porcelain", "user/settings.json").trim() === "" ? "clean" : "dirty";
}

// `claude plugin list --json` and the marketplace manifests are the whole of what
// the inventory reads, so a file the example writes is what the CLI reports.
const claudeStub = [
  '[ "$1" = "--version" ] && { printf "claude 1.2.3\\n"; exit 0; }',
  '[ -n "$CLAUDE_DRAINS_STDIN" ] && cat >/dev/null',
  'case "$2" in',
  '  list)   cat "$HOME/plugin-list.json" ;;',
  "  update)",
  // The id is the last argument, because the call names its scope in front of it.
  "    for last; do :; done",
  "    printf 'update %s\\n' \"$last\" >>\"$CLAUDE_PLUGIN_LOG\"",
  '    case " $CLAUDE_UPDATE_FAILS " in *" $last "*) exit 1 ;; esac',
  // The intermittent shape the retry exists for: the first attempt refuses and
  // the next one takes.
  '    case " $CLAUDE_UPDATE_FAILS_ONCE " in',
  '      *" $last "*)',
  '        [ -f "$HOME/refused-$last" ] || { : >"$HOME/refused-$last"; exit 1; }',
  "        ;;",
  "    esac",
  "    ;;",
  "  install) printf 'install %s\\n' \"$3\" >>\"$CLAUDE_PLUGIN_LOG\" ;;",
  "  prune)",
  "    printf 'prune\\n' >>\"$CLAUDE_PLUGIN_LOG\"",
  // The real CLI declines with exit 0 when an installed plugin fails to load.
  '    [ -n "$CLAUDE_PRUNE_SKIPS" ] && { printf "Skipped — cannot determine orphans\\n"; exit 0; }',
  '    printf "Nothing to prune.\\n"',
  "    ;;",
  // The name follows the verb, so a remove is `plugin marketplace remove <name>`.
  "  marketplace)",
  '    [ "$3" = "update" ] && printf \'update %s\\n\' "$4" >>"$HOME/refresh.log"',
  '    [ "$3" = "update" ] && [ -n "$CLAUDE_REFRESH_FAILS" ] && exit 1',
  '    [ "$3" = "remove" ] || exit 0',
  "    printf 'marketplace remove %s\\n' \"$4\" >>\"$CLAUDE_PLUGIN_LOG\"",
  '    case " $CLAUDE_REMOVE_FAILS " in *" $4 "*) exit 1 ;; esac',
  "    ;;",
  "  uninstall)",
  // The id is the last argument, because the call names its scope in front of it.
  "    for last; do :; done",
  "    printf 'uninstall %s\\n' \"$last\" >>\"$CLAUDE_PLUGIN_LOG\"",
  '    case " $CLAUDE_UNINSTALL_FAILS " in *" $last "*) exit 1 ;; esac',
  "    ;;",
  "esac",
  "exit 0",
].join("\n");

interface Listed {
  id: string;
  installPath: string;
  scope?: string;
}

function writePluginList(listed: Listed[]): void {
  writeFileSync(
    join(sandbox, "plugin-list.json"),
    JSON.stringify(listed.map((row) => ({ scope: "user", ...row, enabled: true }))),
  );
}

function payload(...segments: string[]): string {
  const path = join(sandbox, ".claude", "plugins", "cache", ...segments);
  mkdirSync(path, { recursive: true });
  return path;
}

// The CLI's own install record, the only place it marks a plugin it installed
// as another plugin's dependency.
function writeInstalled(auto: string[]): void {
  const dir = join(sandbox, ".claude", "plugins");
  mkdirSync(dir, { recursive: true });
  const plugins = Object.fromEntries(auto.map((id) => [id, [{ scope: "user", auto: true }]]));
  writeFileSync(join(dir, "installed_plugins.json"), JSON.stringify({ version: 2, plugins }));
}

function writeMarketplace(name: string, entries: unknown[]): void {
  const dir = join(sandbox, ".claude", "plugins", "marketplaces", name, ".claude-plugin");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "marketplace.json"), JSON.stringify({ name, plugins: entries }));
}

function writeSettings(
  enabled: Record<string, boolean>,
  marketplaces: Record<string, unknown> = {},
): void {
  mkdirSync(join(sandbox, ".claude"), { recursive: true });
  writeFileSync(
    join(sandbox, ".claude", "settings.json"),
    JSON.stringify({ enabledPlugins: enabled, extraKnownMarketplaces: marketplaces }),
  );
}

function writeKnownMarketplaces(names: string[], local: Record<string, string> = {}): void {
  const dir = join(sandbox, ".claude", "plugins");
  mkdirSync(dir, { recursive: true });
  const remote = names.map((name) => [name, { source: { source: "github" } }]);
  const registered = Object.entries(local).map(([name, path]) => [
    name,
    { source: { source: "directory", path }, installLocation: path },
  ]);
  writeFileSync(
    join(dir, "known_marketplaces.json"),
    JSON.stringify(Object.fromEntries([...remote, ...registered])),
  );
}

// A marketplace registered from a local path, as the config repo is. Claude Code
// keeps no copy of it under marketplaces/, so its manifest is read where it is.
function writeLocalMarketplace(name: string, entries: unknown[]): string {
  const root = join(sandbox, "local", name);
  mkdirSync(join(root, ".claude-plugin"), { recursive: true });
  writeFileSync(join(root, ".claude-plugin", "marketplace.json"), JSON.stringify({ name, plugins: entries }));
  writeKnownMarketplaces(["first", "third"], { [name]: root });
  return root;
}

// alpha, beta and gamma are installed and offered by their marketplaces. The
// disabled entry is recorded as an explicit false rather than dropped, which is
// what a reader of the keys alone would install.
function writePluginFixture(): void {
  writePluginList([
    { id: "alpha@first", installPath: payload("first", "alpha", "1.0.0") },
    { id: "beta@third", installPath: payload("third", "beta", "abc123") },
    { id: "gamma@first", installPath: payload("first", "gamma", "1.0.0") },
  ]);
  writeMarketplace("first", [
    { name: "alpha", source: "./plugins/alpha" },
    { name: "gamma", source: "./plugins/gamma" },
  ]);
  writeMarketplace("third", [{ name: "beta", source: "./plugins/beta" }]);
  writeKnownMarketplaces(["first", "third"]);
}

// Committed to the repo, which ~/.claude/settings.json links into.
const DECLARATION = {
  enabledPlugins: { "alpha@first": true, "beta@third": true, "gamma@first": true, "disabled@first": false },
  extraKnownMarketplaces: { first: {}, third: {} },
};

const HOOK = '/bin/sh -c [ -x "$HOME/bin/hook" ] && exit 0';

function settingsJson(command: unknown, extra = "bar"): unknown {
  return {
    ...DECLARATION,
    env: { EXAMPLE: extra },
    hooks: { SessionStart: [{ hooks: [{ type: "command", command }] }] },
  };
}

const REX_COMMAND = "/bin/sh -c 'rex __internal session-start --agent claude 2>/dev/null || true'";
const REX_EVENT = { UserPromptSubmit: [{ hooks: [{ type: "command", command: REX_COMMAND }] }] };

function withRexHook(settings: unknown, command = REX_COMMAND): unknown {
  const base = settings as { hooks: { SessionStart: unknown[] } };
  const group = { hooks: [{ type: "command", command }] };
  return { ...base, hooks: { ...base.hooks, SessionStart: [...base.hooks.SessionStart, group] } };
}

function withRexEvent(settings: unknown): unknown {
  const base = settings as { hooks: object };
  return { ...base, hooks: { ...base.hooks, ...REX_EVENT } };
}

function repoSettingsText(): string {
  return readFileSync(join(repo, "user", "settings.json"), "utf8");
}

function settingsLink(): string {
  return join(sandbox, ".claude", "settings.json");
}

function linked(): boolean {
  return lstatSync(settingsLink()).isSymbolicLink();
}

function replaceLink(settings: unknown): void {
  rmSync(settingsLink());
  writeFileSync(settingsLink(), `${JSON.stringify(settings)}\n`);
}

function writeRepoSettings(settings: unknown, indent = 2): void {
  writeFileSync(join(repo, "user", "settings.json"), `${JSON.stringify(settings, null, indent)}\n`);
}

// The repo `~/.claude/settings.json` links into.
function buildRepo(root: string): void {
  const repo = join(root, "repo");
  const origin = join(root, "origin.git");
  run(["git", "init", "-q", "--bare", "-b", "main", origin]);
  run(["git", "init", "-q", "-b", "main", repo]);
  run(["git", "-C", repo, "config", "user.email", "spec@example.test"]);
  run(["git", "-C", repo, "config", "user.name", "Spec"]);
  run(["git", "-C", repo, "config", "commit.gpgsign", "false"]);
  run(["git", "-C", repo, "remote", "add", "origin", origin]);
  mkdirSync(join(repo, "user"));
  writeFileSync(join(repo, "user", "settings.json"), `${JSON.stringify(settingsJson(HOOK), null, 2)}\n`);
  run(["git", "-C", repo, "add", "-A"]);
  run(["git", "-C", repo, "commit", "-q", "-m", "settings"]);
  run(["git", "-C", repo, "push", "-q", "-u", "origin", "main"]);
  run(["git", "-C", repo, "remote", "set-head", "origin", "main"]);
}

const copyRepo = fixture(buildRepo);

// rex writes through the ~/.claude/settings.json link, as the real one does.
function rexStub(hookLog: string): string {
  return [
    `printf '%s %s\\n' "rex" "$*" >>"${hookLog}"`,
    `jq '. + {"rex":1}' "$HOME/.claude/settings.json" >"$HOME/.claude/settings.json.new"`,
    `cat "$HOME/.claude/settings.json.new" >"$HOME/.claude/settings.json"`,
    `rm "$HOME/.claude/settings.json.new"`,
    '[ -n "$REX_FAILS" ] && exit 1',
    "exit 0",
  ].join("\n");
}

beforeEach(() => {
  // A refused plugin update pauses before its retry, and the pause is real time
  // with nothing to assert about it.
  spyOn(Bun, "sleepSync").mockImplementation(() => {});
  sandbox = mkdtempSync(join(tmpdir(), "claude-sync-"));
  stubs = join(sandbox, "stub");
  repo = join(sandbox, "repo");
  mkdirSync(stubs);

  writeStub(join(stubs, "claude"), claudeStub);
  writeStub(
    join(stubs, "bun"),
    [
      `printf '%s %s\\n' "$PWD" "$*" >>"${join(sandbox, "bun.log")}"`,
      '[ -n "$BUN_INSTALL_FAILS" ] && exit 1',
      "exit 0",
    ].join("\n"),
  );
  // The spin branch runs the command after the separator, and log echoes the
  // message to stderr, where the real gum writes it.
  writeStub(
    join(stubs, "gum"),
    [
      'case "$1" in',
      "  spin)",
      "    shift",
      '    while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done',
      '    [ "$1" = "--" ] && shift',
      '    exec "$@"',
      "    ;;",
      "  log)",
      '    for last; do :; done',
      '    printf "%s\\n" "$last" >&2',
      "    ;;",
      "esac",
      "exit 0",
    ].join("\n"),
  );
  // A to-do is filed by handing a things:/// URL to `open`, so a logged line is
  // the whole observation of whether a latch let one through.
  writeStub(join(stubs, "open"), `printf '%s\\n' "$2" >>"${join(sandbox, "todos")}"`);
  writeStub(join(stubs, "osascript"), `printf '%s\\n' "$2" >>"${join(sandbox, "notifications")}"`);
  // A to-do names the machine it was filed from and is keyed on the hardware, so
  // both answers come from a stub rather than from whichever machine runs this.
  writeStub(join(stubs, "scutil"), `printf '%s\\n' 'Testbox'`);
  writeStub(join(stubs, "ioreg"), `printf '"IOPlatformUUID" = "%s"\\n' 0000-TEST`);
  // herdr writes through the link, or replaces it with HERDR_REPLACES. It writes
  // before it can fail, so a failed run still leaves an entry for the discard to
  // take back. rex writes through the link and moshi-hook replaces it, as the
  // real ones do.
  const hookLog = join(sandbox, "hooks.log");
  const replaceLink = (name: string) =>
    `jq '. + {"${name}":1}' "$HOME/.claude/settings.json" >"$HOME/.claude/settings.json.new" && mv "$HOME/.claude/settings.json.new" "$HOME/.claude/settings.json"`;
  writeStub(
    join(stubs, "herdr"),
    [
      `printf '%s %s\\n' "herdr" "$*" >>"${hookLog}"`,
      `if [ -n "$HERDR_REPLACES" ]; then ${replaceLink("herdr")}; else printf '{"herdr":1}\\n' >"$AGENT_HOOK_REPO/user/settings.json"; fi`,
      `[ -n "$HERDR_LOCKS" ] && chmod 0444 "$AGENT_HOOK_REPO/user/settings.json"`,
      '[ -n "$HERDR_FAILS" ] && exit 1',
      "exit 0",
    ].join("\n"),
  );
  writeStub(join(stubs, "rex"), rexStub(hookLog));
  writeStub(
    join(stubs, "moshi-hook"),
    [
      `printf '%s %s\\n' "moshi-hook" "$*" >>"${hookLog}"`,
      replaceLink("moshi-hook"),
      "exit 0",
    ].join("\n"),
  );

  process.env.HOME = sandbox;
  process.env.PATH = `${stubs}:${environment.PATH}`;
  process.env.XDG_STATE_HOME = join(sandbox, "state");
  process.env.THINGS_DATABASE = join(sandbox, "things.sqlite");
  process.env.CLAUDE_PLUGIN_LOG = join(sandbox, "plugin.log");
  process.env.CLAUDE_UPDATE_FAILS = "";
  process.env.CLAUDE_UPDATE_FAILS_ONCE = "";
  process.env.CLAUDE_UNINSTALL_FAILS = "";
  process.env.CLAUDE_REMOVE_FAILS = "";
  process.env.CLAUDE_DRAINS_STDIN = "";
  process.env.AGENT_HOOK_REPO = repo;
  process.env.HERDR_FAILS = "";
  process.env.HERDR_LOCKS = "";
  process.env.HERDR_REPLACES = "";
  process.env.REX_FAILS = "";
  process.env.BUN_INSTALL_FAILS = "";
  writeFileSync(process.env.CLAUDE_PLUGIN_LOG, "");

  writePluginFixture();

  copyRepo(sandbox);
  symlinkSync(join(repo, "user", "settings.json"), settingsLink());

  // A stub that failed to shadow the real CLI would enumerate this machine's own
  // plugins, and every example after it would be asserting against the runner.
  const probe = Bun.spawnSync({ cmd: ["claude", "plugin", "list", "--json"], env: process.env, stdout: "pipe" });
  if (!probe.stdout.toString().includes("alpha@first")) {
    throw new Error(`claude resolved to ${probe.stdout.toString()}`);
  }

  out = recording();
});

afterEach(() => {
  mock.restore();
  process.env.HOME = environment.HOME;
  process.env.PATH = environment.PATH;
  if (environment.XDG_STATE_HOME === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = environment.XDG_STATE_HOME;
  if (environment.THINGS_DATABASE === undefined) delete process.env.THINGS_DATABASE;
  else process.env.THINGS_DATABASE = environment.THINGS_DATABASE;
  if (environment.CLAUDE_REPO_HOME === undefined) delete process.env.CLAUDE_REPO_HOME;
  else process.env.CLAUDE_REPO_HOME = environment.CLAUDE_REPO_HOME;
  delete process.env.CLAUDE_PLUGIN_LOG;
  delete process.env.CLAUDE_UPDATE_FAILS;
  delete process.env.CLAUDE_UPDATE_FAILS_ONCE;
  delete process.env.CLAUDE_REFRESH_FAILS;
  delete process.env.CLAUDE_UNINSTALL_FAILS;
  delete process.env.CLAUDE_DRAINS_STDIN;
  delete process.env.CLAUDE_PRUNE_SKIPS;
  delete process.env.AGENT_HOOK_REPO;
  delete process.env.HERDR_FAILS;
  delete process.env.HERDR_LOCKS;
  delete process.env.HERDR_REPLACES;
  delete process.env.REX_FAILS;
  delete process.env.BUN_INSTALL_FAILS;
  rmSync(sandbox, { recursive: true, force: true });
});

describe("prunePlugins", () => {
  test("uninstalls a payload settings.json no longer names", () => {
    writePluginList([
      { id: "alpha@first", installPath: payload("first", "alpha", "1.0.0") },
      { id: "stray@first", installPath: payload("first", "stray", "1.0.0") },
    ]);
    writeSettings({ "alpha@first": true });

    expect(prunePlugins(out, process.env)).toBe(true);
    expect(readLog("plugin.log")).toContain("uninstall stray@first");
    expect(readLog("plugin.log")).not.toContain("uninstall alpha@first");
  });

  // The fixture records `disabled@first` as an explicit false, which is a plugin
  // installed and turned off rather than one nothing names.
  test("keeps a plugin declared with an explicit false", () => {
    writePluginList([
      { id: "alpha@first", installPath: payload("first", "alpha", "1.0.0") },
      { id: "disabled@first", installPath: payload("first", "disabled", "1.0.0") },
    ]);

    expect(prunePlugins(out, process.env)).toBe(true);
    expect(readLog("plugin.log")).toBe("prune\n");
  });

  // Claude Code installs a dependency without writing a settings.json key for
  // it, so the declaration alone would take it out from under the plugin that
  // needs it every night.
  test("leaves a dependency to the CLI's own prune", () => {
    writePluginList([
      { id: "alpha@first", installPath: payload("first", "alpha", "1.0.0") },
      { id: "gamma@first", installPath: payload("first", "gamma", "1.0.0") },
    ]);
    writeSettings({ "alpha@first": true });
    writeInstalled(["gamma@first"]);

    expect(prunePlugins(out, process.env)).toBe(true);
    expect(readLog("plugin.log")).toBe("prune\n");
  });

  // The prune follows the uninstalls, so a dependency only the removed plugin
  // named is no longer needed by the time it looks.
  test("prunes dependencies after uninstalling", () => {
    writePluginList([{ id: "stray@first", installPath: payload("first", "stray", "1.0.0") }]);
    writeSettings({ "alpha@first": true });

    expect(prunePlugins(out, process.env)).toBe(true);
    expect(readLog("plugin.log")).toBe("uninstall stray@first\nprune\n");
  });

  test("fails when the CLI declines to prune", () => {
    writeSettings({ "alpha@first": true });
    process.env.CLAUDE_PRUNE_SKIPS = "1";

    expect(prunePlugins(out, process.env)).toBe(false);
    expect(out.captured()).toContain("Skipped");
  });

  // A declaration that could not be read accounts for nothing, and acting on it
  // would uninstall every plugin on the machine.
  test("uninstalls nothing when the declaration cannot be read", () => {
    writeFileSync(join(sandbox, ".claude", "settings.json"), "not json\n");

    expect(prunePlugins(out, process.env)).toBe(false);
    expect(readLog("plugin.log")).toBe("");
    expect(out.captured()).toContain("claude-plugins:");
  });

  // The shape a broken symlink into the config repo leaves behind. An absent
  // file is not a declaration that nothing belongs here.
  test("uninstalls nothing when settings.json is not there", () => {
    rmSync(join(sandbox, ".claude", "settings.json"), { force: true });

    expect(prunePlugins(out, process.env)).toBe(false);
    expect(readLog("plugin.log")).toBe("");
  });

  // Read as empty, every dependency would look undeclared and go.
  test("uninstalls nothing when the install record cannot be read", () => {
    writePluginList([
      { id: "alpha@first", installPath: payload("first", "alpha", "1.0.0") },
      { id: "stray@first", installPath: payload("first", "stray", "1.0.0") },
    ]);
    writeSettings({ "alpha@first": true });
    writeFileSync(join(sandbox, ".claude", "plugins", "installed_plugins.json"), "not json\n");

    expect(prunePlugins(out, process.env)).toBe(false);
    expect(readLog("plugin.log")).toBe("");
  });

  // Pruning against a partial inventory reports success over payloads it never
  // saw, which is the silence the whole job exists to break.
  test("fails when the installed plugins cannot be enumerated", () => {
    writeFileSync(join(sandbox, "plugin-list.json"), "not json\n");

    expect(prunePlugins(out, process.env)).toBe(false);
    expect(out.captured()).toContain("claude-plugins:");
  });

  test("fails when an uninstall fails", () => {
    writePluginList([{ id: "stray@first", installPath: payload("first", "stray", "1.0.0") }]);
    writeSettings({ "alpha@first": true });
    process.env.CLAUDE_UNINSTALL_FAILS = "stray@first";

    expect(prunePlugins(out, process.env)).toBe(false);
    expect(out.captured()).toContain("Failed to uninstall stray@first");
  });

  // A plugin declared but never installed has no payload, so there is nothing
  // for the prune to reach and the update pass installs it instead.
  test("leaves a declared plugin that is not installed alone", () => {
    writePluginList([{ id: "alpha@first", installPath: payload("first", "alpha", "1.0.0") }]);
    writeSettings({ "alpha@first": true, "gamma@first": true });

    expect(prunePlugins(out, process.env)).toBe(true);
    expect(readLog("plugin.log")).toBe("prune\n");
  });
});

describe("pruneMarketplaces", () => {
  test("removes a registration settings.json no longer names", () => {
    writeKnownMarketplaces(["first", "third", "stray"]);

    expect(pruneMarketplaces(out, process.env)).toBe(true);
    expect(readLog("plugin.log")).toContain("marketplace remove stray");
    expect(readLog("plugin.log")).not.toContain("marketplace remove first");
  });

  // A project's plugins get no user-scope key.
  test("keeps a marketplace a plugin outside the user scope came from", () => {
    writePluginList([
      { id: "alpha@first", installPath: payload("first", "alpha", "1.0.0") },
      { id: "delta@second", installPath: payload("second", "delta", "1.0.0"), scope: "project" },
    ]);
    writeKnownMarketplaces(["first", "second"]);

    expect(pruneMarketplaces(out, process.env)).toBe(true);
    expect(readLog("plugin.log")).toBe("");
  });

  test("removes nothing when nothing is registered", () => {
    rmSync(join(sandbox, ".claude", "plugins", "known_marketplaces.json"), { force: true });

    expect(pruneMarketplaces(out, process.env)).toBe(true);
    expect(readLog("plugin.log")).toBe("");
  });

  // Acting on a declaration nothing could read would remove every marketplace.
  test("removes nothing when the declaration cannot be read", () => {
    writeFileSync(join(sandbox, ".claude", "settings.json"), "not json\n");

    expect(pruneMarketplaces(out, process.env)).toBe(false);
    expect(readLog("plugin.log")).toBe("");
    expect(out.captured()).toContain("claude-marketplaces:");
  });

  // The shape a broken symlink into the config repo leaves behind.
  test("removes nothing when settings.json is not there", () => {
    rmSync(join(sandbox, ".claude", "settings.json"), { force: true });

    expect(pruneMarketplaces(out, process.env)).toBe(false);
    expect(readLog("plugin.log")).toBe("");
  });

  // An unreadable listing names nothing in use, so every name reads unaccounted.
  test("removes nothing when the installed plugins cannot be enumerated", () => {
    writeFileSync(join(sandbox, "plugin-list.json"), "not json\n");
    writeKnownMarketplaces(["first", "stray"]);

    expect(pruneMarketplaces(out, process.env)).toBe(false);
    expect(readLog("plugin.log")).toBe("");
  });

  // Reading it as empty would report success over a prune that never ran.
  test("fails when the registry cannot be read", () => {
    writeFileSync(join(sandbox, ".claude", "plugins", "known_marketplaces.json"), "not json\n");

    expect(pruneMarketplaces(out, process.env)).toBe(false);
    expect(out.captured()).toContain("claude-marketplaces:");
  });

  test("fails when a removal fails", () => {
    writeKnownMarketplaces(["first", "third", "stray"]);
    process.env.CLAUDE_REMOVE_FAILS = "stray";

    expect(pruneMarketplaces(out, process.env)).toBe(false);
    expect(out.captured()).toContain("Failed to remove stray");
  });
});

describe("updatePlugins", () => {
  test("updates every installed plugin", () => {
    expect(updatePlugins(out, process.env)).toBe(true);
    expect(readLog("plugin.log")).toContain("update alpha@first");
    expect(readLog("plugin.log")).toContain("update beta@third");
  });

  // Counting failures and returning 0 is what let a machine where every update
  // failed still report success and file no to-do.
  test("fails when an update fails", () => {
    process.env.CLAUDE_UPDATE_FAILS = "beta@third";
    expect(updatePlugins(out, process.env)).toBe(false);
    expect(out.captured()).toContain("Failed to update beta@third");
  });

  // `claude plugin update` answers "Plugin not found" for an id its own
  // marketplace manifest lists, and the same plugin updates on the next nightly
  // run. Every one of those filed a to-do naming a plugin that was never broken.
  test("takes a second attempt at a plugin whose first update refuses", () => {
    process.env.CLAUDE_UPDATE_FAILS_ONCE = "beta@third";

    expect(updatePlugins(out, process.env)).toBe(true);
    expect(out.captured()).not.toContain("Failed to update beta@third");
    const attempts = readLog("plugin.log")
      .split("\n")
      .filter((line) => line === "update beta@third");
    expect(attempts).toHaveLength(2);
  });

  // The retry absorbs a flake without hiding a plugin that is genuinely stuck,
  // which stays reported after it has failed every attempt.
  test("reports a plugin that refuses every attempt", () => {
    process.env.CLAUDE_UPDATE_FAILS = "beta@third";

    expect(updatePlugins(out, process.env)).toBe(false);
    const attempts = readLog("plugin.log")
      .split("\n")
      .filter((line) => line === "update beta@third");
    expect(attempts).toHaveLength(2);
  });

  test("leaves a plugin its marketplace dropped alone", () => {
    writePluginList([
      { id: "alpha@first", installPath: payload("first", "alpha", "1.0.0") },
      { id: "ghost@first", installPath: payload("first", "ghost", "1.0.0") },
    ]);
    writeSettings({ "alpha@first": true, "ghost@first": true });

    expect(updatePlugins(out, process.env)).toBe(true);
    expect(readLog("plugin.log")).not.toContain("ghost@first");
    expect(out.captured()).toContain("ghost@first is no longer offered by its marketplace");
  });

  // Only a marketplace that stopped listing the plugin is beyond updating. One
  // that lists it without saying where it comes from still carries it, and
  // skipping those is how a plugin stops being updated for good.
  test("keeps updating a plugin listed without a source", () => {
    writeMarketplace("first", [{ name: "alpha" }, { name: "gamma", source: "./plugins/gamma" }]);

    expect(updatePlugins(out, process.env)).toBe(true);
    expect(readLog("plugin.log")).toContain("update alpha@first");
  });

  // A CLI invocation that reads the job's stdin used to swallow the rest of the
  // inventory and leave every plugin after it unattempted, with nothing in the
  // exit status to say so.
  test("updates every plugin even when the CLI reads stdin", () => {
    process.env.CLAUDE_DRAINS_STDIN = "1";

    expect(updatePlugins(out, process.env)).toBe(true);
    expect(readLog("plugin.log")).toContain("update alpha@first");
    expect(readLog("plugin.log")).toContain("update gamma@first");
  });

  // An inventory that could not be read is not an empty one: updating nothing and
  // reporting success is the failure this job exists to make loud.
  test("fails when the inventory cannot be read", () => {
    writeFileSync(join(sandbox, ".claude", "settings.json"), "not json\n");

    expect(updatePlugins(out, process.env)).toBe(false);
    expect(readLog("plugin.log")).toBe("");
    // The reason reaches the captured log, so the to-do names the cause.
    expect(out.captured()).toContain("claude-plugins:");
  });

  // A plugin enabled in settings.json but never installed has no payload to
  // update, and its marketplace vouches for the id.
  test("installs a plugin that is enabled but not installed", () => {
    writeSettings({ "alpha@first": true, "gamma@first": true });
    writePluginList([{ id: "alpha@first", installPath: payload("first", "alpha", "1.0.0") }]);

    expect(updatePlugins(out, process.env)).toBe(true);
    expect(readLog("plugin.log")).toContain("install gamma@first");
  });

  // Claude Code loads these from the marketplace's own path and keeps no copy to
  // refresh, so an update per plugin would cost a CLI call each and change
  // nothing.
  test("leaves a plugin from a local marketplace to load in place", () => {
    writeLocalMarketplace("mine", [
      { name: "delta", source: "./plugins/delta" },
      { name: "omega", source: { source: "github", repo: "example/omega" } },
    ]);
    writePluginList([
      { id: "alpha@first", installPath: payload("first", "alpha", "1.0.0") },
      { id: "delta@mine", installPath: payload("mine", "delta", "abc123") },
      { id: "omega@mine", installPath: payload("mine", "omega", "def456") },
    ]);
    writeSettings({ "alpha@first": true, "delta@mine": true, "omega@mine": true });

    expect(updatePlugins(out, process.env)).toBe(true);
    expect(readLog("plugin.log")).toContain("update alpha@first");
    expect(readLog("plugin.log")).not.toContain("delta@mine");
    // A repo of its own is copied into the cache wherever its marketplace lives.
    expect(readLog("plugin.log")).toContain("update omega@mine");
  });

  test("installs a plugin from a local marketplace that has no install record", () => {
    writeLocalMarketplace("mine", [{ name: "delta", source: "./plugins/delta" }]);
    writePluginList([]);
    writeSettings({ "delta@mine": true, "ghost@mine": true });

    expect(updatePlugins(out, process.env)).toBe(true);
    expect(readLog("plugin.log")).toBe("install delta@mine\n");
  });
});

describe("installDependencies", () => {
  test("runs a frozen install at the root of the repo", () => {
    expect(installDependencies(out, repo, process.env)).toBe(true);
    expect(readLog("bun.log")).toBe(`${repo} install --frozen-lockfile\n`);
  });

  test("warns when the install fails", () => {
    process.env.BUN_INSTALL_FAILS = "1";
    expect(installDependencies(out, repo, process.env)).toBe(false);
    expect(out.captured()).toContain("bun install failed in the Claude repository");
  });
});

describe("updateMarketplaces", () => {
  test("warns and carries on when the refresh fails", () => {
    writeStub(join(stubs, "claude"), "exit 1");
    expect(updateMarketplaces(out, process.env)).toBe(false);
    expect(out.captured()).toContain("marketplace update had issues, continuing");
  });

  function cloneAtTag(name: string, tag: string): void {
    const clone = join(sandbox, ".claude", "plugins", "marketplaces", name);
    mkdirSync(clone, { recursive: true });
    run(["git", "init", "-q", clone]);
    run(["git", "-C", clone, "-c", "user.email=spec@example.test", "-c", "user.name=Spec",
      "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "release"]);
    run(["git", "-C", clone, "tag", tag]);
  }

  test.each<{ name: string; declared: string; refreshed: string }>([
    { name: "skips a marketplace already on its pinned tag", declared: "v1", refreshed: "update first\n" },
    { name: "refreshes everything once a pin moves past the clone", declared: "v2", refreshed: "update \n" },
  ])("$name", ({ declared, refreshed }) => {
    cloneAtTag("pinned", "v1");
    writeKnownMarketplaces(["first", "pinned"]);
    writeSettings({}, { first: {}, pinned: { source: { source: "github", ref: declared } } });

    expect(updateMarketplaces(out, process.env)).toBe(true);
    expect(readLog("refresh.log")).toBe(refreshed);
  });

  test("fails when one of the named refreshes fails", () => {
    cloneAtTag("pinned", "v1");
    writeKnownMarketplaces(["first", "pinned"]);
    writeSettings({}, { first: {}, pinned: { source: { source: "github", ref: "v1" } } });
    process.env.CLAUDE_REFRESH_FAILS = "1";

    expect(updateMarketplaces(out, process.env)).toBe(false);
  });
});

describe("revertCosmeticJsonChanges", () => {
  // An app that rewrote a tracked settings file without changing anything in it
  // would otherwise stall the sync behind a diff with nothing in it.
  test("reverts a file whose keys only moved", () => {
    writeRepoSettings(settingsJson(HOOK), 4);
    revertCosmeticJsonChanges(out, repo);

    expect(out.captured()).toContain("Reverting cosmetic reorder in user/settings.json");
    expect(settingsStatus()).toBe("clean");
  });

  test("leaves a file whose values changed alone", () => {
    writeRepoSettings(settingsJson(HOOK, "changed"));
    revertCosmeticJsonChanges(out, repo);

    expect(settingsStatus()).toBe("dirty");
  });

  test("leaves a file that no longer parses alone", () => {
    writeFileSync(join(repo, "user", "settings.json"), "not json\n");
    revertCosmeticJsonChanges(out, repo);

    expect(settingsStatus()).toBe("dirty");
  });
});

describe("syncRepo", () => {
  test("refuses a repo directory that is not there", () => {
    expect(syncRepo(out, join(sandbox, "missing"))).toBe(false);
  });

  // The revert runs before the gate, so a tree dirtied only by a reformat is
  // clean by the time it looks.
  test("clears a cosmetic reorder before the gate sees it", () => {
    writeRepoSettings(settingsJson(HOOK), 4);

    expect(syncRepo(out, repo)).toBe(true);
    expect(settingsStatus()).toBe("clean");
  });

  test("stops at the gate on a real local change", () => {
    writeRepoSettings(settingsJson(HOOK, "changed"));

    expect(syncRepo(out, repo)).toBe(false);
    expect(out.captured()).toContain("Local changes present - skipping sync");
  });

  // Rex owns its hook and setup re-adds it after the sync, so its entry alone
  // never holds the gate shut.
  test.each<{ name: string; settings: unknown }>([
    { name: "beside a committed hook", settings: withRexHook(settingsJson(HOOK)) },
    { name: "in an event of its own", settings: withRexEvent(settingsJson(HOOK)) },
  ])("clears rex's hook before the gate sees it: $name", ({ settings }) => {
    writeRepoSettings(settings);

    expect(syncRepo(out, repo)).toBe(true);
    expect(settingsStatus()).toBe("clean");
  });

  // A release that changes the command still matches while HEAD carries the
  // entry, which it does until the claude repo drops it.
  test("clears a changed rex hook that HEAD still carries", () => {
    writeRepoSettings(withRexHook(settingsJson(HOOK)));
    git("commit", "-q", "-am", "rex");
    writeRepoSettings(withRexHook(settingsJson(HOOK), "rex __internal session-start --agent claude --v2"));

    expect(syncRepo(out, repo)).toBe(true);
    expect(settingsStatus()).toBe("clean");
  });

  test("stops at the gate on a real change beside rex's hook", () => {
    writeRepoSettings(withRexHook(settingsJson(HOOK, "changed")));

    expect(syncRepo(out, repo)).toBe(false);
    expect(repoSettingsText()).toContain("rex __internal");
  });
});

describe("failureFields", () => {
  const log = [
    "INFO Syncing Claude repository...",
    "WARN Failed to update beta@third",
    "ERRO Local changes present - skipping sync",
    "WARN Sync skipped 4 runs in a row",
    "INFO Updating plugins...",
  ].join("\n");

  // Keyed on which steps warned, so a sync that keeps failing stays quiet while a
  // plugin failing on top of it reopens the latch. The gate's skip count sits in
  // field 4, so its doublings reopen the latch too.
  test("keeps fields 2 to 5 of every warn and error line", () => {
    expect(failureFields(log)).toEqual([
      "Failed to update beta@third",
      "Local changes present -",
      "Sync skipped 4 runs",
    ]);
  });

  // The plugin that failed is the finding. Dropping its name left one plugin's
  // failure indistinguishable from another's, so a night where a different
  // plugin broke came back to a latch already holding the old one and stayed
  // silent.
  test("names the plugin a failed update was for", () => {
    expect(failureFields("WARN Failed to update alpha@first\n")).not.toEqual(
      failureFields("WARN Failed to update beta@third\n"),
    );
  });

  test("reads nothing out of a log with no warnings", () => {
    expect(failureFields("INFO all good\n")).toEqual([]);
  });

  // A warn line with fewer than five fields still has to produce a value, or the
  // fingerprint moves with the padding rather than with the finding.
  test("pads a short line rather than dropping it", () => {
    expect(failureFields("WARN stray.txt \n")).toEqual(["stray.txt   "]);
  });
});

describe("failureFingerprint", () => {
  // The shell hashed `awk … | sort | shasum | cut -c1-12`, and a fingerprint that
  // moved in the port would refile every latched failure once on the rename.
  function shellFingerprint(extracted: string[]): string {
    const result = Bun.spawnSync({
      cmd: ["bash", "-c", "sort | shasum | cut -c1-12"],
      env: { ...process.env, LC_ALL: "C" },
      stdin: Buffer.from(extracted.map((line) => `${line}\n`).join("")),
      stdout: "pipe",
    });
    return result.stdout.toString().trim();
  }

  test.each<{ name: string; extracted: string[] }>([
    { name: "nothing extracted", extracted: [] },
    { name: "one line", extracted: ["Failed to update"] },
    { name: "several lines out of order", extracted: ["b two", "a one", "c three"] },
    { name: "a line with inner spaces", extracted: ["Local changes present"] },
  ])("agrees with the shell pipeline for $name", ({ extracted }) => {
    expect(failureFingerprint(extracted)).toBe(shellFingerprint(extracted));
  });

  test("does not move with the order the lines were extracted in", () => {
    expect(failureFingerprint(["a", "b"])).toBe(failureFingerprint(["b", "a"]));
  });
});

describe("repoRevision", () => {
  test("reads the short HEAD", () => {
    expect(repoRevision(repo)).toBe(git("rev-parse", "--short", "HEAD").trim());
  });

  test("reads unknown where there is no repo", () => {
    expect(repoRevision(join(sandbox, "missing"))).toBe("unknown");
  });
});

describe("versionMeta", () => {
  test("names the installed Claude version in a single bullet", () => {
    expect(versionMeta()).toBe("- **Claude:** claude 1.2.3");
  });

  test("says unknown where the CLI cannot answer", () => {
    writeStub(join(stubs, "claude"), "exit 1");
    expect(versionMeta()).toBe("- **Claude:** unknown");
  });
});

describe("claudeRepoHome", () => {
  test("prefers the environment over the default location", () => {
    process.env.CLAUDE_REPO_HOME = repo;
    expect(claudeRepoHome()).toBe(repo);
  });

  test("falls back to ~/.claude-repo", () => {
    delete process.env.CLAUDE_REPO_HOME;
    expect(claudeRepoHome()).toBe(join(sandbox, ".claude-repo"));
  });
});

// herdr's installer appends a SessionStart entry it cannot recognize in the
// committed $HOME form, and its status check reads only the script's version
// marker. moshi's entries are what the committed file is meant to carry.
describe("installAgentHooks", () => {
  function repoSettings(): unknown {
    return JSON.parse(readFileSync(join(repo, "user", "settings.json"), "utf8"));
  }

  // PATH excludes the Homebrew prefix, so a removed stub leaves that installer
  // absent on the runner.
  function without(...installers: string[]): Record<string, string | undefined> {
    for (const name of installers) rmSync(join(stubs, name));
    symlinkSync(Bun.which("jq") ?? "/usr/bin/jq", join(stubs, "jq"));
    return { ...process.env, PATH: `${stubs}:/usr/bin:/bin` };
  }

  // moshi replaces the link, so its entry only reaches the gate by being carried
  // into the working copy.
  test("discards herdr's settings edit and keeps moshi's", () => {
    expect(installAgentHooks(out, repo, process.env)).toBe(true);
    expect(readLog("hooks.log")).toBe(
      [
        "herdr integration install claude",
        "moshi-hook install --target claude",
        "rex skill setup --agent claude --autostart=false",
        "",
      ].join("\n"),
    );
    expect(repoSettings()).toEqual({ ...(settingsJson(HOOK) as object), "moshi-hook": 1, rex: 1 });
    expect(linked()).toBe(true);
  });

  // Replacing the link leaves the repo untouched, so the discard comes from
  // relinking.
  test("discards herdr's edit when it replaces the link", () => {
    const env = without("rex", "moshi-hook");

    expect(installAgentHooks(out, repo, { ...env, HERDR_REPLACES: "1" })).toBe(true);
    expect(out.captured()).toContain("Relinked ~/.claude/settings.json");
    expect(linked()).toBe(true);
    expect(settingsStatus()).toBe("clean");
  });

  // herdr writes its entry before it can fail on a later step. The discard has to
  // take that back too: left in the tree, it holds the sync gate shut on every
  // later run, and that gate is what this step needs to clear to run again.
  test("reports a failed install and still discards what it wrote", () => {
    const env = without("rex", "moshi-hook");

    expect(installAgentHooks(out, repo, { ...env, HERDR_FAILS: "1" })).toBe(false);
    expect(out.captured()).toContain("herdr integration install failed");
    expect(settingsStatus()).toBe("clean");
  });

  // Only what herdr wrote comes back out. An edit already in the tree when the
  // install started belongs to whoever made it, and restoring the committed file
  // would take that with it.
  test("keeps an edit the install did not make", () => {
    const env = without("rex", "moshi-hook");
    writeRepoSettings({ unrelated: 1 });

    expect(installAgentHooks(out, repo, env)).toBe(true);
    expect(repoSettings()).toEqual({ unrelated: 1 });
  });

  // The entry survives a restore that could not write, and the sync gate blocks
  // on it the next night. Reporting it here is what says which run put it there.
  test.skipIf(ignoresModes)("reports a restore that could not run", () => {
    const env = without("rex", "moshi-hook");

    expect(installAgentHooks(out, repo, { ...env, HERDR_LOCKS: "1" })).toBe(false);
    expect(out.captured()).toContain("Could not discard herdr's edit");
    expect(repoSettings()).toEqual({ herdr: 1 });
  });

  // A missing installer stays out of the log rather than warning every night.
  test("skips an installer that is not on PATH", () => {
    const env = without("herdr", "rex", "moshi-hook");

    expect(installAgentHooks(out, repo, env)).toBe(true);
    expect(out.captured()).toBe("");
    expect(readLog("hooks.log")).toBe("");
  });

  // A Rex release that changes its hook leaves the clone dirty, so the sync gate
  // surfaces the new entry for a commit.
  test("keeps rex's settings edit", () => {
    const env = without("herdr", "moshi-hook");

    expect(installAgentHooks(out, repo, env)).toBe(true);
    expect(repoSettings()).toEqual({ ...(settingsJson(HOOK) as object), rex: 1 });
    expect(linked()).toBe(true);
  });

  // Outside a Rex terminal, rex is only in the app bundle, which is where the
  // nightly finds it.
  test("runs rex from the app bundle when it is not on PATH", () => {
    const env = without("herdr", "rex", "moshi-hook");
    const bundled = join(
      sandbox,
      "Library/Application Support/com.superlogical.rex/RexServer/Versions/Current/Rex Server.app/Contents/MacOS/rex",
    );
    writeStub(bundled, rexStub(join(sandbox, "hooks.log")));

    expect(installAgentHooks(out, repo, env)).toBe(true);
    expect(readLog("hooks.log")).toBe("rex skill setup --agent claude --autostart=false\n");
  });

  test("reports a failed rex setup", () => {
    const env = without("herdr", "moshi-hook");

    expect(installAgentHooks(out, repo, { ...env, REX_FAILS: "1" })).toBe(false);
    expect(out.captured()).toContain("rex skill setup failed");
  });
});

describe("sync", () => {
  test("succeeds when the sync and the updates do", () => {
    expect(sync(out, repo)).toBe(0);
    expect(readLog("plugin.log")).toContain("update alpha@first");
  });

  // The install follows the sync, so the pull that removes a stale script from
  // the clone runs against a clean tree before the installer puts the current one
  // back.
  test("reinstalls the hooks after the sync and before the plugins", () => {
    expect(sync(out, repo)).toBe(0);
    const log = out.captured();
    expect(log.indexOf("Syncing Claude repository")).toBeLessThan(log.indexOf("Installing herdr"));
    expect(log.indexOf("Installing moshi")).toBeLessThan(log.indexOf("Updating marketplaces"));
  });

  // So a marketplace losing its last plugin goes with it, unfetched on the way.
  test("prunes marketplaces after the plugins and before the refresh", () => {
    expect(sync(out, repo)).toBe(0);
    const log = out.captured();
    expect(log.indexOf("Pruning undeclared plugins")).toBeLessThan(
      log.indexOf("Pruning undeclared marketplaces"),
    );
    expect(log.indexOf("Pruning undeclared marketplaces")).toBeLessThan(
      log.indexOf("Updating marketplaces"),
    );
  });

  test.each<{ name: string; interactive: boolean }>([
    { name: "full", interactive: false },
    { name: "interactive", interactive: true },
  ])("installs the repo's dependencies after the sync: $name", ({ interactive }) => {
    expect(sync(out, repo, { interactive })).toBe(0);
    const log = out.captured();
    expect(readLog("bun.log")).toBe(`${repo} install --frozen-lockfile\n`);
    expect(log.indexOf("Syncing Claude repository")).toBeLessThan(
      log.indexOf("Installing Claude repository dependencies"),
    );
  });

  test.each<{ name: string; interactive: boolean }>([
    { name: "full", interactive: false },
    { name: "interactive", interactive: true },
  ])("fails when the dependency install fails, and still updates the plugins: $name", ({ interactive }) => {
    process.env.BUN_INSTALL_FAILS = "1";
    expect(sync(out, repo, { interactive })).toBe(1);
    expect(readLog("plugin.log")).toContain("update alpha@first");
  });

  // The gate clears Rex's entry, and setup puts the installed release's back.
  test("leaves rex's hook in place after the run", () => {
    expect(sync(out, repo)).toBe(0);
    expect(JSON.parse(repoSettingsText())).toMatchObject({ rex: 1 });
  });

  test("fails when a hook install fails, and still updates the plugins", () => {
    process.env.HERDR_FAILS = "1";
    expect(sync(out, repo)).toBe(1);
    expect(readLog("plugin.log")).toContain("update alpha@first");
  });

  test("fails when a plugin update fails", () => {
    process.env.CLAUDE_UPDATE_FAILS = "beta@third";
    expect(sync(out, repo)).toBe(1);
  });

  test("updates the plugins alone when interactive", () => {
    process.env.HERDR_FAILS = "1";
    expect(sync(out, repo, { interactive: true })).toBe(0);
    const log = out.captured();
    expect(readLog("plugin.log")).toContain("update alpha@first");
    expect(log).toContain("Updating marketplaces");
    for (const skipped of ["Installing herdr", "Pruning undeclared"]) {
      expect(log).not.toContain(skipped);
    }
  });

  test("fails an interactive run when a plugin update fails", () => {
    process.env.CLAUDE_UPDATE_FAILS = "beta@third";
    expect(sync(out, repo, { interactive: true })).toBe(1);
  });

  test.each<{ name: string; interactive: boolean }>([
    { name: "full", interactive: false },
    { name: "interactive", interactive: true },
  ])("failed refresh fails the run and still updates: $name", ({ interactive }) => {
    process.env.CLAUDE_REFRESH_FAILS = "1";
    expect(sync(out, repo, { interactive })).toBe(1);
    expect(readLog("plugin.log")).toContain("update alpha@first");
  });

  test("relinks even when the gate refuses", () => {
    writeRepoSettings(settingsJson(HOOK, "changed"));
    replaceLink(settingsJson(HOOK));

    expect(sync(out, repo)).toBe(1);
    expect(linked()).toBe(true);
  });

  test("leaves the plugins and dependencies unattempted when the sync refuses", () => {
    writeRepoSettings(settingsJson(HOOK, "changed"));
    expect(sync(out, repo)).toBe(1);
    expect(readLog("plugin.log")).toBe("");
    expect(readLog("bun.log")).toBe("");
  });
});

describe("main", () => {
  // The whole run is captured as it happens, and a failure files a Things to-do
  // built from that log.
  test("files a to-do built from the captured log when the sync fails", () => {
    process.env.CLAUDE_REPO_HOME = join(sandbox, "missing");

    expect(main(out)).toBe(1);
    expect(todoCount()).toBe(1);
    expect(readLog("todos")).toContain("Claude%20sync%20failed");
  });

  // Nothing else runs the whole of a clean night, and the branch it ends on has
  // no output to assert against beyond the latch it clears.
  test("clears the sync latch when the run succeeds", () => {
    process.env.CLAUDE_REPO_HOME = repo;

    expect(main(out)).toBe(0);
    expect(todoCount()).toBe(0);
    expect(readFileSync(join(sandbox, "state", "dotfiles", "claude-sync.status"), "utf8")).toBe(
      "ok\n",
    );
  });
});
