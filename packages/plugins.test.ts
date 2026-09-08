import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claudePluginsDir,
  declaredPlugins,
  installedPlugins,
  pluginDependencies,
  pluginInventory,
  pluginSource,
  splitPluginId,
} from "#plugins";

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
  sandbox = mkdtempSync(join(tmpdir(), "plugins-"));
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

// The manifest Claude Code reads out of an installed payload, which is where a
// plugin's dependencies are written down.
function writePayloadManifest(path: string, manifest: unknown): void {
  mkdirSync(join(path, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(path, ".claude-plugin", "plugin.json"),
    typeof manifest === "string" ? manifest : JSON.stringify(manifest),
  );
}

function declared(): string[] {
  const read = declaredPlugins();
  if (!read.ok) throw new Error(`declaration failed: ${read.reason}`);
  return [...read.ids].sort();
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


describe("splitPluginId", () => {
  test("splits on the last separator, so a name may carry one of its own", () => {
    expect(splitPluginId("a@b@market")).toEqual({ name: "a@b", marketplace: "market" });
  });

  // An id with no separator names neither half, and both readers of it treat the
  // whole string as the answer to whichever they asked for.
  test("reads an id with no separator as both halves", () => {
    expect(splitPluginId("bare")).toEqual({ name: "bare", marketplace: "bare" });
  });
});

describe("declaredPlugins", () => {
  // The enabled view drops a key set to false, because reading the keys alone
  // would install a plugin that is deliberately off. The declaration keeps it:
  // the file naming a plugin is what says its payload belongs here.
  test("keeps an id settings.json turned off", () => {
    writeSettings({ enabledPlugins: { "on@market": true, "off@market": false } });
    expect(declared()).toEqual(["off@market", "on@market"]);
    expect(ids()).toEqual(["on@market"]);
  });

  test("declares nothing when settings.json is not there", () => {
    rmSync(join(sandbox, ".claude", "settings.json"), { force: true });
    expect(declared()).toEqual([]);
  });

  test("declares nothing when the file names no plugins", () => {
    writeSettings({ env: {} });
    expect(declared()).toEqual([]);
  });

  // A caller pruning against this reads an empty set as "nothing is declared"
  // and uninstalls every plugin on the machine, so an unreadable file has to
  // arrive as a failure rather than as no declarations.
  test("fails on a settings.json nothing can parse", () => {
    writeSettings("not json\n");
    expect(declaredPlugins().ok).toBe(false);
  });

  test("fails when enabledPlugins is not an object", () => {
    writeSettings({ enabledPlugins: ["on@market"] });
    expect(declaredPlugins().ok).toBe(false);
  });
});

describe("installedPlugins", () => {
  // The inventory folds in what settings.json enables, so a plugin declared but
  // never installed appears there with no payload. This view reports payloads
  // that exist, and a caller deciding what to uninstall has nothing to do with
  // a row that has none.
  test("reports what the CLI lists, without the declared-but-missing rows", () => {
    writeList([record("installed@market", payload("market", "installed", "1.0.0"))]);
    writeSettings({ enabledPlugins: { "installed@market": true, "missing@market": true } });

    const read = installedPlugins();
    if (!read.ok) throw new Error(read.reason);
    expect(read.plugins.map((plugin) => plugin.id)).toEqual(["installed@market"]);
    expect(ids()).toEqual(["installed@market", "missing@market"]);
  });

  test("fails when the CLI could not be read", () => {
    process.env.CLAUDE_LIST_STATUS = "1";
    expect(installedPlugins().ok).toBe(false);
  });
});

describe("pluginDependencies", () => {
  test("resolves a bare name against the depending plugin's marketplace", () => {
    const path = payload("market", "alpha", "1.0.0");
    writePayloadManifest(path, { name: "alpha", dependencies: ["beta"] });
    expect(pluginDependencies("alpha@market", path)).toEqual(["beta@market"]);
  });

  test("leaves a dependency that names its own marketplace alone", () => {
    const path = payload("market", "alpha", "1.0.0");
    writePayloadManifest(path, { name: "alpha", dependencies: ["beta@other"] });
    expect(pluginDependencies("alpha@market", path)).toEqual(["beta@other"]);
  });

  test("names nothing for a payload with no manifest", () => {
    expect(pluginDependencies("alpha@market", payload("market", "alpha", "1.0.0"))).toEqual([]);
  });

  test("names nothing for a plugin with no payload", () => {
    expect(pluginDependencies("alpha@market", "")).toEqual([]);
  });

  // A manifest the plugin ships in a shape nothing here reads says as much about
  // its dependencies as one that declares none.
  test("names nothing for a manifest nothing can parse or use", () => {
    const broken = payload("market", "broken", "1.0.0");
    writePayloadManifest(broken, "not json\n");
    expect(pluginDependencies("broken@market", broken)).toEqual([]);

    const wrong = payload("market", "wrong", "1.0.0");
    writePayloadManifest(wrong, { name: "wrong", dependencies: "beta" });
    expect(pluginDependencies("wrong@market", wrong)).toEqual([]);
  });

  test("drops an entry that is not a name", () => {
    const path = payload("market", "alpha", "1.0.0");
    writePayloadManifest(path, { name: "alpha", dependencies: ["beta", "", 7, null] });
    expect(pluginDependencies("alpha@market", path)).toEqual(["beta@market"]);
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
