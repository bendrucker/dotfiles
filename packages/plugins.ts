// The Claude Code plugins installed on this machine, and where each one's
// marketplace says it comes from. bin/claude-sync prunes and updates the
// plugins and bin/claude-plugin-audit checks the update landed.

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface InstalledPlugin {
  id: string;
  installPath: string;
}

// An inventory that could not be read must never reach a caller as an empty one:
// an unparseable settings.json or a stray line on the CLI's stdout would
// otherwise read as "no plugins installed", and a job that updates nothing and
// reports success is the failure this file exists to remove. The reason travels
// with the failure so the run that captured it names the cause.
export type Inventory =
  | { ok: true; plugins: InstalledPlugin[] }
  | { ok: false; reason: string };

// `absent` means the marketplace stopped carrying the plugin, which is the one
// case where uninstalling is the fix. Everything else the lookup cannot get past
// is `unreadable`.
export type SourceLookup =
  | { ok: true; source: unknown }
  | { ok: false; reason: "unreadable" | "absent" };

// The ids settings.json names, whether or not it has them turned on. Carries the
// same failure shape as the inventory, and for the same reason: a set that could
// not be read is not an empty one, and the caller that prunes against it would
// read empty as "nothing is declared" and uninstall everything.
export type Declaration = { ok: true; ids: Set<string> } | { ok: false; reason: string };

const UNREADABLE = { ok: false, reason: "unreadable" } as const;
const ABSENT = { ok: false, reason: "absent" } as const;

const TRAILING_NEWLINES = /\n+$/;

// A byte order mark decodes to U+FEFF, which JSON.parse reports as a stray
// token. An editor that saved settings.json or a marketplace manifest with one
// left valid JSON behind it, so the mark is not a reason to call the inventory
// unreadable.
const BYTE_ORDER_MARK = /^\uFEFF/;

// $HOME is read per call rather than at load, because the specs re-point it
// between examples.
function home(): string {
  return process.env.HOME || homedir();
}

export function claudePluginsDir(): string {
  return join(home(), ".claude", "plugins");
}

export function pluginInventory(): Inventory {
  let rows: InstalledPlugin[];
  try {
    rows = listedPlugins().concat(enabledPlugins());
  } catch (error) {
    return { ok: false, reason: describe(error) };
  }
  return { ok: true, plugins: chooseInstallPaths(rows) };
}

interface ListedPlugin extends InstalledPlugin {
  scope: string;
}

function listedRows(): ListedPlugin[] {
  const run = runList();
  if (run.exitCode !== 0) throw new Error("claude plugin list failed");

  const captured = run.stdout.toString().replace(TRAILING_NEWLINES, "");
  // No output at all is a machine with no plugins. Anything else, whitespace
  // included, has to parse.
  const listed = captured === "" ? [] : parse(captured, "claude plugin list");
  if (!Array.isArray(listed)) throw new Error("claude plugin list did not report an array");

  const rows: ListedPlugin[] = [];
  for (const entry of listed) {
    if (entry === null) continue;
    if (!isRecord(entry)) {
      throw new Error("claude plugin list reported an entry that is not an object");
    }
    rows.push({
      id: text(entry.id, "a plugin id"),
      installPath: text(entry.installPath, "an installPath"),
      scope: text(entry.scope, "a scope"),
    });
  }
  return rows;
}

// `claude plugin update` works at user scope, so a project's plugin is not this
// job's to update.
function listedPlugins(): InstalledPlugin[] {
  return listedRows()
    .filter((row) => row.scope === "user")
    .map(({ id, installPath }) => ({ id, installPath }));
}

function runList() {
  try {
    return Bun.spawnSync({
      cmd: ["claude", "plugin", "list", "--json"],
      // Handed over rather than inherited, so the CLI is resolved against $PATH
      // as it stands at the call. An inherited environment resolves against the
      // $PATH the process started with, and a spec that shadows the CLI reaches
      // the real one.
      env: process.env,
      // A prompt-happy CLI handed the caller's stdin would swallow whatever the
      // caller is iterating. Its own complaints say nothing the failure this
      // raises does not.
      stdin: "ignore",
      stderr: "ignore",
    });
  } catch (error) {
    throw new Error(`claude plugin list could not be run: ${describe(error)}`);
  }
}

