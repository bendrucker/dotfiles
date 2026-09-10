import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sandbox, type Sandbox } from "#harness";
import type { Context, Platform } from "#migrations/migration";
import {
  devRoot,
  discover,
  load,
  latestVersion,
  previouslyInstalled,
  readVersion,
  run,
  stampVersion,
} from "#migrations/runner";

let box: Sandbox;
let home: string;
let installed: string;

beforeEach(() => {
  box = sandbox("migration-runner");
  home = box.mkdir("home");
  installed = box.mkdir("installed");
});

afterEach(() => {
  box.remove();
});

// A migration whose up() appends to a file the case reads back. It cannot share
// a variable with the case: the runner imports it, so it runs as its own module.
function migration(name: string, body = ""): void {
  const path = join(box.mkdir("root", "migrations"), `${name}.ts`);
  writeFileSync(
    path,
    [
      `import { appendFileSync } from "node:fs";`,
      body,
      `export function up() {`,
      `  appendFileSync(${JSON.stringify(join(box.dir, "ran"))}, ${JSON.stringify(`${name}\n`)});`,
      `  ${body === "" ? "" : "fail();"}`,
      `}`,
    ].join("\n"),
  );
}

function root(): string {
  return box.path("root");
}

// The runner logs through gum, and nothing here asserts on what it said.
function context(platform: Platform = "darwin"): Context {
  return {
    root: root(),
    home,
    config: join(home, ".config"),
    data: join(home, ".local", "share"),
    applications: join(box.dir, "Applications"),
    installed: [installed],
    platform,
    out: { write() {}, run: () => 0, read: () => ({ status: 0, stdout: "" }) },
  };
}

function ranMigrations(): string[] {
  return box
    .read("ran")
    .split("\n")
    .filter((line) => line !== "");
}

// Inside the sandbox rather than wherever this machine's XDG_STATE_HOME points.
function version(): string {
  return box.path("state", "migration-version");
}

function stamped(): string {
  return box.read(join("state", "migration-version")).trim();
}

// The link that says scripts/install has run here before.
function markInstalled(): void {
  box.mkdir("installed", "zsh");
  writeFileSync(join(installed, "zsh", ".zshenv"), "");
  symlinkSync(join(installed, "zsh", ".zshenv"), join(home, ".zshenv"));
}

async function migrate(platform: Platform = "darwin"): Promise<number> {
  return run({ root: root(), version: version(), context: context(platform) });
}

describe("discover", () => {
  test("orders by version and reads the name from the filename", () => {
    box.mkdir("root", "migrations");
    for (const name of ["202601010002-second.ts", "202601010001-first.ts"]) {
      writeFileSync(join(root(), "migrations", name), "export function up() {}\n");
    }

    expect(discover(root()).map((found) => [found.version, found.name])).toEqual([
      [202601010001, "first"],
      [202601010002, "second"],
    ]);
  });

  test("refuses two migrations sharing a version, which one stamp cannot record", () => {
    box.mkdir("root", "migrations");
    for (const name of ["202601010001-first.ts", "202601010001-other.ts"]) {
      writeFileSync(join(root(), "migrations", name), "export function up() {}\n");
    }

    expect(() => discover(root())).toThrow(/share version 202601010001/);
  });

  test("skips the test file sitting beside a migration", () => {
    box.mkdir("root", "migrations");
    writeFileSync(join(root(), "migrations", "202601010001-first.ts"), "export function up() {}\n");
    writeFileSync(join(root(), "migrations", "202601010001-first.test.ts"), "");
    writeFileSync(join(root(), "migrations", "README.md"), "");

    expect(discover(root()).map((found) => found.name)).toEqual(["first"]);
  });

  test("a tree with no migrations directory has no migrations", () => {
    expect(discover(box.path("nowhere"))).toEqual([]);
    expect(latestVersion([])).toBe(0);
  });
});

describe("readVersion", () => {
  test("absent is not zero, because nobody has asked this machine yet", () => {
    expect(readVersion(box.path("missing"))).toBeUndefined();
  });

  test("reads the recorded version", () => {
    expect(readVersion(box.write("version", "202601010001\n"))).toBe(202601010001);
  });

  test("a stamp nothing can read stops the run rather than being guessed at", () => {
    expect(() => readVersion(box.write("bad", "yesterday\n"))).toThrow(/unreadable/);
  });
});

