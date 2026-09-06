import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { claudePluginsDir, pluginInventory, pluginSource } from "./claude-plugins.ts";

const cli = join(dirname(import.meta.dir), "..", "bin", "claude-plugins");
const shim = join(import.meta.dir, "claude-plugins.sh");

let sandbox: string;
let plugins: string;
const environment = { HOME: process.env.HOME, PATH: process.env.PATH };

// `claude plugin list --json` is the only call the inventory makes, so a file the
// example writes is the whole of what the CLI reports. CLAUDE_LIST_STATUS makes
// the call fail without changing what it would have printed.
const claudeStub = `#!/bin/sh
case "$2" in
  list)
    [ -n "\${CLAUDE_LIST_STATUS:-}" ] && exit "$CLAUDE_LIST_STATUS"
    cat "$HOME/plugin-list.json"
    ;;
esac
exit 0
`;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "claude-plugins-"));
  plugins = join(sandbox, ".claude", "plugins");
  mkdirSync(plugins, { recursive: true });

  const stubs = join(sandbox, "stub");
  mkdirSync(stubs);
  writeFileSync(join(stubs, "claude"), claudeStub);
  chmodSync(join(stubs, "claude"), 0o755);

  process.env.HOME = sandbox;
  process.env.PATH = `${stubs}:${environment.PATH}`;
  delete process.env.CLAUDE_LIST_STATUS;

  writeList([{ id: "probe@stub", scope: "user", installPath: "" }]);

  // A stub that failed to shadow the real CLI would enumerate the machine's own
  // plugins, and every example would then be asserting against whatever this
  // machine happens to have installed. Prove the shadowing before each one.
  const probed = pluginInventory();
  if (!probed.ok || probed.plugins.length !== 1 || probed.plugins[0].id !== "probe@stub") {
    throw new Error(`claude resolved to ${JSON.stringify(probed)}`);
  }
  writeList([]);
});

afterEach(() => {
  process.env.HOME = environment.HOME;
  process.env.PATH = environment.PATH;
  delete process.env.CLAUDE_LIST_STATUS;
  rmSync(sandbox, { recursive: true, force: true });
});

function writeList(listed: unknown): void {
  writeFileSync(
    join(sandbox, "plugin-list.json"),
    typeof listed === "string" ? listed : JSON.stringify(listed),
  );
}

function writeSettings(settings: unknown): void {
  writeFileSync(
    join(sandbox, ".claude", "settings.json"),
    typeof settings === "string" ? settings : JSON.stringify(settings),
  );
}

function record(id: string, installPath = ""): Record<string, unknown> {
  return { id, scope: "user", installPath };
}

function payload(...segments: string[]): string {
  const path = join(plugins, "cache", ...segments);
  mkdirSync(path, { recursive: true });
  return path;
}

// The marker Claude Code writes into a payload it has replaced.
function orphan(path: string): string {
  writeFileSync(join(path, ".orphaned_at"), "");
  return path;
}

function inventory(): Record<string, string> {
  const read = pluginInventory();
  if (!read.ok) throw new Error(`inventory failed: ${read.reason}`);
  return Object.fromEntries(read.plugins.map((plugin) => [plugin.id, plugin.installPath]));
}

function ids(): string[] {
  const read = pluginInventory();
  if (!read.ok) throw new Error(`inventory failed: ${read.reason}`);
  return read.plugins.map((plugin) => plugin.id);
}

function writeManifest(marketplace: string, manifest: unknown): void {
  const dir = join(plugins, "marketplaces", marketplace, ".claude-plugin");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "marketplace.json"),
    typeof manifest === "string" ? manifest : JSON.stringify(manifest),
  );
}

describe("claudePluginsDir", () => {
  test("resolves under HOME at call time", () => {
    expect(claudePluginsDir()).toBe(plugins);
    process.env.HOME = join(sandbox, "elsewhere");
    expect(claudePluginsDir()).toBe(join(sandbox, "elsewhere", ".claude", "plugins"));
  });
});

