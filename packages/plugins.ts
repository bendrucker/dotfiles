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

// What a payload's manifest says it depends on. A manifest that exists and
// cannot be read arrives as a failure rather than as no dependencies, because
// the caller uninstalls whatever nothing accounts for.
export type Dependencies = { ok: true; ids: string[] } | { ok: false; reason: string };

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

// `claude plugin update` works at user scope, so a plugin a project or a
// settings.local.json enabled is out of scope and not this job's to update.
function listedPlugins(): InstalledPlugin[] {
  const run = runList();
  if (run.exitCode !== 0) throw new Error("claude plugin list failed");

  const captured = run.stdout.toString().replace(TRAILING_NEWLINES, "");
  // No output at all is a machine with no plugins. Anything else, whitespace
  // included, has to parse.
  const listed = captured === "" ? [] : parse(captured, "claude plugin list");
  if (!Array.isArray(listed)) throw new Error("claude plugin list did not report an array");

  const rows: InstalledPlugin[] = [];
  for (const entry of listed) {
    if (entry === null) continue;
    if (!isRecord(entry)) {
      throw new Error("claude plugin list reported an entry that is not an object");
    }
    if (entry.scope !== "user") continue;
    rows.push({
      id: text(entry.id, "a plugin id"),
      installPath: text(entry.installPath, "an installPath"),
    });
  }
  return rows;
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

// settings.json's whole enabledPlugins map, keys and values both, or undefined
// when the file is not there. Reading it separately from the two views below is
// what keeps them from disagreeing about which plugins the file names, and the
// absent case is theirs to interpret: it enables nothing, and it declares
// nothing either, which are different answers to a caller that uninstalls.
function settingsPlugins(): Record<string, unknown> | undefined {
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

  const enabled = settings.enabledPlugins;
  if (enabled === undefined || enabled === null || enabled === false) return {};
  if (!isRecord(enabled)) throw new Error("settings.json enabledPlugins is not an object");
  return enabled;
}

function enabledPlugins(): InstalledPlugin[] {
  // settings.json records a plugin turned off as an explicit false rather than
  // dropping the key, so reading the keys alone would enumerate (and install) a
  // disabled plugin. Only false and null are off.
  return Object.entries(settingsPlugins() ?? {})
    .filter(([, value]) => value !== false && value !== null)
    .map(([id]) => ({ id, installPath: "" }));
}

// Every id settings.json names, an explicitly disabled one included. A key set
// to false declares a plugin that is installed and turned off, so its payload is
// meant to stay.
export function declaredPlugins(): Declaration {
  let named: Record<string, unknown> | undefined;
  try {
    named = settingsPlugins();
  } catch (error) {
    return { ok: false, reason: describe(error) };
  }

  // A file that is not there declares nothing and permits nothing. It is the
  // shape a broken symlink into the config repo leaves behind, and reading it as
  // an empty declaration would uninstall every plugin on the machine. A file
  // that is there and names no plugins is a real declaration of none.
  if (named === undefined) {
    return {
      ok: false,
      reason: "settings.json is not there, so nothing declares which plugins belong",
    };
  }
  return { ok: true, ids: new Set(Object.keys(named)) };
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

// Split on the last `@`. A plugin name may carry one of its own, so the
// marketplace is whatever follows the final separator. An id with no separator
// names neither half on its own, and both callers below read it as both.
export function splitPluginId(id: string): { name: string; marketplace: string } {
  const separator = id.lastIndexOf("@");
  if (separator === -1) return { name: id, marketplace: id };
  return { name: id.slice(0, separator), marketplace: id.slice(separator + 1) };
}

// The plugin ids a payload's manifest names as its dependencies. Claude Code
// installs a dependency at user scope without writing a settings.json key for
// it, so nothing marks it as wanted and a prune reading the declaration alone
// would take it out from under the plugin that needs it. A bare name resolves
// against the marketplace the depending plugin came from, which is how the
// manifests in the wild spell them.
//
// A payload with no manifest at all names no dependencies, which is the ordinary
// answer for a plugin that ships none. A manifest that is there and cannot be
// read is a different answer: it may name a dependency, and the caller would
// uninstall that dependency on the strength of a file nothing parsed.
export function pluginDependencies(id: string, installPath: string): Dependencies {
  if (installPath === "") return { ok: true, ids: [] };

  const manifest = join(installPath, ".claude-plugin", "plugin.json");
  if (!isFile(manifest)) return { ok: true, ids: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifest, "utf8").replace(BYTE_ORDER_MARK, ""));
  } catch (error) {
    return { ok: false, reason: `manifest could not be read: ${describe(error)}` };
  }
  if (!isRecord(parsed)) return { ok: false, reason: "manifest does not hold an object" };

  const declared = parsed.dependencies;
  if (declared === undefined || declared === null || declared === false) {
    return { ok: true, ids: [] };
  }
  if (!Array.isArray(declared)) {
    return { ok: false, reason: "manifest dependencies is not an array" };
  }

  const { marketplace } = splitPluginId(id);
  const ids: string[] = [];
  for (const entry of declared) {
    // An entry in a shape nothing here reads leaves the rest of the list
    // unaccounted for, and the plugin it meant to name would be uninstalled.
    if (typeof entry !== "string" || entry === "") {
      return { ok: false, reason: "manifest names a dependency that is not a name" };
    }
    ids.push(entry.includes("@") ? entry : `${entry}@${marketplace}`);
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

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