describe("stampVersion", () => {
  test("never moves backwards, so deleting the newest migration un-runs nothing", () => {
    const path = box.path("state", "version");
    stampVersion(path, 202601010002, undefined);
    stampVersion(path, 202601010001, 202601010002);
    expect(readVersion(path)).toBe(202601010002);
  });
});

describe("errors the readers cannot suppress", () => {
  test("a migrations directory that exists and cannot be read", () => {
    const dir = box.mkdir("root", "migrations");
    chmodSync(dir, 0o000);
    try {
      expect(() => discover(root())).toThrow();
    } finally {
      chmodSync(dir, 0o755);
    }
  });

  test("a blank stamp is unreadable rather than zero", () => {
    box.mkdir("state");
    const file = box.path("state", "migration-version");
    writeFileSync(file, "");
    expect(() => readVersion(file)).toThrow(/unreadable/);

    writeFileSync(file, "  \n");
    expect(() => readVersion(file)).toThrow(/unreadable/);
  });

  test("a home directory that exists and cannot be read is not a fresh machine", () => {
    chmodSync(home, 0o000);
    try {
      expect(() => previouslyInstalled(home, join(home, ".config"), [installed])).toThrow();
    } finally {
      chmodSync(home, 0o755);
    }
  });

  test("a stamp that exists and cannot be read is not an absent stamp", () => {
    const file = box.path("state", "migration-version");
    box.mkdir("state");
    writeFileSync(file, "1\n");
    chmodSync(file, 0o000);
    try {
      expect(() => readVersion(file)).toThrow();
    } finally {
      chmodSync(file, 0o644);
    }
  });

  test("run reports an unwritable state directory rather than crashing", async () => {
    markInstalled();
    migration("202601010001-first");
    const state = box.mkdir("state");
    chmodSync(state, 0o500);
    try {
      expect(await migrate()).toBe(1);
    } finally {
      chmodSync(state, 0o755);
    }
  });

  test("run reports an unreadable migrations directory rather than stamping past it", async () => {
    markInstalled();
    const dir = box.mkdir("root", "migrations");
    chmodSync(dir, 0o000);
    try {
      expect(await migrate()).toBe(1);
    } finally {
      chmodSync(dir, 0o755);
    }
    expect(existsSync(version())).toBe(false);
  });
});

describe("previouslyInstalled", () => {
  test("a link into the installed tree says scripts/install has run here", () => {
    markInstalled();
    expect(previouslyInstalled(home, join(home, ".config"), [installed])).toBe(true);
  });

  test("a fresh home carries none", () => {
    expect(previouslyInstalled(home, join(home, ".config"), [installed])).toBe(false);
  });

  test("a link to the tree's own root does not count, since bootstrap makes it first", () => {
    symlinkSync(installed, join(home, ".dotfiles"));
    expect(previouslyInstalled(home, join(home, ".config"), [installed])).toBe(false);
  });

  test("a link into any candidate tree counts, which is what covers dev mode", () => {
    const dev = box.mkdir("dev", "zsh");
    writeFileSync(join(dev, ".zshenv"), "");
    symlinkSync(join(dev, ".zshenv"), join(home, ".zshenv"));

    expect(previouslyInstalled(home, join(home, ".config"), [installed])).toBe(false);
    expect(previouslyInstalled(home, join(home, ".config"), [installed, box.path("dev")])).toBe(true);
  });

  test("a link under XDG_CONFIG_HOME counts too", () => {
    const config = box.mkdir("home", ".config");
    box.mkdir("installed", "bat");
    writeFileSync(join(installed, "bat", "config"), "");
    symlinkSync(join(installed, "bat", "config"), join(config, "bat"));
    expect(previouslyInstalled(home, config, [installed])).toBe(true);
  });
});

