import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run as spawn, sandbox, type Sandbox, stubGum } from "#harness";

const SCRIPT = join(import.meta.dir, "dotfiles-migrate");

let box: Sandbox;
let home: string;
let installed: string;
let root: string;

beforeEach(() => {
  box = sandbox("dotfiles-migrate");
  home = box.mkdir("home");
  installed = box.mkdir("installed");
  root = box.mkdir("root");
  box.mkdir("root", "migrations");
  stubGum(box);
});

afterEach(() => {
  box.remove();
});

// A migration recording that it ran. It imports nothing from this repo: the
// sandbox has no package.json above it, so the # specifiers a real migration
// uses would not resolve out here.
function migration(name: string, body = "") {
  writeFileSync(
    join(root, "migrations", `${name}.ts`),
    [
      `import { appendFileSync } from "node:fs";`,
      `export function up() {`,
      `  appendFileSync(${JSON.stringify(box.path("ran"))}, ${JSON.stringify(`${name}\n`)});`,
      `  ${body}`,
      `}`,
    ].join("\n"),
  );
}

function markInstalled(): void {
  box.mkdir("installed", "zsh");
  writeFileSync(join(installed, "zsh", ".zshenv"), "");
  symlinkSync(join(installed, "zsh", ".zshenv"), join(home, ".zshenv"));
}

// Every directory the script reads comes from the environment, so nothing here
// reaches the real machine's XDG paths.
function migrate(tree = root) {
  return spawn([process.execPath, SCRIPT, tree], {
    path: [box.bin],
    env: {
      HOME: home,
      DOTFILES_HOME: installed,
      XDG_STATE_HOME: box.path("home", ".local", "state"),
      XDG_CONFIG_HOME: box.path("home", ".config"),
      XDG_DATA_HOME: box.path("home", ".local", "share"),
    },
  });
}

function stamped(): string {
  return box.read(join("home", ".local", "state", "dotfiles", "migration-version")).trim();
}

function ran(): string[] {
  return box
    .read("ran")
    .split("\n")
    .filter((line) => line !== "");
}

describe("dotfiles-migrate", () => {
  test("a fresh machine stamps the latest version and runs nothing", () => {
    migration("202601010001-first");

    const result = migrate();
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("fresh machine");
    expect(ran()).toEqual([]);
    expect(stamped()).toBe("202601010001");
  });

  test("a machine this repo has been installed on runs what is pending", () => {
    markInstalled();
    migration("202601010001-first");
    migration("202601010002-second");

    expect(migrate().status).toBe(0);
    expect(ran()).toEqual(["202601010001-first", "202601010002-second"]);
    expect(stamped()).toBe("202601010002");
  });

  test("a second run does nothing", () => {
    markInstalled();
    migration("202601010001-first");

    expect(migrate().status).toBe(0);
    expect(migrate().status).toBe(0);
    expect(ran()).toEqual(["202601010001-first"]);
  });

  test("a failing migration exits nonzero and leaves the stamp behind it", () => {
    markInstalled();
    migration("202601010001-first");
    migration("202601010002-broken", "throw new Error('nope');");

    const result = migrate();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("migration 202601010002 broken failed: nope");
    expect(stamped()).toBe("202601010001");
  });

  test("a tree with no migrations directory is a clean run", () => {
    markInstalled();
    expect(migrate(box.mkdir("empty")).status).toBe(0);
  });
});
