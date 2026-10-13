import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { must, repoRoot, sandbox, type Sandbox } from "#harness";

let box: Sandbox;
let confd: string;

// A home of its own, entered as the working directory: mise also reads the
// config directories of every ancestor of the one it runs in.
beforeEach(() => {
  box = sandbox("mise-confd");
  confd = join(box.mkdir("home", ".config", "mise"), "conf.d");
  symlinkSync(repoRoot, confd);
});

afterEach(() => {
  box.remove();
});

function mise(...args: string[]): string {
  return inHome(["mise", ...args]);
}

function inHome(cmd: string[]): string {
  const home = box.path("home");
  return must(cmd, {
    cwd: home,
    env: {
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      XDG_STATE_HOME: join(home, ".local", "state"),
      XDG_CACHE_HOME: join(home, ".cache"),
      MISE_GLOBAL_CONFIG_FILE: undefined,
      MISE_ENV: undefined,
      // The fixture has no tools installed, and listing tasks would fetch them.
      MISE_OFFLINE: "1",
    },
  });
}

describe("mise conf.d linked to the dotfiles root", () => {
  test("loads every topic's mise.toml", () => {
    const topics = readdirSync(repoRoot).filter((topic) => existsSync(join(repoRoot, topic, "mise.toml")));
    const loaded = mise("config", "ls", "--no-header")
      .split("\n")
      .map((line) => line.split(/\s+/)[0]?.split("/conf.d/")[1]);

    expect(loaded).toEqual(expect.arrayContaining(topics.map((topic) => `${topic}/mise.toml`)));
  });

  test("loads a topic's mise.<env>.toml only while <env> is selected", () => {
    box.write("other/probe/mise.probe.toml", '[env]\nDOTFILES_MODULE_PROBE = "on"\n');
    unlinkSync(confd);
    symlinkSync(box.path("other"), confd);

    expect(mise("env")).not.toContain("DOTFILES_MODULE_PROBE");
    expect(mise("--env", "probe", "env")).toContain("export DOTFILES_MODULE_PROBE=on");
  });

  test("follows the link to another root with no reapply", () => {
    box.write("other/probe/mise.toml", '[env]\nDOTFILES_ROOT_PROBE = "other"\n');
    expect(mise("env")).not.toContain("DOTFILES_ROOT_PROBE");

    unlinkSync(confd);
    symlinkSync(box.path("other"), confd);

    expect(mise("env")).toContain("export DOTFILES_ROOT_PROBE=other");
  });
});

describe("[dotfiles]", () => {
  test("lays every declared file, linking through conf.d", () => {
    inHome([join(repoRoot, "scripts", "install-symlinks"), repoRoot]);

    const home = box.path("home");
    const declared = statuses(JSON.parse(mise("dot", "status", "--json")));

    expect(declared.length).toBeGreaterThan(0);
    for (const { target, state, mode } of declared) {
      const path = join(home, target.replace(/^~\//, ""));
      expect({ target, state }).toEqual({ target, state: "applied" });
      if (mode === "symlink") expect(readlinkSync(path).startsWith(`${confd}/`)).toBe(true);
      expect(existsSync(path)).toBe(true);
    }
  });
});

describe("topic tasks", () => {
  test("mise lists an install or reload task for every topic script", () => {
    const listed: unknown = JSON.parse(mise("tasks", "ls", "--json"));
    const names = (Array.isArray(listed) ? listed : []).flatMap((task: unknown) =>
      typeof task === "object" && task !== null && "name" in task && typeof task.name === "string" ? [task.name] : [],
    );
    const scripts = must(["git", "ls-files", "*/install.sh", "*/reload.sh"], { cwd: repoRoot })
      .split("\n")
      .filter((script) => script !== "" && script !== "mise/install.sh");

    expect(names).toEqual(expect.arrayContaining(scripts.map((script) => script.replace(/\/(install|reload)\.sh$/, ":$1"))));
  });
});

interface Status {
  target: string;
  state: string;
  mode: string;
}

// The root package carries no zod, and this reads three string fields.
function statuses(json: unknown): Status[] {
  const files = typeof json === "object" && json !== null && "files" in json ? json.files : undefined;
  if (!Array.isArray(files)) throw new Error("mise dot status --json printed no files array");
  return files.map((file: unknown) => {
    if (typeof file !== "object" || file === null) throw new Error(`unexpected entry ${JSON.stringify(file)}`);
    const { target, state, mode } = file as Record<string, unknown>;
    if (typeof target !== "string" || typeof state !== "string" || typeof mode !== "string") throw new Error(`unexpected entry ${JSON.stringify(file)}`);
    return { target, state, mode };
  });
}
