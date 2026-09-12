import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findOpenTodo, markerQuery, thingsDatabase, thingsUrl } from "#jobs/things";

let sandbox: string;
const database = process.env.THINGS_DATABASE;

// The columns of Things' own TMTask that the read depends on. A schema change
// upstream shows up as this fixture disagreeing with the query.
const SCHEMA =
  "create table TMTask (uuid text, title text, notes text," +
  " status integer, trashed integer, type integer, creationDate real)";

interface Row {
  uuid: string;
  notes: string;
  status?: number;
  trashed?: number;
  type?: number;
}

function makeDatabase(rows: Row[]): string {
  const path = join(sandbox, `things-${rows.length}-${Math.random()}.sqlite`);
  const db = new Database(path, { create: true });
  db.run(SCHEMA);
  for (const [index, row] of rows.entries()) {
    db.run("insert into TMTask values (?, ?, ?, ?, ?, ?, ?)", [
      row.uuid,
      "Dotfiles sync failed",
      row.notes,
      row.status ?? 0,
      row.trashed ?? 0,
      row.type ?? 0,
      index,
    ]);
  }
  db.close();
  return path;
}

const MARKER = "dotfiles-job a1b2c3d4/dotfiles-sync/9f8e7d6c5b4a";

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "jobs-things-"));
});

afterEach(() => {
  if (database === undefined) delete process.env.THINGS_DATABASE;
  else process.env.THINGS_DATABASE = database;
  rmSync(sandbox, { recursive: true, force: true });
});

describe("findOpenTodo", () => {
  function find(rows: Row[]): ReturnType<typeof findOpenTodo> {
    process.env.THINGS_DATABASE = makeDatabase(rows);
    return findOpenTodo(markerQuery(MARKER));
  }

  test("finds the open to-do carrying the marker, and how much note it has spent", () => {
    const notes = `- **Machine:** Studio\n\n\`${MARKER}\``;
    expect(find([{ uuid: "abc", notes }])).toEqual({
      readable: true,
      todo: { id: "abc", notesLength: notes.length },
    });
  });

  test("ignores a to-do carrying a different marker", () => {
    const rows = [{ uuid: "abc", notes: "dotfiles-job a1b2c3d4/dotfiles-sync/other" }];
    expect(find(rows)).toEqual({ readable: true, todo: undefined });
  });

  // Finishing the to-do is how Ben says he dealt with the cause, so its return
  // afterwards is news and files again rather than reopening what he closed.
  test.each([
    { name: "completed", row: { status: 3 } },
    { name: "canceled", row: { status: 2 } },
    { name: "trashed", row: { trashed: 1 } },
    { name: "a project rather than a to-do", row: { type: 1 } },
  ])("passes over $name", ({ row }) => {
    expect(find([{ uuid: "abc", notes: MARKER, ...row }])).toEqual({
      readable: true,
      todo: undefined,
    });
  });

  // A store that answered says the cause was dealt with. One that could not be
  // read says nothing either way, and the caller's latch decides instead.
  test("separates a store it could not read from one holding nothing", () => {
    process.env.THINGS_DATABASE = join(sandbox, "absent.sqlite");
    expect(findOpenTodo(markerQuery(MARKER))).toEqual({ readable: false });
  });
});

// A marker reaches SQLite as a LIKE pattern, where _ matches any character and %
// any run of them. Both are legal in a job name.
describe("markerQuery", () => {
  test("escapes the wildcards LIKE would otherwise read", () => {
    expect(markerQuery("a_b%c")).toBe("%a\\_b\\%c%");
  });

  test("does not match a marker that merely fits the pattern", () => {
    process.env.THINGS_DATABASE = makeDatabase([
      { uuid: "abc", notes: "dotfiles-job k/wt-prune/aaaa" },
    ]);
    expect(findOpenTodo(markerQuery("dotfiles-job k/wt_prune/aaaa"))).toEqual({
      readable: true,
      todo: undefined,
    });
  });
});

describe("thingsDatabase", () => {
  test("takes the override when one is set", () => {
    process.env.THINGS_DATABASE = "/somewhere/main.sqlite";
    expect(thingsDatabase()).toBe("/somewhere/main.sqlite");
  });
});

describe("thingsUrl", () => {
  test("percent-encodes every field, so no value can split the URL apart", () => {
    expect(thingsUrl("add", { title: "a&b=c", notes: "100%" })).toBe(
      "things:///add?title=a%26b%3Dc&notes=100%25",
    );
  });

  // encodeURIComponent spares !'()*, which the unreserved set does not.
  test("encodes the characters encodeURIComponent leaves behind", () => {
    expect(thingsUrl("add", { title: "a!'()*" })).toBe("things:///add?title=a%21%27%28%29%2A");
  });

  test("leaves out a field with nothing in it", () => {
    expect(thingsUrl("update", { id: "abc", title: "" })).toBe("things:///update?id=abc");
  });
});