// The absent case is the caller's to interpret. Enabling nothing and declaring
// nothing are different answers to a caller that uninstalls.
function settingsMap(key: string): Record<string, unknown> | undefined {
  const path = join(home(), ".claude", "settings.json");
  if (!isFile(path)) return undefined;

  let captured: string;
  try {
    captured = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`settings.json could not be read: ${describe(error)}`);
  }

  const settings = parse(captured, "settings.json");
  if (settings === null) return {};
  if (!isRecord(settings)) throw new Error("settings.json does not hold an object");

  const named = settings[key];
  if (named === undefined || named === null || named === false) return {};
  if (!isRecord(named)) throw new Error(`settings.json ${key} is not an object`);
  return named;
}

function settingsPlugins(): Record<string, unknown> | undefined {
  return settingsMap("enabledPlugins");
}

function enabledPlugins(): InstalledPlugin[] {
  // settings.json records a plugin turned off as an explicit false rather than
  // dropping the key, so reading the keys alone would enumerate (and install) a
  // disabled plugin. Only false and null are off.
  return Object.entries(settingsPlugins() ?? {})
    .filter(([, value]) => value !== false && value !== null)
    .map(([id]) => ({ id, installPath: "" }));
}

// What a broken symlink into the config repo leaves behind. Reading it as an
// empty declaration would remove everything the key governs.
function readDeclaration(key: string, subject: string): Declaration {
  let named: Record<string, unknown> | undefined;
  try {
    named = settingsMap(key);
  } catch (error) {
    return { ok: false, reason: describe(error) };
  }

  if (named === undefined) {
    return {
      ok: false,
      reason: `settings.json is not there, so nothing declares which ${subject} belong`,
    };
  }
  return { ok: true, ids: new Set(Object.keys(named)) };
}

// A key set to false declares a plugin installed and turned off, so its payload
// is meant to stay.
export function declaredPlugins(): Declaration {
  return readDeclaration("enabledPlugins", "plugins");
}

// The user-scope payloads `claude plugin list` reports, without the
// declared-but-never-installed rows pluginInventory folds in. Those rows carry
// no payload, so a caller deciding what to uninstall has nothing to do with
// them.
export function installedPlugins(): Inventory {
  let rows: InstalledPlugin[];
  try {
    rows = listedPlugins();
  } catch (error) {
    return { ok: false, reason: describe(error) };
  }
  return { ok: true, plugins: chooseInstallPaths(rows) };
}

