// The Claude Code plugins installed on this machine, and where each one's
// marketplace says it comes from. bin/claude-upgrade updates the plugins and
// bin/claude-plugin-audit checks the update landed.

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

function enabledPlugins(): InstalledPlugin[] {
  const path = join(home(), ".claude", "settings.json");
  // A settings.json that is not there enables nothing by name. Only a file that
  // exists and cannot be read or parsed stops the inventory, so a zero-byte one,
  // which is a file something wrote wrong, is loud.
  if (!isFile(path)) return [];

  let captured: string;
  try {
    captured = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`settings.json could not be read: ${describe(error)}`);
  }

  const settings = parse(captured, "settings.json");
  if (settings === null) return [];
  if (!isRecord(settings)) throw new Error("settings.json does not hold an object");

  const enabled = settings.enabledPlugins;
  if (enabled === undefined || enabled === null || enabled === false) return [];
  if (!isRecord(enabled)) throw new Error("settings.json enabledPlugins is not an object");

  // settings.json records a plugin turned off as an explicit false rather than
  // dropping the key, so reading the keys alone would enumerate (and install) a
  // disabled plugin. Only false and null are off.
  return Object.entries(enabled)
    .filter(([, value]) => value !== false && value !== null)
    .map(([id]) => ({ id, installPath: "" }));
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

export function pluginSource(id: string): SourceLookup {
  // Split on the last `@`. A plugin name may carry one of its own, so the
  // marketplace is whatever follows the final separator.
  const separator = id.lastIndexOf("@");
  const name = separator === -1 ? id : id.slice(0, separator);
  const marketplace = separator === -1 ? id : id.slice(separator + 1);

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