describe("plugin enumeration", () => {
  test("unions what the CLI reports with what settings.json enables", () => {
    const alpha = payload("first", "alpha", "1.0.0");
    writeList([record("alpha@first", alpha)]);
    writeSettings({ enabledPlugins: { "beta@third": true } });

    // A plugin enabled but never installed appears with an empty payload, which
    // is what tells the updater to install it.
    expect(inventory()).toEqual({ "alpha@first": alpha, "beta@third": "" });
  });

  // The filter this replaced kept only ids ending in the first-party marketplace
  // name, so every third-party plugin went unattempted for months.
  test("includes plugins from every marketplace", () => {
    writeList([record("alpha@first"), record("beta@third")]);
    expect(ids()).toEqual(["alpha@first", "beta@third"]);
  });

  // `claude plugin update` works at user scope, so a plugin a project enabled is
  // not this job's to update.
  test("leaves out a plugin enabled outside user scope", () => {
    writeList([record("alpha@first"), { id: "local@first", scope: "project", installPath: "" }]);
    expect(ids()).toEqual(["alpha@first"]);
  });

  // settings.json records a plugin turned off as a false value rather than
  // dropping the key, so reading the keys alone would install it.
  test("leaves out a plugin settings.json turned off", () => {
    writeSettings({ enabledPlugins: { "alpha@first": true, "disabled@first": false } });
    expect(ids()).toEqual(["alpha@first"]);
  });

  // Only false and null are off. Every other value is a plugin left on, however
  // little it looks like one.
  test("keeps a plugin enabled with a value that is neither false nor null", () => {
    writeSettings({
      enabledPlugins: { "zero@first": 0, "empty@first": "", "list@first": [], "off@first": null },
    });
    expect(ids()).toEqual(["empty@first", "list@first", "zero@first"]);
  });

  test("emits one row per plugin, ordered by code unit", () => {
    writeList([record("gamma@first"), record("alpha@first"), record("beta@third")]);
    writeSettings({ enabledPlugins: { "alpha@first": true, "delta@third": true } });
    expect(ids()).toEqual(["alpha@first", "beta@third", "delta@third", "gamma@first"]);
  });

  test("skips a record with no id", () => {
    writeList([record(""), record("alpha@first")]);
    expect(ids()).toEqual(["alpha@first"]);
  });
});

describe("duplicate records", () => {
  test("points a duplicated plugin at the payload that exists", () => {
    const installed = payload("first", "gamma", "1.0.0");
    const missing = join(plugins, "cache", "first", "gamma", "unknown");
    writeList([record("gamma@first", missing), record("gamma@first", installed)]);
    expect(inventory()["gamma@first"]).toBe(installed);

    writeList([record("gamma@first", installed), record("gamma@first", missing)]);
    expect(inventory()["gamma@first"]).toBe(installed);
  });

  test("prefers a payload Claude Code has not superseded", () => {
    const superseded = orphan(payload("first", "gamma", "1.0.0"));
    const current = payload("first", "gamma", "2.0.0");
    writeList([record("gamma@first", superseded), record("gamma@first", current)]);
    expect(inventory()["gamma@first"]).toBe(current);

    writeList([record("gamma@first", current), record("gamma@first", superseded)]);
    expect(inventory()["gamma@first"]).toBe(current);
  });

  test("takes the last superseded payload when every one has been superseded", () => {
    const older = orphan(payload("first", "gamma", "1.0.0"));
    const newer = orphan(payload("first", "gamma", "2.0.0"));
    writeList([record("gamma@first", older), record("gamma@first", newer)]);
    expect(inventory()["gamma@first"]).toBe(newer);
  });

  // Any entry of that name marks the payload, whatever its type.
  test("counts a directory named .orphaned_at as the marker", () => {
    const superseded = payload("first", "gamma", "1.0.0", ".orphaned_at");
    const current = payload("first", "gamma", "2.0.0");
    writeList([
      record("gamma@first", join(plugins, "cache", "first", "gamma", "1.0.0")),
      record("gamma@first", current),
    ]);
    expect(superseded).toContain(".orphaned_at");
    expect(inventory()["gamma@first"]).toBe(current);
  });

  // Callers distinguish "no payload installed" from "payload at path X", so a
  // path the CLI recorded is handed back even when nothing is there.
  test("keeps the first recorded path when none of them exists", () => {
    const first = join(plugins, "cache", "first", "gamma", "1.0.0");
    const second = join(plugins, "cache", "first", "gamma", "2.0.0");
    writeList([record("gamma@first", first), record("gamma@first", second)]);
    expect(inventory()["gamma@first"]).toBe(first);
  });

  test("emits a row for a plugin that has no recorded payload at all", () => {
    writeList([record("gamma@first"), record("gamma@first")]);
    expect(inventory()).toEqual({ "gamma@first": "" });
  });
});

