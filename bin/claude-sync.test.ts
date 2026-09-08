import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Capture, SpawnOptions } from "#jobs/output";
import {
  auditPlugins,
  claudeRepoHome,
  driftReport,
  failureFields,
  failureFingerprint,
  installAgentHooks,
  keptPlugins,
  main,
  prunePlugins,
  reportDrift,
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
let origin: string;
let out: Capture;

const environment = {
  HOME: process.env.HOME,
  PATH: process.env.PATH,
  XDG_STATE_HOME: process.env.XDG_STATE_HOME,
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

function writeScript(path: string, body: string): void {
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
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

// The notes of the last to-do filed, decoded out of the things:/// URL.
function filedNotes(): string {
  const url = readLog("todos").split("\n").filter(Boolean).at(-1) ?? "";
  return decodeURIComponent(url.split("&notes=")[1]?.split("&")[0] ?? "");
}

// The "New:" line of every to-do filed, which is the finding each one was filed
// for.
function filedNewLines(): string[] {
  return readLog("todos")
    .split("\n")
    .filter(Boolean)
    .flatMap((url) =>
      decodeURIComponent(url)
        .split("\n")
        .filter((line) => line.startsWith("- **New:**")),
    );
}

function driftLatch(): string {
  return readFileSync(join(sandbox, "state", "dotfiles", "claude-plugin-drift.status"), "utf8");
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
  "    printf 'update %s\\n' \"$3\" >>\"$CLAUDE_PLUGIN_LOG\"",
  '    case " $CLAUDE_UPDATE_FAILS " in *" $3 "*) exit 1 ;; esac',
  // The intermittent shape the retry exists for: the first attempt refuses and
  // the next one takes.
  '    case " $CLAUDE_UPDATE_FAILS_ONCE " in',
  '      *" $3 "*)',
  '        [ -f "$HOME/refused-$3" ] || { : >"$HOME/refused-$3"; exit 1; }',
  "        ;;",
  "    esac",
  "    ;;",
  "  install) printf 'install %s\\n' \"$3\" >>\"$CLAUDE_PLUGIN_LOG\" ;;",
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
}

function writePluginList(listed: Listed[]): void {
  writeFileSync(
    join(sandbox, "plugin-list.json"),
    JSON.stringify(listed.map((row) => ({ ...row, scope: "user", enabled: true }))),
  );
}

function payload(...segments: string[]): string {
  const path = join(sandbox, ".claude", "plugins", "cache", ...segments);
  mkdirSync(path, { recursive: true });
  return path;
}

// The manifest Claude Code reads out of an installed payload, which is the only
// place a plugin's dependencies are written down.
function writePayloadManifest(path: string, manifest: unknown): void {
  mkdirSync(join(path, ".claude-plugin"), { recursive: true });
  writeFileSync(join(path, ".claude-plugin", "plugin.json"), JSON.stringify(manifest));
}

function writeMarketplace(name: string, entries: unknown[]): void {
  const dir = join(sandbox, ".claude", "plugins", "marketplaces", name, ".claude-plugin");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "marketplace.json"), JSON.stringify({ name, plugins: entries }));
}

function writeSettings(enabled: Record<string, boolean>): void {
  mkdirSync(join(sandbox, ".claude"), { recursive: true });
  writeFileSync(join(sandbox, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: enabled }));
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
  writeSettings({ "alpha@first": true, "beta@third": true, "gamma@first": true, "disabled@first": false });
}

const GUARDED_HOOK = '/bin/sh -c [ -x "$HOME/.vibe-island/bin/vibe-island-bridge" ] && exit 0';

function settingsJson(command: unknown, extra = "bar"): unknown {
  return {
    env: { EXAMPLE: extra },
    hooks: { SessionStart: [{ hooks: [{ type: "command", command }] }] },
  };
}

