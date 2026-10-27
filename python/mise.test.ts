import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { quote, repoRoot, sandbox, shell, type Sandbox } from "#harness";

const config = join(repoRoot, "python", "mise.toml");

function uvDefault(): string {
  const parsed: unknown = Bun.TOML.parse(readFileSync(config, "utf8"));
  if (typeof parsed === "object" && parsed !== null && "vars" in parsed) {
    const vars: unknown = parsed.vars;
    if (typeof vars === "object" && vars !== null && "uv_default" in vars && typeof vars.uv_default === "string") {
      return vars.uv_default;
    }
  }
  throw new Error(`${config}: no vars.uv_default`);
}

let box: Sandbox;

beforeEach(() => {
  box = sandbox("python-uv");
});

afterEach(() => {
  box.remove();
});

// The uv version the template renders in `dir`, with only `python/mise.toml`
// loaded. A spawn cannot start in a missing directory, so the shell enters
// `dir` and removes it before mise runs.
function uvIn(dir: string, deleted: boolean): string {
  const home = box.mkdir("home");
  const enter = `cd ${quote(dir)}${deleted ? ` && rmdir ${quote(dir)}` : ""}`;
  const result = shell(`${enter} && exec mise current uv`, {
    env: {
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      XDG_STATE_HOME: join(home, ".local", "state"),
      XDG_CACHE_HOME: join(home, ".cache"),
      MISE_DATA_DIR: undefined,
      MISE_CONFIG_DIR: box.mkdir("config"),
      MISE_GLOBAL_CONFIG_FILE: config,
      MISE_ENV: undefined,
      MISE_OFFLINE: "1",
    },
  });
  if (result.status !== 0) throw new Error(`mise current uv exited ${result.status}: ${result.stderr}`);
  return result.stdout.trim();
}

test.each<{ name: string; pyproject?: string[]; deleted?: boolean; expected: string }>([
  {
    name: "follows an exact pin in an ancestor pyproject.toml",
    pyproject: ["[project]", 'name = "probe"', "", "[tool.uv]", 'required-version = "==0.9.1"'],
    expected: "0.9.1",
  },
  {
    name: "falls back for a range specifier",
    pyproject: ["[tool.uv]", 'required-version = ">=0.9"'],
    expected: uvDefault(),
  },
  { name: "falls back outside any project", expected: uvDefault() },
  // mise leaves `cwd` undefined in a deleted working directory, and the
  // template's `split` failed on it.
  { name: "falls back in a deleted working directory", deleted: true, expected: uvDefault() },
])("uv $name", ({ pyproject, deleted = false, expected }) => {
  if (pyproject) box.write("project/pyproject.toml", `${pyproject.join("\n")}\n`);
  expect(uvIn(box.mkdir("project", "src"), deleted)).toBe(expected);
});
