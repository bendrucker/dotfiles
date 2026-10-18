import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readlinkSync, symlinkSync } from "node:fs";
import { sandbox, type Sandbox } from "#harness";
import type { Context } from "#migrations/migration";
import { up } from "./202610180002-session-index-out-of-claude";

let box: Sandbox;
let logged: string[];

beforeEach(() => {
  box = sandbox("session-index-out-of-claude");
  logged = [];
});

afterEach(() => {
  box.remove();
});

function context(): Context {
  return {
    root: box.dir,
    home: box.mkdir("home"),
    config: box.path("home", ".config"),
    data: box.path("home", ".local", "share"),
    applications: box.mkdir("Applications"),
    installed: [box.mkdir("installed")],
    platform: "darwin",
    out: {
      write() {},
      run(cmd) {
        if (cmd[0] === "gum") logged.push(cmd.slice(1).join(" "));
        return 0;
      },
      read: () => ({ status: 1, stdout: "" }),
    },
  };
}

const source = "home/.claude/plugins/data/observability-bendrucker";

describe("session-index-out-of-claude", () => {
  test("moves the index and links its old path to it", () => {
    const ctx = context();
    box.write(`${source}/session.duckdb`, "db");

    up(ctx);

    expect(readlinkSync(box.path(source))).toBe(box.path("home/.local/share/session-index"));
    expect(box.read("home/.local/share/session-index/session.duckdb")).toBe("db");
    expect(box.read(`${source}/session.duckdb`)).toBe("db");
  });

  test("a machine already linked is untouched", () => {
    const ctx = context();
    const target = box.mkdir("home", ".local", "share", "session-index");
    box.mkdir("home", ".claude", "plugins", "data");
    symlinkSync(target, box.path(source));

    up(ctx);

    expect(readlinkSync(box.path(source))).toBe(target);
    expect(logged).toEqual([]);
  });

  test("leaves both in place and says so when both exist", () => {
    const ctx = context();
    box.write(`${source}/session.duckdb`, "old");
    box.write("home/.local/share/session-index/session.duckdb", "new");

    up(ctx);

    expect(box.read(`${source}/session.duckdb`)).toBe("old");
    expect(box.read("home/.local/share/session-index/session.duckdb")).toBe("new");
    expect(logged.join("\n")).toContain("both exist");
  });
});
