import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { must, run, sandbox, stubGum, type Sandbox } from "#harness";
import { call } from "#harness/call";

const FILE = "user/settings.json";

let box: Sandbox;
let repo: string;
let output: string;
const environment = { HOME: process.env.HOME, PATH: process.env.PATH };

const MODULE = join(import.meta.dir, "settings-link.ts");

// Called in a child bun, since what Bun Shell writes never reaches this process's spies.
async function relink(): Promise<boolean> {
  const called = await call<boolean>(MODULE, "relinkClaudeHome", [repo]);
  output = called.output;
  return called.value;
}

async function adopt(): Promise<void> {
  output = (await call<null>(MODULE, "adoptReplacedSettings", [repo])).output;
}

function settings(example: string): unknown {
  return { env: { EXAMPLE: example }, enabledPlugins: { "alpha@first": true } };
}

function settingsLink(): string {
  return box.path(".claude", "settings.json");
}

function linked(): boolean {
  return lstatSync(settingsLink()).isSymbolicLink();
}

function replaceLink(value: unknown): void {
  rmSync(settingsLink());
  writeFileSync(settingsLink(), `${JSON.stringify(value)}\n`);
}

function writeRepoSettings(value: unknown, indent = 2): void {
  writeFileSync(join(repo, FILE), `${JSON.stringify(value, null, indent)}\n`);
}

function git(...args: string[]): string {
  return run(["git", "-C", repo, ...args]).stdout;
}

function settingsStatus(): "clean" | "dirty" {
  return git("status", "--porcelain", FILE).trim() === "" ? "clean" : "dirty";
}

beforeEach(() => {
  box = sandbox("settings-link");
  stubGum(box);
  process.env.HOME = box.dir;
  process.env.PATH = `${box.bin}:${environment.PATH}`;

  repo = box.mkdir("repo");
  mkdirSync(join(repo, "user"));
  writeRepoSettings(settings("bar"));
  must(["git", "init", "-q"], { cwd: repo });
  must(["git", "add", "."], { cwd: repo });
  must(["git", "-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "-qm", "init"], { cwd: repo });

  box.mkdir(".claude");
  symlinkSync(join(repo, FILE), settingsLink());
  output = "";
});

afterEach(() => {
  process.env.HOME = environment.HOME;
  process.env.PATH = environment.PATH;
  box.remove();
});

describe("relinkClaudeHome", () => {
  test("relinks a file that replaced its link and names it", async () => {
    replaceLink({ replaced: 1 });

    expect(await relink()).toBe(true);
    expect(output).toContain("Relinked ~/.claude/settings.json");
    expect(linked()).toBe(true);
  });

  test("links what the repo holds and stays quiet about links already there", async () => {
    writeFileSync(join(repo, "user", "CLAUDE.md"), "# Claude\n");

    expect(await relink()).toBe(true);
    expect(lstatSync(box.path(".claude", "CLAUDE.md")).isSymbolicLink()).toBe(true);
    expect(output).not.toContain("Relinked");
  });

  test("fails when a directory sits where a link belongs", async () => {
    rmSync(settingsLink());
    mkdirSync(settingsLink());

    expect(await relink()).toBe(false);
    expect(output).toContain("Could not relink ~/.claude");
  });
});

describe("adoptReplacedSettings", () => {
  test("carries a replaced file's change into the working copy", async () => {
    replaceLink(settings("changed"));
    await adopt();

    expect(git("diff", "--", FILE)).toContain("changed");
  });

  test("leaves the working copy alone when the replacement changed nothing", async () => {
    replaceLink(settings("bar"));
    await adopt();

    expect(settingsStatus()).toBe("clean");
    expect(output).toBe("");
  });

  test("leaves the working copy alone where user-tier.ts generates the file", async () => {
    box.write(".claude/remote-settings.json", "{}");
    replaceLink(settings("generated"));
    await adopt();

    expect(settingsStatus()).toBe("clean");
  });

  test("leaves the working copy alone while the link is intact", async () => {
    writeRepoSettings(settings("local"));
    await adopt();

    expect(git("diff", "--", FILE)).toContain("local");
    expect(output).toBe("");
  });

  test("does not overwrite a working copy that already has local changes", async () => {
    writeRepoSettings(settings("local"));
    replaceLink(settings("replaced"));
    await adopt();

    expect(git("diff", "--", FILE)).toContain("local");
    expect(output).toContain("already has local changes");
  });

  test("discards a replacement that is not JSON", async () => {
    replaceLink(settings("replaced"));
    writeFileSync(settingsLink(), "{ truncated");
    await adopt();

    expect(settingsStatus()).toBe("clean");
    expect(output).toContain("not readable JSON");
  });

  test("does not overwrite a working copy git cannot read the status of", async () => {
    writeRepoSettings(settings("local"));
    replaceLink(settings("replaced"));
    writeFileSync(join(repo, ".git", "index"), "corrupt");
    await adopt();

    expect(readFileSync(join(repo, FILE), "utf8")).toContain("local");
  });

  test("reports a working copy it cannot write", async () => {
    replaceLink(settings("replaced"));
    rmSync(join(repo, FILE));
    mkdirSync(join(repo, FILE));
    must(["git", "update-index", "--assume-unchanged", FILE], { cwd: repo });
    await adopt();

    expect(output).toContain(`Could not write ${FILE}`);
  });
});