function writeRepoSettings(settings: unknown, indent = 2): void {
  writeFileSync(join(repo, "user", "settings.json"), `${JSON.stringify(settings, null, indent)}\n`);
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "claude-sync-"));
  stubs = join(sandbox, "stub");
  repo = join(sandbox, "repo");
  origin = join(sandbox, "origin.git");
  mkdirSync(stubs);

  writeScript(join(stubs, "claude"), claudeStub);
  // The spin branch runs the command after the separator, and log echoes the
  // message to stderr, where the real gum writes it.
  writeScript(
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
      '    printf "%s\\n" "${@: -1}" >&2',
      "    ;;",
      "esac",
      "exit 0",
    ].join("\n"),
  );
  // A to-do is filed by handing a things:/// URL to `open`, so a logged line is
  // the whole observation of whether a latch let one through.
  writeScript(join(stubs, "open"), `printf '%s\\n' "$1" >>"${join(sandbox, "todos")}"`);
  writeScript(join(stubs, "osascript"), `printf '%s\\n' "$2" >>"${join(sandbox, "notifications")}"`);
  // Both installers rewrite the repo's settings.json, which is the whole of what
  // the install step has to sort out. herdr writes before it can fail, so a
  // failed run still leaves an entry for the discard to take back. A failing
  // moshi-hook exits first, so its entries are only ever a finished install's.
  const hookLog = join(sandbox, "hooks.log");
  const settingsWrite = (name: string) =>
    `printf '{"${name}":1}\\n' >"$AGENT_HOOK_REPO/user/settings.json"`;
  writeScript(
    join(stubs, "herdr"),
    [
      `printf '%s %s\\n' "herdr" "$*" >>"${hookLog}"`,
      settingsWrite("herdr"),
      `[ -n "$HERDR_LOCKS" ] && chmod 0444 "$AGENT_HOOK_REPO/user/settings.json"`,
      '[ -n "$HERDR_FAILS" ] && exit 1',
      "exit 0",
    ].join("\n"),
  );
  writeScript(
    join(stubs, "moshi-hook"),
    [
      `printf '%s %s\\n' "moshi-hook" "$*" >>"${hookLog}"`,
      '[ -n "$MOSHI_FAILS" ] && exit 1',
      settingsWrite("moshi-hook"),
      "exit 0",
    ].join("\n"),
  );

  process.env.HOME = sandbox;
  process.env.PATH = `${stubs}:${environment.PATH}`;
  process.env.XDG_STATE_HOME = join(sandbox, "state");
  process.env.CLAUDE_PLUGIN_LOG = join(sandbox, "plugin.log");
  process.env.CLAUDE_UPDATE_FAILS = "";
  process.env.CLAUDE_UPDATE_FAILS_ONCE = "";
  process.env.CLAUDE_UNINSTALL_FAILS = "";
  process.env.CLAUDE_DRAINS_STDIN = "";
  process.env.AGENT_HOOK_REPO = repo;
  process.env.HERDR_FAILS = "";
  process.env.HERDR_LOCKS = "";
  process.env.MOSHI_FAILS = "";
  writeFileSync(process.env.CLAUDE_PLUGIN_LOG, "");

  writePluginFixture();

  run(["git", "init", "-q", "--bare", "-b", "main", origin]);
  run(["git", "init", "-q", "-b", "main", repo]);
  run(["git", "-C", repo, "config", "user.email", "spec@example.test"]);
  run(["git", "-C", repo, "config", "user.name", "Spec"]);
  run(["git", "-C", repo, "config", "commit.gpgsign", "false"]);
  run(["git", "-C", repo, "remote", "add", "origin", origin]);
  mkdirSync(join(repo, "user"));
  writeRepoSettings(settingsJson(GUARDED_HOOK));
  run(["git", "-C", repo, "add", "-A"]);
  run(["git", "-C", repo, "commit", "-q", "-m", "settings"]);
  run(["git", "-C", repo, "push", "-q", "-u", "origin", "main"]);
  run(["git", "-C", repo, "remote", "set-head", "origin", "main"]);

  // A stub that failed to shadow the real CLI would enumerate this machine's own
  // plugins, and every example after it would be asserting against the runner.
  const probe = Bun.spawnSync({ cmd: ["claude", "plugin", "list", "--json"], env: process.env, stdout: "pipe" });
  if (!probe.stdout.toString().includes("alpha@first")) {
    throw new Error(`claude resolved to ${probe.stdout.toString()}`);
  }

  out = recording();
});