// A plugin can hold several records: an uninstall that left its metadata behind
// writes a duplicate pointing at a path that was never created, and `claude
// plugin list` prints both.
function chooseInstallPaths(rows: InstalledPlugin[]): InstalledPlugin[] {
  const paths = new Map<string, string[]>();
  for (const row of rows) {
    if (row.id === "") continue;
    const recorded = paths.get(row.id);
    if (recorded) recorded.push(row.installPath);
    else paths.set(row.id, [row.installPath]);
  }

  // Ordered by code unit, so the rows do not move with the ambient locale's
  // collation.
  const ids = [...paths.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return ids.map((id) => ({ id, installPath: bestPath(paths.get(id) ?? []) }));
}

// Prefer a payload that exists, and among those one Claude Code has not
// superseded, since it keeps the directory it replaced around under an
// .orphaned_at marker. A recorded path that exists nowhere is still the answer
// when nothing better turns up: callers distinguish "no payload installed" from
// "payload at path X", and the path is the detail the CLI recorded.
function bestPath(recorded: string[]): string {
  let best = "";
  for (const path of recorded) {
    if (path === "") continue;
    if (best === "") best = path;
    if (!isDirectory(path)) continue;
    best = path;
    if (!existsSync(join(path, ".orphaned_at"))) break;
  }
  return best;
}

export type Registry = { ok: true; names: string[] } | { ok: false; reason: string };

export type MarketplaceUse = { ok: true; names: Set<string> } | { ok: false; reason: string };

export function declaredMarketplaces(): Declaration {
  return readDeclaration("extraKnownMarketplaces", "marketplaces");
}

// The ref each declared marketplace pins its source to. A declaration that
// cannot be read yields an empty map, which leaves every marketplace to be
// refreshed.
export function declaredMarketplacePins(): Map<string, string> {
  let named: Record<string, unknown> | undefined;
  try {
    named = settingsMap("extraKnownMarketplaces");
  } catch {
    return new Map();
  }

  const pins = new Map<string, string>();
  for (const [name, entry] of Object.entries(named ?? {})) {
    const source = isRecord(entry) ? entry.source : undefined;
    const ref = isRecord(source) ? source.ref : undefined;
    if (typeof ref === "string" && ref !== "") pins.set(name, ref);
  }
  return pins;
}

// What `claude plugin marketplace update` walks. A bare `marketplace add` lands
// here too, so it holds more than settings.json names.
export function knownMarketplaces(): Registry {
  const path = join(claudePluginsDir(), "known_marketplaces.json");
  // Only absence reads as an empty registry; an unreadable file fails below.
  if (!existsSync(path)) return { ok: true, names: [] };

  let captured: string;
  try {
    captured = readFileSync(path, "utf8");
  } catch (error) {
    return { ok: false, reason: `known_marketplaces.json could not be read: ${describe(error)}` };
  }

  let registered: unknown;
  try {
    registered = parse(captured, "known_marketplaces.json");
  } catch (error) {
    return { ok: false, reason: describe(error) };
  }
  if (registered === null) return { ok: true, names: [] };
  if (!isRecord(registered)) {
    return { ok: false, reason: "known_marketplaces.json does not hold an object" };
  }
  return { ok: true, names: Object.keys(registered) };
}

// At every scope: a project's plugin gets no user-scope key, so a prune reading
// the declaration alone would remove its marketplace out from under it.
export function pluginMarketplaces(): MarketplaceUse {
  let rows: ListedPlugin[];
  try {
    rows = listedRows();
  } catch (error) {
    return { ok: false, reason: describe(error) };
  }

  const names = new Set<string>();
  for (const row of rows) {
    if (row.id === "") continue;
    names.add(splitPluginId(row.id).marketplace);
  }
  return { ok: true, names };
}

// A plugin name may carry an `@` of its own, so the marketplace follows the
// final separator. An id with no separator is read as both halves.
export function splitPluginId(id: string): { name: string; marketplace: string } {
  const separator = id.lastIndexOf("@");
  if (separator === -1) return { name: id, marketplace: id };
  return { name: id.slice(0, separator), marketplace: id.slice(separator + 1) };
}

// The user-scope ids Claude Code installed as another plugin's dependency.
// `claude plugin prune` owns those, and settings.json never names them, so a
// prune reading the declaration alone would take one out from under the plugin
// that needs it. `claude plugin list --json` drops the flag, which is why this
// reads the CLI's own record.
//
// No record at all is a machine with nothing installed. A record that is there
// and cannot be read is a failure, because every dependency it marks would be
// uninstalled.
export function autoInstalledPlugins(): Declaration {
  const path = join(claudePluginsDir(), "installed_plugins.json");
  if (!isFile(path)) return { ok: true, ids: new Set() };

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8").replace(BYTE_ORDER_MARK, ""));
  } catch (error) {
    return { ok: false, reason: `installed_plugins.json could not be read: ${describe(error)}` };
  }
  if (!isRecord(parsed) || !isRecord(parsed.plugins)) {
    return { ok: false, reason: "installed_plugins.json does not hold a plugins object" };
  }

  const ids = new Set<string>();
  for (const [id, records] of Object.entries(parsed.plugins)) {
    if (!Array.isArray(records)) {
      return { ok: false, reason: `installed_plugins.json ${id} is not a list of records` };
    }
    if (records.some((record) => isRecord(record) && record.scope === "user" && record.auto === true)) {
      ids.add(id);
    }
  }
  return { ok: true, ids };
}

