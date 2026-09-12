// The two halves of talking to Things from a job nobody is awake to help.
//
// Writes go through the `things:///` URL scheme, handed to `open`. Reads go
// through the app's own SQLite store, opened read-only.
//
// Apple events are the sanctioned way to read Things and they are not available
// here. A launchd agent is a different responsible process from the terminal
// that was granted Automation access, so `osascript` sending to Things from the
// 3am job blocks on an authorization decision nobody is there to make. It hangs
// rather than failing, which is the worst shape a dependency can have in an
// unattended job. `open` needs no such grant, and reading a file in the user's
// own group container needs none either.
//
// Nothing here writes to the database. It is read for three facts the URL scheme
// cannot answer: whether a to-do this job filed still exists, what its id is, and
// how much of the note budget it has already spent.

import { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Things stores 10,000 characters of notes and silently drops the rest. It cuts
// the tail, which is the wrong end to lose, since a job fails at the end of its
// log.
//
// The unit is UTF-16 code units: the notes field is an NSString, which is what
// Things counts, and it is also what String.length reports and what String.slice
// cuts on. Measuring and slicing in one unit is the point. A budget counted in
// characters and spent by a byte-wise cut disagree on every non-ASCII log.
export const THINGS_NOTES_LIMIT = 10_000;

// `type` 0 is a to-do, as against a project or a heading. `status` 0 is open, as
// against 2 canceled and 3 completed. A to-do Ben has finished with is not one to
// append tonight's run to: he dealt with the cause, so its return is news.
const FIND_OPEN =
  "select uuid as id, length(notes) as notesLength from TMTask" +
  " where type = 0 and trashed = 0 and status = 0 and notes like ?1 escape '\\'" +
  " order by creationDate desc limit 1";

// A marker goes into LIKE as a pattern, where _ matches any character and % any
// run of them. Both are legal in a job name, and either would widen the match
// past the one cause the marker names.
export function markerQuery(marker: string): string {
  return `%${marker.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

const CONTAINERS = join(homedir(), "Library", "Group Containers");
const DATABASE_GLOB = "*culturedcode.ThingsMac*/**/Things Database.thingsdatabase/main.sqlite";

const KEYCHAIN_SERVICE = "things-auth-token";

export interface Todo {
  id: string;
  notesLength: number;
}

// The live store. Things ships a beta alongside the release, each with its own
// container, and a machine can carry both. The one written most recently is the
// one in use, which is the only distinction available from outside the app.
export function thingsDatabase(): string | undefined {
  const override = process.env.THINGS_DATABASE;
  if (override) return override;

  const found = [...new Bun.Glob(DATABASE_GLOB).scanSync({ cwd: CONTAINERS, absolute: true })];
  return newest(found);
}

function newest(paths: string[]): string | undefined {
  let best: { path: string; at: number } | undefined;
  for (const path of paths) {
    const at = modifiedAt(path);
    if (at !== undefined && (best === undefined || at > best.at)) best = { path, at };
  }
  return best?.path;
}

function modifiedAt(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

// Whether the store could be read at all, and what it holds if so. The two are
// separate answers because they call for opposite handling: a store that says
// nothing stands for this cause means the to-do was finished, so the cause
// returning is news and files again, while a store that could not be read says
// nothing either way and leaves the caller's latch to decide.
export type TodoLookup = { readable: false } | { readable: true; todo?: Todo };

// The open to-do whose notes match `pattern`, which markerQuery builds.
//
// Read-only and WAL-aware. Never with `immutable=1`, which tells SQLite to skip
// the write-ahead log: Things leaves recent edits there, so an immutable read
// reports a to-do as open minutes after it was completed.
export function findOpenTodo(pattern: string): TodoLookup {
  const path = thingsDatabase();
  if (!path) return { readable: false };

  let db: Database | undefined;
  try {
    db = new Database(path, { readonly: true });
    const row = db.query(FIND_OPEN).get(pattern);
    return { readable: true, todo: isTodo(row) ? row : undefined };
  } catch {
    return { readable: false };
  } finally {
    db?.close();
  }
}

function isTodo(row: unknown): row is Todo {
  if (typeof row !== "object" || row === null) return false;
  const fields = row as Record<string, unknown>;
  return typeof fields.id === "string" && typeof fields.notesLength === "number";
}

// Percent-encode everything outside the unreserved set, so no field can leave a
// literal % or & behind to split the URL apart. encodeURIComponent spares !'()*,
// which the unreserved set does not.
function encodeField(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function thingsUrl(command: string, params: Record<string, string>): string {
  const query = Object.entries(params)
    .filter(([, value]) => value !== "")
    .map(([key, value]) => `${key}=${encodeField(value)}`)
    .join("&");
  return `things:///${command}?${query}`;
}

export interface NewTodo {
  title: string;
  notes: string;
  when: string;
  tags: string;
}

// `open`'s own exit status, so a refused filing takes the run down with the
// status that says why rather than the 1 a reported failure already carries.
export function addTodo(todo: NewTodo): number {
  return openUrl(thingsUrl("add", { ...todo }));
}

export interface TodoEdit {
  id: string;
  appendNotes?: string;
  title?: string;
  when?: string;
}

// `update` is the one Things command that needs the token from the app's
// settings, which lives in the login keychain so a launchd job can read it
// without a prompt. Without it nothing can be appended, and the caller files a
// fresh to-do instead of losing the run.
export function editTodo(edit: TodoEdit): boolean {
  const token = authToken();
  if (!token) return false;

  const url = thingsUrl("update", {
    "auth-token": token,
    id: edit.id,
    "append-notes": edit.appendNotes ?? "",
    title: edit.title ?? "",
    when: edit.when ?? "",
  });
  return openUrl(url) === 0;
}

export function authToken(): string | undefined {
  const security = Bun.which("security", { PATH: process.env.PATH });
  if (!security) return undefined;

  const child = Bun.spawnSync({
    cmd: [security, "find-generic-password", "-a", user(), "-s", KEYCHAIN_SERVICE, "-w"],
    env: process.env,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (child.exitCode !== 0) return undefined;

  const token = child.stdout.toString().trim();
  return token === "" ? undefined : token;
}

function user(): string {
  return process.env.USER || "";
}

// The environment goes across explicitly because Bun otherwise resolves a bare
// command name against the PATH it captured at startup, and a caller that
// adjusted PATH afterwards would reach a different binary than it meant to.
function openUrl(url: string): number {
  const open = Bun.which("open", { PATH: process.env.PATH });
  if (!open) return NOT_FOUND;

  const child = Bun.spawnSync({
    cmd: [open, "-g", url],
    env: process.env,
    stdio: ["ignore", "ignore", "inherit"],
  });
  return child.exitCode;
}

// What a shell exits with for a command it could not find.
const NOT_FOUND = 127;
