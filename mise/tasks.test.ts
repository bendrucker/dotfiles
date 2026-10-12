import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "#harness";

// A script mise has no task for never runs, and nothing says so. Each
// <topic>/install.sh and <topic>/reload.sh is tied to the task that runs it.
const scripts = Bun.spawnSync(["git", "ls-files", "*/install.sh", "*/reload.sh"], { cwd: repoRoot })
  .stdout.toString()
  .split("\n")
  .filter(Boolean);

function tasks(topic: string): Record<string, Record<string, unknown>> {
  const path = join(repoRoot, topic, "mise.toml");
  if (!existsSync(path)) return {};
  const parsed: unknown = Bun.TOML.parse(readFileSync(path, "utf8"));
  const table = typeof parsed === "object" && parsed !== null && "tasks" in parsed ? parsed.tasks : undefined;
  return typeof table === "object" && table !== null ? (table as Record<string, Record<string, unknown>>) : {};
}

describe("topic tasks", () => {
  test.each(scripts)("%s sits in a topic directory and is executable", (script) => {
    expect(script.split("/")).toHaveLength(2);
    expect(statSync(join(repoRoot, script)).mode & 0o100).toBe(0o100);
  });

  // mise/install.sh is sourced by scripts/install ahead of every task.
  test.each(scripts.filter((script) => script !== "mise/install.sh"))("%s has a task that runs it", (script) => {
    const [topic, file] = script.split("/");
    const task = tasks(topic ?? "")[`${topic}:${file?.replace(/\.sh$/, "")}`];
    expect(task).toMatchObject({ run: `./${script}`, dir: "{{config_root}}/.." });
    if (file === "reload.sh") expect(task).toMatchObject({ timeout: "60s" });
  });

  const topics = readdirSync(repoRoot).filter((topic) => existsSync(join(repoRoot, topic, "mise.toml")));
  const runs = topics.flatMap((topic) => Object.entries(tasks(topic)).map(([name, task]) => [name, task.run] as const));

  test.each(runs.filter(([, run]) => typeof run === "string" && run.startsWith("./")))("%s runs %s, which exists", (_, run) => {
    expect(existsSync(join(repoRoot, String(run)))).toBe(true);
  });
});