// Updating nothing and reporting success is the failure this library exists to
// make loud, so every one of these has to arrive distinguishable from a machine
// with no plugins.
describe("unreadable inventory", () => {
  test.each<{ name: string; arrange: () => void; reason: string }>([
    {
      name: "the CLI exits non-zero",
      arrange: () => {
        process.env.CLAUDE_LIST_STATUS = "1";
      },
      reason: "claude plugin list failed",
    },
    {
      name: "the CLI is not installed",
      arrange: () => {
        process.env.PATH = join(sandbox, "empty");
      },
      reason: "claude plugin list",
    },
    {
      name: "a stray line reaches the CLI's stdout",
      arrange: () => writeList("not json\n"),
      reason: "claude plugin list is not JSON",
    },
    {
      name: "the CLI reports something other than an array",
      arrange: () => writeList({ plugins: [] }),
      reason: "did not report an array",
    },
    {
      name: "a record is not an object",
      arrange: () => writeList(["alpha@first"]),
      reason: "not an object",
    },
    {
      name: "a record's id is not a string",
      arrange: () => writeList([{ id: 7, scope: "user", installPath: "" }]),
      reason: "plugin id",
    },
    {
      name: "settings.json does not parse",
      arrange: () => writeSettings("not json\n"),
      reason: "settings.json is not JSON",
    },
    // A settings.json holding nothing is a file something wrote wrong. Reading it
    // as "no plugins enabled" would silently stop enumerating every plugin the CLI
    // has not installed.
    {
      name: "settings.json is zero bytes",
      arrange: () => writeSettings(""),
      reason: "settings.json is not JSON",
    },
    {
      name: "settings.json does not hold an object",
      arrange: () => writeSettings([{ enabledPlugins: {} }]),
      reason: "does not hold an object",
    },
    {
      name: "enabledPlugins is not an object",
      arrange: () => writeSettings({ enabledPlugins: "alpha@first" }),
      reason: "enabledPlugins is not an object",
    },
  ])("fails when $name", ({ arrange, reason }) => {
    arrange();
    const read = pluginInventory();
    if (read.ok) throw new Error(`inventory succeeded with ${JSON.stringify(read.plugins)}`);
    expect(read.reason).toContain(reason);
  });
});

describe("readable but empty inventory", () => {
  test("treats no output from the CLI as no plugins", () => {
    writeList("");
    expect(pluginInventory()).toEqual({ ok: true, plugins: [] });
  });

  test("succeeds when settings.json is absent", () => {
    writeList([record("alpha@first")]);
    expect(ids()).toEqual(["alpha@first"]);
  });

  // The read is guarded on a regular file, so a directory at the settings path
  // reports no enabled plugins rather than stopping the inventory.
  test("reads no settings from a directory at the settings path", () => {
    mkdirSync(join(sandbox, ".claude", "settings.json"));
    writeList([record("alpha@first")]);
    expect(ids()).toEqual(["alpha@first"]);
  });

  test("treats a null enabledPlugins as nothing enabled", () => {
    writeSettings({ enabledPlugins: null });
    expect(ids()).toEqual([]);
  });

  // An editor that saved the file with a byte order mark left valid JSON behind
  // it, and a machine whose plugins enumerated yesterday has to keep
  // enumerating today.
  test("reads a settings.json carrying a byte order mark", () => {
    writeList([record("alpha@first")]);
    writeSettings(`\uFEFF${JSON.stringify({ enabledPlugins: { "beta@third": true } })}`);
    expect(ids()).toEqual(["alpha@first", "beta@third"]);
  });

  test("reads a plugin list carrying a byte order mark", () => {
    writeList(`\uFEFF${JSON.stringify([record("alpha@first")])}`);
    expect(ids()).toEqual(["alpha@first"]);
  });
});