export function pluginSource(id: string): SourceLookup {
  const { name, marketplace } = splitPluginId(id);

  const manifest = join(
    claudePluginsDir(),
    "marketplaces",
    marketplace,
    ".claude-plugin",
    "marketplace.json",
  );
  if (!isFile(manifest)) return UNREADABLE;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifest, "utf8").replace(BYTE_ORDER_MARK, ""));
  } catch {
    return UNREADABLE;
  }
  if (!isRecord(parsed)) return UNREADABLE;

  const listed = parsed.plugins;
  if (listed !== undefined && listed !== null && listed !== false && !Array.isArray(listed)) {
    return UNREADABLE;
  }
  const plugins: unknown[] = Array.isArray(listed) ? listed : [];

  let entry: Record<string, unknown> | undefined;
  for (const candidate of plugins) {
    if (candidate === null) continue;
    if (!isRecord(candidate)) return UNREADABLE;
    if (candidate.name === name) {
      entry = candidate;
      break;
    }
  }
  if (entry === undefined) return ABSENT;

  // A plugin the manifest lists without a source is unreadable, never absent.
  // Collapsing the two would skip the plugin in every update and then tell you
  // to uninstall something the marketplace still carries.
  const source = entry.source;
  if (source === undefined || source === null || source === false) return UNREADABLE;
  return { ok: true, source };
}

// Neither side of the comparison owns these. .in_use and .orphaned_at are
// runtime markers Claude Code writes into a payload, node_modules is an
// install-time artifact, and .git and .gcs-sha are the provenance markers of a
// marketplace whose whole tree is the plugin.
const PAYLOAD_NOISE = [".in_use", ".orphaned_at", "node_modules", ".git", ".gcs-sha"];

export interface Comparison {
  same: boolean;
  differences: string[];
  // A comparison can fail without diff saying anything, so failure is tracked
  // apart from the message.
  failed: boolean;
  error: string;
}

export function comparePayload(payload: string, sourceDir: string): Comparison {
  const excludes = PAYLOAD_NOISE.map((marker) => `--exclude=${marker}`);

  // Claude Code synthesizes .claude-plugin/plugin.json for a plugin that ships
  // none, so on those the directory exists only on the payload side and is not
  // drift.
  if (!isDirectory(join(sourceDir, ".claude-plugin"))) excludes.push("--exclude=.claude-plugin");

  let run;
  try {
    run = Bun.spawnSync({
      cmd: ["diff", "-rq", ...excludes, payload, sourceDir],
      env: process.env,
      stdin: "ignore",
    });
  } catch (error) {
    return { same: false, differences: [], failed: true, error: describe(error) };
  }

  // Both signals are needed. diff exits 2 on a path it could not read, but on
  // macOS a dangling symlink gets it an error on stderr and exit 0, so a status
  // check alone would call the payload current over a file nothing compared.
  const said = run.stderr.toString();
  // A diff killed by a signal has no exit code, so count it as a failure.
  const status = run.exitCode ?? 2;
  if (status > 1 || said !== "") {
    return { same: false, differences: [], failed: true, error: firstLine(said) };
  }

  return {
    same: status === 0,
    differences: run.stdout.toString().split("\n").filter((line) => line !== ""),
    failed: false,
    error: "",
  };
}

// Where a marketplace that carries a plugin in its own tree keeps it. A
// single-plugin marketplace whose whole tree is the plugin declares `.`, which
// carries no `./` to strip and so resolves to the marketplace root.
export function inTreeSource(marketplace: string, relative: string): string {
  return join(claudePluginsDir(), "marketplaces", marketplace, relative.replace(/^\.\//, ""));
}

function parse(captured: string, what: string): unknown {
  try {
    return JSON.parse(captured.replace(BYTE_ORDER_MARK, ""));
  } catch (error) {
    throw new Error(`${what} is not JSON: ${describe(error)}`);
  }
}

// A field that is absent, null or false is an empty string, which is the row a
// plugin enabled but never installed produces. One that is present as something
// other than a string is a shape no caller can use, so it stops the inventory
// rather than arriving stringified.
function text(value: unknown, what: string): string {
  if (value === undefined || value === null || value === false) return "";
  if (typeof value !== "string") {
    throw new Error(`claude plugin list reported ${what} that is not a string`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function firstLine(text: string): string {
  return text.split("\n")[0] ?? "";
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