describe("devRoot", () => {
  test("reads the tree dotfiles dev enable recorded", () => {
    writeFileSync(join(home, ".dotfiles-dev-mode"), `${box.path("dev")}\n`);
    expect(devRoot(home)).toBe(box.path("dev"));
  });

  test("a machine not in dev mode has none", () => {
    expect(devRoot(home)).toBeUndefined();
  });

  test("an empty flag file is not a root", () => {
    writeFileSync(join(home, ".dotfiles-dev-mode"), "\n");
    expect(devRoot(home)).toBeUndefined();
  });
});

describe("load", () => {
  test("refuses a platform that is neither of the two, which would be stamped past everywhere", async () => {
    box.mkdir("root", "migrations");
    const file = join(root(), "migrations", "202601010001-typo.ts");
    writeFileSync(file, 'export function up() {}\nexport const platform = "macos";\n');

    const entry = discover(root())[0];
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    expect(load(entry)).rejects.toThrow(/not one of darwin, linux/);
  });
});

describe("run", () => {
  test("a fresh machine stamps the latest version and runs nothing", async () => {
    migration("202601010001-first");
    migration("202601010002-second");

    expect(await migrate()).toBe(0);
    expect(ranMigrations()).toEqual([]);
    expect(stamped()).toBe("202601010002");
  });

  test("a machine installed before the runner shipped runs everything pending", async () => {
    markInstalled();
    migration("202601010001-first");
    migration("202601010002-second");

    expect(await migrate()).toBe(0);
    expect(ranMigrations()).toEqual(["202601010001-first", "202601010002-second"]);
    expect(stamped()).toBe("202601010002");
  });

  test("a stamped machine runs only what came after its stamp", async () => {
    migration("202601010001-first");
    migration("202601010002-second");
    stampVersion(version(), 202601010001, undefined);

    expect(await migrate()).toBe(0);
    expect(ranMigrations()).toEqual(["202601010002-second"]);
    expect(stamped()).toBe("202601010002");
  });

  test("running again does nothing", async () => {
    markInstalled();
    migration("202601010001-first");

    expect(await migrate()).toBe(0);
    expect(await migrate()).toBe(0);
    expect(ranMigrations()).toEqual(["202601010001-first"]);
  });

  test("a migration for another platform is stamped rather than reconsidered forever", async () => {
    markInstalled();
    box.mkdir("root", "migrations");
    writeFileSync(
      join(root(), "migrations", "202601010001-mac-only.ts"),
      ["export const platform = 'darwin';", "export function up() { throw new Error('ran'); }"].join("\n"),
    );

    expect(await migrate("linux")).toBe(0);
    expect(stamped()).toBe("202601010001");
  });

  test("a failure keeps the stamp where it was and stops before the rest", async () => {
    markInstalled();
    migration("202601010001-first");
    migration("202601010002-broken", "function fail(): void { throw new Error('nope'); }");
    migration("202601010003-third");

    expect(await migrate()).toBe(1);
    expect(ranMigrations()).toEqual(["202601010001-first", "202601010002-broken"]);
    // The one that finished is recorded and the one that broke is not, so the
    // next install retries the failure and the one behind it.
    expect(stamped()).toBe("202601010001");
  });

  test("a retry starts at the migration that failed, not at the beginning", async () => {
    markInstalled();
    migration("202601010001-first");
    migration("202601010002-broken", "function fail(): void { throw new Error('nope'); }");

    expect(await migrate()).toBe(1);
    expect(await migrate()).toBe(1);
    expect(ranMigrations()).toEqual([
      "202601010001-first",
      "202601010002-broken",
      "202601010002-broken",
    ]);
  });

  test("a migration exporting no up() fails rather than being counted as done", async () => {
    markInstalled();
    box.mkdir("root", "migrations");
    writeFileSync(join(root(), "migrations", "202601010001-empty.ts"), "export const platform = 'darwin';\n");

    expect(await migrate()).toBe(1);
    expect(stamped()).toBe("");
  });

  test("an unreadable stamp stops the run rather than re-running everything", async () => {
    markInstalled();
    migration("202601010001-first");
    box.write(join("state", "migration-version"), "corrupt\n");

    expect(await migrate()).toBe(1);
    expect(ranMigrations()).toEqual([]);
  });
});