describe("pluginSource", () => {
  beforeEach(() => {
    writeManifest("first", {
      name: "first",
      plugins: [{ name: "alpha", source: "./plugins/alpha" }, { name: "gamma", source: {} }],
    });
  });

  test("returns the source the marketplace records", () => {
    expect(pluginSource("alpha@first")).toEqual({ ok: true, source: "./plugins/alpha" });
  });

  test("returns a non-string source as the value it holds", () => {
    writeManifest("third", {
      plugins: [{ name: "delta", source: { source: "github", repo: "example/delta" } }],
    });
    expect(pluginSource("delta@third")).toEqual({
      ok: true,
      source: { source: "github", repo: "example/delta" },
    });
  });

  // Only a marketplace that stopped listing the plugin is beyond updating, and
  // uninstalling is the fix.
  test("reports a plugin the marketplace no longer lists as absent", () => {
    expect(pluginSource("ghost@first")).toEqual({ ok: false, reason: "absent" });
  });

  test("reports a marketplace with no plugins at all as absent", () => {
    writeManifest("bare", { name: "bare" });
    expect(pluginSource("alpha@bare")).toEqual({ ok: false, reason: "absent" });
  });

  // One that lists the plugin without saying where it comes from still carries
  // it. Reading that as absent would skip the plugin in every update and then
  // tell you to uninstall something the marketplace still offers.
  test("reports a plugin listed without a source as unreadable", () => {
    writeManifest("first", { plugins: [{ name: "alpha" }, { name: "beta", source: null }] });
    expect(pluginSource("alpha@first")).toEqual({ ok: false, reason: "unreadable" });
    expect(pluginSource("beta@first")).toEqual({ ok: false, reason: "unreadable" });
  });

  test("reports a missing manifest as unreadable", () => {
    expect(pluginSource("alpha@nowhere")).toEqual({ ok: false, reason: "unreadable" });
  });

  test("reports an unparseable manifest as unreadable", () => {
    writeManifest("broken", "not json\n");
    expect(pluginSource("alpha@broken")).toEqual({ ok: false, reason: "unreadable" });
  });

  // A byte order mark ahead of the manifest is not a marketplace that stopped
  // vouching for its plugins.
  test("reads a manifest carrying a byte order mark", () => {
    const manifest = { plugins: [{ name: "delta", source: "./plugins/delta" }] };
    writeManifest("third", `\uFEFF${JSON.stringify(manifest)}`);
    expect(pluginSource("delta@third")).toEqual({ ok: true, source: "./plugins/delta" });
  });

  test("splits the id on its last @", () => {
    writeManifest("third", { plugins: [{ name: "a@b", source: "./plugins/ab" }] });
    expect(pluginSource("a@b@third")).toEqual({ ok: true, source: "./plugins/ab" });
  });

  // An id with no @ names a marketplace of that whole name, which is normally
  // not there.
  test("reports an id carrying no marketplace as unreadable", () => {
    expect(pluginSource("alpha")).toEqual({ ok: false, reason: "unreadable" });
  });
});

