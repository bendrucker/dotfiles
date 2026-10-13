import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { must, repoRoot } from "#harness";

// A script mise has no task for never runs, and nothing says so. Each
// <topic>/install.sh and <topic>/reload.sh is tied to the task that runs it.
const scripts = must(["git", "ls-files", "--cached", "--others", "--exclude-standard", "*/install.sh", "*/reload.sh"], {
  cwd: repoRoot,
})
  .split("\n")
  .filter(Boolean);

type Task = { run?: unknown; dir?: unknown; timeout?: unknown };

function isTable(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tasks(topic: string): Map<string, Task> {
  const path = join(repoRoot, topic, "mise.toml");
  const parsed: unknown = existsSync(path) ? Bun.TOML.parse(readFileSync(path, "utf8")) : {};
  const table = isTable(parsed) ? parsed.tasks : undefined;
  if (table === undefined) return new Map();
  if (!isTable(table)) throw new Error(`${topic}/mise.toml: [tasks] is not a table`);
  return new Map(Object.entries(table).map(([name, task]) => [name, isTable(task) ? task : { run: task }]));
}

const topics = readdirSync(repoRoot).filter((topic) => existsSync(join(repoRoot, topic, "mise.toml")));
const declared = new Map(topics.flatMap((topic) => [...tasks(topic)]));

describe("topic tasks", () => {
  test("finds the scripts and tasks it checks", () => {
    expect(scripts).toContain("herdr/install.sh");
    expect(declared.has("herdr:install")).toBe(true);
  });

  test.each(scripts)("%s sits in a topic directory and is executable", (script) => {
    expect(script.split("/")).toHaveLength(2);
    expect(statSync(join(repoRoot, script)).mode & 0o100).toBe(0o100);
  });

  // mise/install.sh is sourced by scripts/install ahead of every task.
  test.each(scripts.filter((script) => script !== "mise/install.sh"))("%s has a task that runs it", (script) => {
    const [topic, file] = script.split("/");
    const task = declared.get(`${topic}:${file?.replace(/\.sh$/, "")}`);
    expect(task).toMatchObject({ run: `./${script}`, dir: "{{config_root}}/.." });
  });

  // An inline reload has no script for the check above to find, and the 3am job
  // needs the cap on every one.
  const reloads = [...declared].filter(([name]) => name.endsWith(":reload"));

  test.each(reloads)("%s is capped at a minute", (_, task) => {
    expect(task).toMatchObject({ timeout: "60s" });
  });

  const local = [...declared].flatMap(([name, task]) => {
    const command = typeof task.run === "string" ? task.run.split(" ")[0] : undefined;
    return command?.startsWith("./") ? [[name, command, task] as const] : [];
  });

  test.each(local)("%s runs %s, an executable in the repo", (_, command, task) => {
    expect(task).toMatchObject({ dir: "{{config_root}}/.." });
    expect(statSync(join(repoRoot, command)).mode & 0o100).toBe(0o100);
  });
});