afterEach(() => {
  process.env.HOME = environment.HOME;
  process.env.PATH = environment.PATH;
  if (environment.XDG_STATE_HOME === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = environment.XDG_STATE_HOME;
  if (environment.CLAUDE_REPO_HOME === undefined) delete process.env.CLAUDE_REPO_HOME;
  else process.env.CLAUDE_REPO_HOME = environment.CLAUDE_REPO_HOME;
  delete process.env.CLAUDE_PLUGIN_LOG;
  delete process.env.CLAUDE_UPDATE_FAILS;
  delete process.env.CLAUDE_UPDATE_FAILS_ONCE;
  delete process.env.CLAUDE_UNINSTALL_FAILS;
  delete process.env.CLAUDE_DRAINS_STDIN;
  delete process.env.AGENT_HOOK_REPO;
  delete process.env.HERDR_FAILS;
  delete process.env.HERDR_LOCKS;
  delete process.env.MOSHI_FAILS;
  rmSync(sandbox, { recursive: true, force: true });
});

describe("keptPlugins", () => {
  function kept(declared: string[], installed: { id: string; installPath: string }[]): string[] {
    const read = keptPlugins(new Set(declared), installed);
    if (!read.ok) throw new Error(`kept failed: ${read.reason}`);
    return [...read.ids].sort();
  }

  test("keeps what a declared plugin names as a dependency", () => {
    const path = payload("first", "alpha", "1.0.0");
    writePayloadManifest(path, { name: "alpha", dependencies: ["gamma"] });

    expect(kept(["alpha@first"], [{ id: "alpha@first", installPath: path }])).toEqual([
      "alpha@first",
      "gamma@first",
    ]);
  });

  // Keeping a dependency without reading its own manifest breaks the chain at
  // its second link: gamma survives and the delta it needs is uninstalled.
  test("walks a dependency of a dependency", () => {
    const alpha = payload("first", "alpha", "1.0.0");
    writePayloadManifest(alpha, { name: "alpha", dependencies: ["gamma"] });
    const gamma = payload("first", "gamma", "1.0.0");
    writePayloadManifest(gamma, { name: "gamma", dependencies: ["delta"] });

    expect(
      kept(
        ["alpha@first"],
        [
          { id: "alpha@first", installPath: alpha },
          { id: "gamma@first", installPath: gamma },
        ],
      ),
    ).toEqual(["alpha@first", "delta@first", "gamma@first"]);
  });

  // Two plugins naming each other would otherwise queue each other forever.
  test("settles on a dependency cycle", () => {
    const alpha = payload("first", "alpha", "1.0.0");
    writePayloadManifest(alpha, { name: "alpha", dependencies: ["gamma"] });
    const gamma = payload("first", "gamma", "1.0.0");
    writePayloadManifest(gamma, { name: "gamma", dependencies: ["alpha"] });

    expect(
      kept(
        ["alpha@first"],
        [
          { id: "alpha@first", installPath: alpha },
          { id: "gamma@first", installPath: gamma },
        ],
      ),
    ).toEqual(["alpha@first", "gamma@first"]);
  });

  // Reading an undeclared plugin's dependencies would keep whatever it names
  // alive alongside it, so a pair of leftovers would hold each other in place.
  test("ignores what an undeclared plugin names", () => {
    const path = payload("first", "stray", "1.0.0");
    writePayloadManifest(path, { name: "stray", dependencies: ["gamma"] });

    expect(kept(["alpha@first"], [{ id: "stray@first", installPath: path }])).toEqual([
      "alpha@first",
    ]);
  });

  test("takes a dependency that names its own marketplace as written", () => {
    const path = payload("first", "alpha", "1.0.0");
    writePayloadManifest(path, { name: "alpha", dependencies: ["beta@third"] });

    expect(kept(["alpha@first"], [{ id: "alpha@first", installPath: path }])).toEqual([
      "alpha@first",
      "beta@third",
    ]);
  });

  test("fails when a declared plugin's manifest cannot be read", () => {
    const path = payload("first", "alpha", "1.0.0");
    writePayloadManifest(path, "not json\n");

    expect(keptPlugins(new Set(["alpha@first"]), [{ id: "alpha@first", installPath: path }])).toEqual(
      { ok: false, reason: expect.stringContaining("alpha@first") },
    );
  });
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
    expect(readLog("plugin.log")).toBe("");
  });

  // Claude Code installs a dependency without writing a settings.json key for
  // it, so the declaration alone would take it out from under the plugin that
  // needs it every night.
  test("keeps a dependency of a declared plugin", () => {
    const alpha = payload("first", "alpha", "1.0.0");
    writePayloadManifest(alpha, { name: "alpha", dependencies: ["gamma"] });
    writePluginList([
      { id: "alpha@first", installPath: alpha },
      { id: "gamma@first", installPath: payload("first", "gamma", "1.0.0") },
    ]);
    writeSettings({ "alpha@first": true });

    expect(prunePlugins(out, process.env)).toBe(true);
    expect(readLog("plugin.log")).toBe("");
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

  // A manifest that is there and cannot be read may name a dependency, and the
  // payload it names would go on the strength of a file nothing parsed.
  test("uninstalls nothing when a declared plugin's manifest cannot be read", () => {
    const alpha = payload("first", "alpha", "1.0.0");
    writePayloadManifest(alpha, "not json\n");
    writePluginList([
      { id: "alpha@first", installPath: alpha },
      { id: "stray@first", installPath: payload("first", "stray", "1.0.0") },
    ]);
    writeSettings({ "alpha@first": true });

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
    expect(readLog("plugin.log")).toBe("");
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

  // Nothing can update a plugin its marketplace stopped offering, so the update
  // pass leaves it alone and claude-plugin-audit names it instead.
  test("leaves a plugin its marketplace dropped alone", () => {
    writePluginList([
      { id: "alpha@first", installPath: payload("first", "alpha", "1.0.0") },
      { id: "ghost@first", installPath: payload("first", "ghost", "1.0.0") },
    ]);
    writeSettings({ "alpha@first": true, "ghost@first": true });

    expect(updatePlugins(out, process.env)).toBe(true);
    expect(readLog("plugin.log")).not.toContain("ghost@first");
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
});

describe("updateMarketplaces", () => {
  // A marketplace refresh that had trouble is not a reason to leave the plugins
  // unattempted, so it never reaches the run's status.
  test("warns and carries on when the refresh fails", () => {
    writeScript(join(stubs, "claude"), "exit 1");
    updateMarketplaces(out, process.env);
    expect(out.captured()).toContain("marketplace update had issues, continuing");
  });
});

describe("revertCosmeticJsonChanges", () => {
  // An app that rewrote a tracked settings file without changing anything in it
  // would otherwise stall the sync behind a diff with nothing in it.
  test("reverts a file whose keys only moved", () => {
    writeRepoSettings(settingsJson(GUARDED_HOOK), 4);
    revertCosmeticJsonChanges(out, repo);

    expect(out.captured()).toContain("Reverting cosmetic reorder in user/settings.json");
    expect(settingsStatus()).toBe("clean");
  });

  test("leaves a file whose values changed alone", () => {
    writeRepoSettings(settingsJson(GUARDED_HOOK, "changed"));
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
    writeRepoSettings(settingsJson(GUARDED_HOOK), 4);

    expect(syncRepo(out, repo)).toBe(true);
    expect(settingsStatus()).toBe("clean");
  });

  test("stops at the gate on a real local change", () => {
    writeRepoSettings(settingsJson(GUARDED_HOOK, "changed"));

    expect(syncRepo(out, repo)).toBe(false);
    expect(out.captured()).toContain("Local changes present - skipping sync");
  });
});

describe("auditPlugins", () => {
  function auditStub(status: number, output = ""): string {
    const path = join(sandbox, `audit-${status}`);
    writeScript(path, [output === "" ? "true" : `printf '%s\\n' "${output}"`, `exit ${status}`].join("\n"));
    return path;
  }

  test("passes a clean audit and clears the drift latch", () => {
    expect(auditPlugins(out, repo, { audit: auditStub(0), env: process.env })).toBe(true);
    expect(todoCount()).toBe(0);
    expect(driftLatch()).toBe("standing\n");
  });

  // Drift outlives the run that should have fixed it, so it goes to a latch of its
  // own rather than failing the sync.
  test("files drift without failing the sync", () => {
    const audit = auditStub(1, "  alpha@first  stale  differs from ./plugins/alpha at 1 path");

    expect(auditPlugins(out, repo, { audit, env: process.env })).toBe(true);
    expect(todoCount()).toBe(1);
    // Reprinted so the findings reach the captured log the to-do is built from.
    expect(out.captured()).toContain("alpha@first  stale");
  });

  // Filing a check that never ran as drift would name plugins it never looked at,
  // and would leave the sync reporting success over nothing.
  test("fails the sync when the audit could not run at all", () => {
    expect(auditPlugins(out, repo, { audit: auditStub(2), env: process.env })).toBe(false);
    expect(out.captured()).toContain("Plugin audit did not run");
    expect(todoCount()).toBe(0);
  });

  test("fails the sync when the audit is not there", () => {
    expect(auditPlugins(out, repo, { audit: join(sandbox, "no-such-audit"), env: process.env })).toBe(false);
    expect(out.captured()).toContain("Plugin audit did not run");
  });
});

// The latch decides whether a night's findings refile. It keyed on the whole
// finding set, so a plugin that had been stale for a week filed a fresh to-do
// every time an unrelated one joined or left the set around it.
describe("drift latch", () => {
  const staleRow = "  alpha@first  stale  differs from ./plugins/alpha at 1 path";
  const pinnedRow = "  beta@third  pinned  still offered as 1.0.0";

  test("files again when a pinned finding joins the stale ones", () => {
    reportDrift(staleRow, repo);
    reportDrift(`${staleRow}\n${pinnedRow}`, repo);
    expect(todoCount()).toBe(2);
  });

  test("stays quiet while the same pinned finding stands", () => {
    reportDrift(pinnedRow, repo);
    reportDrift(pinnedRow, repo);
    expect(todoCount()).toBe(1);
  });

  // Detail that deepens on a plugin already named is the same finding, and the
  // latch has already filed it.
  test("stays quiet while only the detail of a finding changes", () => {
    reportDrift(staleRow, repo);
    reportDrift(`${staleRow} and one more`, repo);
    expect(todoCount()).toBe(1);
  });

  test("stays quiet for a standing finding while the set churns around it", () => {
    reportDrift(staleRow, repo);
    reportDrift(`${staleRow}\n${pinnedRow}`, repo);
    reportDrift(staleRow, repo);
    expect(todoCount()).toBe(2);
  });

  test("names the finding it filed for", () => {
    reportDrift(staleRow, repo);
    reportDrift(`${staleRow}\n${pinnedRow}`, repo);
    expect(filedNotes()).toContain("**New:** beta@third pinned");
  });

  // The whole report reaches the parser, so a block header or the summary line
  // read as a finding would file a to-do naming "Findings" every night.
  test("reads no finding out of the headers and the summary", () => {
    reportDrift(`Findings (act on these):\n${staleRow}\n\n1 finding to act on (6 current)`, repo);
    reportDrift(`Findings (act on these):\n${staleRow}\n\n1 finding to act on (7 current)`, repo);
    expect(todoCount()).toBe(1);
  });
});

// The four nights of 2026-09-02 through 05, as they were actually reported.
// agents-md@bendrucker was stale throughout and never changed: installed
// 6030636029d9 against a HEAD of 7e6c36e88a5e. ast-grep and cloudflare joined and
// left the set around it on alternating machines, and the set-wide latch refiled
// agents-md every time one of them did, for four to-dos in four nights.
describe("September churn", () => {
  const agentsMd =
    "  agents-md@bendrucker  stale  installed 6030636029d9, https://github.com/bendrucker/agents.md HEAD is 7e6c36e88a5e";
  const astGrep =
    "  ast-grep@bendrucker  stale  differs from ./plugins/ast-grep at 2 paths: SKILL.md, README.md";
  const cloudflare =
    "  cloudflare@bendrucker  stale  differs from ./plugins/cloudflare at 1 path: SKILL.md";

  function report(...rows: string[]): string {
    const noun = rows.length === 1 ? "finding" : "findings";
    return ["Findings (act on these):", ...rows, "", `${rows.length} ${noun} to act on (6 current)`].join("\n");
  }

  // The night every marketplace resolved to "has no HEAD". agents-md is
  // repo-backed, so its own ls-remote went with them and its row moved out of the
  // findings and into the unverified block. ast-grep is compared against a local
  // marketplace tree, so nothing about it needed the network.
  const night0902 = [
    "Unverified (could not check):",
    "  agents-md@bendrucker  unverified  https://github.com/bendrucker/agents.md has no HEAD",
    "  marketplace/bendrucker  unverified  https://github.com/bendrucker/claude has no HEAD",
    "",
    report(astGrep),
  ].join("\n");

  // Each machine keeps its own latch under XDG_STATE_HOME and files into the one
  // shared inbox, so the two nights each ran are replayed against separate state.
  function onHost(host: string, output: string): void {
    process.env.XDG_STATE_HOME = join(sandbox, "state", host);
    reportDrift(output, repo);
  }

  // agents-md had already been reported before the episode opened, which is the
  // state the four nights ran against.
  function churn(): void {
    onHost("mbp", report(agentsMd));
    onHost("studio", report(agentsMd));
    writeFileSync(join(sandbox, "todos"), "");

    onHost("mbp", night0902);
    onHost("studio", report(agentsMd));
    onHost("mbp", report(agentsMd, astGrep));
    onHost("studio", report(agentsMd, cloudflare));
  }

  // One per machine, each for the plugin that was genuinely new to it.
  // Deduplicating across the two is a separate problem and is not solved here.
  test("files one to-do per machine instead of one per night", () => {
    churn();
    expect(todoCount()).toBe(2);
  });

  test("names the plugin that was new to each machine", () => {
    churn();
    expect(filedNewLines()).toEqual([
      "- **New:** ast-grep@bendrucker stale",
      "- **New:** cloudflare@bendrucker stale",
    ]);
  });

  // The one that was refiled three times. It never changed, so nothing about it
  // should have reached the inbox again.
  test("never refiles the finding that did not change", () => {
    churn();
    expect(filedNewLines().join("\n")).not.toContain("agents-md");
  });

  // Leaving the unverified rows out of the old key was meant to keep a network
  // blip from reopening the latch. It did the opposite: agents-md dropped out of
  // the hashed set, so the set changed and the blip reopened the latch through
  // the back door.
  test("does not let a blip clear a finding it could not check", () => {
    onHost("mbp", report(agentsMd));
    onHost("mbp", night0902);
    onHost("mbp", report(agentsMd));
    // The first night for agents-md and the second for ast-grep. Nothing on the
    // third: agents-md came back to a latch that still held it.
    expect(todoCount()).toBe(2);
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

describe("driftReport", () => {
  const findings = [
    "  alpha@first  stale  differs from ./plugins/alpha at 1 path",
    "  beta@third  pinned  still offered as 1.0.0",
    "  gamma@first  orphaned  first no longer offers it",
    "  delta@third  unverified  could not compare",
    "  epsilon@third  current",
  ].join("\n");

  test("keeps the subject and verdict of every drifted row", () => {
    expect(driftReport(findings).standing).toEqual([
      { subject: "alpha@first", verdict: "stale" },
      { subject: "beta@third", verdict: "pinned" },
      { subject: "gamma@first", verdict: "orphaned" },
    ]);
  });

  test("takes the unverified rows as held rather than as findings", () => {
    expect(driftReport(findings).held).toEqual(["delta@third"]);
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
    writeScript(join(stubs, "claude"), "exit 1");
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

  test("discards herdr's settings edit and keeps moshi's", () => {
    expect(installAgentHooks(out, repo, process.env)).toBe(true);
    expect(readLog("hooks.log")).toBe(
      "herdr integration install claude\nmoshi-hook install --target claude\n",
    );
    expect(repoSettings()).toEqual({ "moshi-hook": 1 });
  });

  // herdr writes its entry before it can fail on a later step. The discard has to
  // take that back too: left in the tree, it holds the sync gate shut on every
  // later run, and that gate is what this step needs to clear to run again.
  test("reports a failed install and still discards what it wrote", () => {
    process.env.HERDR_FAILS = "1";
    process.env.MOSHI_FAILS = "1";

    expect(installAgentHooks(out, repo, process.env)).toBe(false);
    expect(out.captured()).toContain("herdr integration install failed");
    expect(out.captured()).toContain("moshi-hook install failed");
    expect(settingsStatus()).toBe("clean");
  });

  // Only what herdr wrote comes back out. An edit already in the tree when the
  // install started belongs to whoever made it, and restoring the committed file
  // would take that with it.
  test("keeps an edit the install did not make", () => {
    rmSync(join(stubs, "moshi-hook"));
    writeRepoSettings({ unrelated: 1 });

    expect(installAgentHooks(out, repo, process.env)).toBe(true);
    expect(repoSettings()).toEqual({ unrelated: 1 });
  });

  // The entry survives a restore that could not write, and the sync gate blocks
  // on it the next night. Reporting it here is what says which run put it there.
  test("reports a restore that could not run", () => {
    rmSync(join(stubs, "moshi-hook"));
    process.env.HERDR_LOCKS = "1";

    expect(installAgentHooks(out, repo, process.env)).toBe(false);
    expect(out.captured()).toContain("Could not discard herdr's edit");
    expect(repoSettings()).toEqual({ herdr: 1 });
  });

  // A missing installer stays out of the log rather than warning every night.
  test("skips an installer that is not on PATH", () => {
    rmSync(join(stubs, "herdr"));
    rmSync(join(stubs, "moshi-hook"));
    const env = { ...process.env, PATH: `${stubs}:/usr/bin:/bin` };

    expect(installAgentHooks(out, repo, env)).toBe(true);
    expect(out.captured()).toBe("");
    expect(readLog("hooks.log")).toBe("");
  });
});

describe("sync", () => {
  function auditStub(status: number): string {
    const path = join(sandbox, `audit-${status}`);
    writeScript(path, `exit ${status}`);
    return path;
  }

  test("succeeds when the sync, the updates and the audit all do", () => {
    expect(sync(out, repo, { audit: auditStub(0) })).toBe(0);
    expect(readLog("plugin.log")).toContain("update alpha@first");
  });

  // The install follows the sync, so the pull that removes a stale script from
  // the clone runs against a clean tree before the installer puts the current one
  // back.
  test("reinstalls the hooks after the sync and before the plugins", () => {
    expect(sync(out, repo, { audit: auditStub(0) })).toBe(0);
    const log = out.captured();
    expect(log.indexOf("Syncing Claude repository")).toBeLessThan(log.indexOf("Installing herdr"));
    expect(log.indexOf("Installing moshi")).toBeLessThan(log.indexOf("Updating marketplaces"));
  });

  test("fails when a hook install fails, and still updates the plugins", () => {
    process.env.HERDR_FAILS = "1";
    expect(sync(out, repo, { audit: auditStub(0) })).toBe(1);
    expect(readLog("plugin.log")).toContain("update alpha@first");
  });

  test("fails when a plugin update fails, and still audits", () => {
    process.env.CLAUDE_UPDATE_FAILS = "beta@third";
    expect(sync(out, repo, { audit: auditStub(0) })).toBe(1);
    expect(out.captured()).toContain("Auditing plugin payloads");
  });

  test("leaves the plugins unattempted when the sync refuses", () => {
    writeRepoSettings(settingsJson(GUARDED_HOOK, "changed"));
    expect(sync(out, repo, { audit: auditStub(0) })).toBe(1);
    expect(readLog("plugin.log")).toBe("");
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
    const audit = join(sandbox, "audit-clean");
    writeScript(audit, "exit 0");

    expect(main(out, { audit })).toBe(0);
    expect(todoCount()).toBe(0);
    expect(readFileSync(join(sandbox, "state", "dotfiles", "claude-sync.status"), "utf8")).toBe(
      "ok\n",
    );
  });
});