describe("the CLI the shell callers reach", () => {
  function run(args: string[]): { code: number; stdout: string; stderr: string } {
    const spawned = Bun.spawnSync({ cmd: [cli, ...args], env: process.env });
    return {
      code: spawned.exitCode,
      stdout: spawned.stdout.toString(),
      stderr: spawned.stderr.toString(),
    };
  }

  test("prints the plugin state directory", () => {
    expect(run(["dir"])).toMatchObject({ code: 0, stdout: `${plugins}\n` });
  });

  test("prints one tab-separated row per plugin", () => {
    const alpha = payload("first", "alpha", "1.0.0");
    writeList([record("alpha@first", alpha)]);
    writeSettings({ enabledPlugins: { "beta@third": true } });
    expect(run(["inventory"])).toMatchObject({
      code: 0,
      stdout: `alpha@first\t${alpha}\nbeta@third\t\n`,
    });
  });

  // The row is the unit both callers read with `IFS=$'\t' read -r id payload`. A
  // tab or a newline arriving raw would end one row early and hand the rest to
  // the next read as a plugin nobody installed.
  test("escapes a tab or a newline rather than splitting the row", () => {
    writeList([record("alpha@first", "/tmp/x\ny"), record("beta@third", "/tmp/p\tq")]);
    expect(run(["inventory"]).stdout).toBe("alpha@first\t/tmp/x\\ny\nbeta@third\t/tmp/p\\tq\n");
  });

  // The captured run is what the failure to-do quotes, so the cause has to reach
  // stderr rather than only the exit status.
  test("exits 1 and names the cause when the inventory cannot be read", () => {
    writeSettings("not json\n");
    const failed = run(["inventory"]);
    expect(failed.code).toBe(1);
    expect(failed.stdout).toBe("");
    expect(failed.stderr).toContain("settings.json is not JSON");
  });

  // 3 and 4 are the contract bin/claude-upgrade and bin/claude-plugin-audit
  // compare against numerically.
  test("exits 3 on an unreadable source and 4 on an absent one", () => {
    writeManifest("first", { plugins: [{ name: "alpha" }] });
    expect(run(["source", "alpha@first"]).code).toBe(3);
    expect(run(["source", "ghost@first"]).code).toBe(4);
    expect(run(["source", "alpha@nowhere"]).code).toBe(3);
  });

  test("prints the source as compact JSON", () => {
    writeManifest("first", {
      plugins: [
        { name: "alpha", source: "./plugins/alpha" },
        { name: "delta", source: { source: "github", repo: "example/delta" } },
      ],
    });
    expect(run(["source", "alpha@first"]).stdout).toBe('"./plugins/alpha"\n');
    expect(run(["source", "delta@first"]).stdout).toBe(
      '{"source":"github","repo":"example/delta"}\n',
    );
  });
});

describe("the shim the shell callers source", () => {
  function sourced(snippet: string): { code: number; stdout: string } {
    const spawned = Bun.spawnSync({
      cmd: ["bash", "-c", `source "$1"; shift; ${snippet}`, "_", shim],
      env: process.env,
    });
    return { code: spawned.exitCode, stdout: spawned.stdout.toString() };
  }

  test("names the two sentinel codes the callers branch on", () => {
    expect(sourced('printf "%s %s\\n" "$PLUGIN_SOURCE_UNREADABLE" "$PLUGIN_SOURCE_ABSENT"')).toEqual(
      { code: 0, stdout: "3 4\n" },
    );
  });

  test("defines claude_plugins_dir and plugin_inventory", () => {
    const alpha = payload("first", "alpha", "1.0.0");
    writeList([record("alpha@first", alpha)]);
    expect(sourced("claude_plugins_dir")).toEqual({ code: 0, stdout: `${plugins}\n` });
    expect(sourced("plugin_inventory")).toEqual({ code: 0, stdout: `alpha@first\t${alpha}\n` });
  });

  test("defines plugin_source, carrying the sentinel codes out", () => {
    writeManifest("first", { plugins: [{ name: "alpha", source: "./plugins/alpha" }] });
    expect(sourced("plugin_source alpha@first")).toEqual({
      code: 0,
      stdout: '"./plugins/alpha"\n',
    });
    expect(sourced("plugin_source ghost@first").code).toBe(4);
    expect(sourced("plugin_source alpha@nowhere").code).toBe(3);
  });

  test("fails the inventory rather than printing an empty one", () => {
    writeSettings("not json\n");
    expect(sourced("plugin_inventory")).toEqual({ code: 1, stdout: "" });
  });
});
