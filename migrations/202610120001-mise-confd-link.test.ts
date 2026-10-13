import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, readdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { sandbox, type Sandbox } from "#harness";
import type { Context } from "#migrations/migration";
import { up } from "./202610120001-mise-confd-link";

let box: Sandbox;
let confd: string;
let logged: string;

beforeEach(() => {
  box = sandbox("mise-confd-link");
  box.mkdir("installed", "go");
  box.write("installed/go/mise.toml", "");
  confd = box.mkdir("home", ".config", "mise", "conf.d");
  logged = "";
});

afterEach(() => {
  box.remove();
});

function context(): Context {
  return {
    root: box.dir,
    home: box.path("home"),
    config: box.path("home", ".config"),
    data: box.path("home", ".local", "share"),
    applications: box.path("Applications"),
    installed: [box.path("installed")],
    platform: "darwin",
    out: {
      write() {},
      run(cmd) {
        logged += cmd.join(" ");
        return 0;
      },
      read: () => ({ status: 0, stdout: "" }),
    },
  };
}

describe("mise-confd-link", () => {
  test("removes a directory holding only this repo's fragment links", () => {
    symlinkSync(box.path("installed", "go", "mise.toml"), join(confd, "go.toml"));

    up(context());

    expect(existsSync(confd)).toBe(false);
  });

  test("moves a directory holding foreign config aside, without the repo's links", () => {
    symlinkSync(box.path("installed", "go", "mise.toml"), join(confd, "go.toml"));
    box.write("home/.config/mise/conf.d/work.toml", "");

    up(context());

    expect(existsSync(confd)).toBe(false);
    expect(readdirSync(`${confd}.pre-link`)).toEqual(["work.toml"]);
    expect(logged).toContain(".pre-link");
  });

  test("keeps an earlier backup", () => {
    box.write("home/.config/mise/conf.d/work.toml", "");
    box.write("home/.config/mise/conf.d.pre-link/earlier.toml", "");

    up(context());

    expect(readdirSync(`${confd}.pre-link`)).toEqual(["earlier.toml"]);
    const moved = readdirSync(box.path("home", ".config", "mise")).filter((name) => name.startsWith("conf.d.pre-link-"));
    expect(moved.map((name) => readdirSync(box.path("home", ".config", "mise", name)))).toEqual([["work.toml"]]);
  });

  test("leaves conf.d alone once it is a link", () => {
    box.remove();
    box = sandbox("mise-confd-link");
    box.mkdir("home", ".config", "mise");
    confd = box.path("home", ".config", "mise", "conf.d");
    symlinkSync(box.mkdir("installed"), confd);

    up(context());

    expect(lstatSync(confd).isSymbolicLink()).toBe(true);
  });

  test("does nothing where conf.d is absent", () => {
    box.remove();
    box = sandbox("mise-confd-link");

    up(context());

    expect(existsSync(box.path("home"))).toBe(false);
  });
});
