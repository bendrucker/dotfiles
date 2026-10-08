import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { must, run, sandbox, stubGum, type Sandbox } from "#harness";
import type { Capture } from "#jobs/output";
import { adoptReplacedSettings, relinkClaudeHome } from "./settings-link";

const FILE = "user/settings.json";

let box: Sandbox;
let repo: string;
let out: Capture;
const environment = { HOME: process.env.HOME, PATH: process.env.PATH };

function recording(): Capture {
  const chunks: string[] = [];
  return {
    write(_fd, text) {
      chunks.push(text);
    },
    run(cmd, options) {
      const result = run(cmd, { env: options?.env, cwd: options?.cwd });
      chunks.push(result.stdout, result.stderr);
      return result.status;
    },
    read(cmd, options) {
      const result = run(cmd, { env: options?.env, cwd: options?.cwd });
      chunks.push(result.stderr);
      return { status: result.status, stdout: result.stdout };
    },
    captured() {
      return chunks.join("");
    },
  };
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
  must(["git", "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-qm", "init"], { cwd: repo });

  box.mkdir(".claude");
  symlinkSync(join(repo, FILE), settingsLink());
  out = recording();
});

afterEach(() => {
  process.env.HOME = environment.HOME;
  process.env.PATH = environment.PATH;
  box.remove();
});

describe("relinkClaudeHome", () => {
  test("relinks a file that replaced its link and names it", () => {
    replaceLink({ replaced: 1 });

    expect(relinkClaudeHome(out, repo)).toBe(true);
    expect(out.captured()).toContain("Relinked ~/.claude/settings.json");
    expect(linked()).toBe(true);
  });

  test("links what the repo holds and stays quiet about links already there", () => {
    writeFileSync(join(repo, "user", "CLAUDE.md"), "# Claude\n");

    expect(relinkClaudeHome(out, repo)).toBe(true);
    expect(lstatSync(box.path(".claude", "CLAUDE.md")).isSymbolicLink()).toBe(true);
    expect(out.captured()).not.toContain("Relinked");
  });

  test("fails when a directory sits where a link belongs", () => {
    rmSync(settingsLink());
    mkdirSync(settingsLink());

    expect(relinkClaudeHome(out, repo)).toBe(false);
    expect(out.captured()).toContain("Could not relink ~/.claude");
  });
});

describe("adoptReplacedSettings", () => {
  test("carries a replaced file's change into the working copy", () => {
    replaceLink(settings("changed"));
    adoptReplacedSettings(out, repo);

    expect(git("diff", "--", FILE)).toContain("changed");
  });

  test("leaves the working copy alone when the replacement changed nothing", () => {
    replaceLink(settings("bar"));
    adoptReplacedSettings(out, repo);

    expect(settingsStatus()).toBe("clean");
    expect(out.captured()).toBe("");
  });

  test("leaves the working copy alone while the link is intact", () => {
    writeRepoSettings(settings("local"));
    adoptReplacedSettings(out, repo);

    expect(git("diff", "--", FILE)).toContain("local");
    expect(out.captured()).toBe("");
  });

  test("does not overwrite a working copy that already has local changes", () => {
    writeRepoSettings(settings("local"));
    replaceLink(settings("replaced"));
    adoptReplacedSettings(out, repo);

    expect(git("diff", "--", FILE)).toContain("local");
    expect(out.captured()).toContain("already has local changes");
  });

  test("discards a replacement that is not JSON", () => {
    replaceLink(settings("replaced"));
    writeFileSync(settingsLink(), "{ truncated");
    adoptReplacedSettings(out, repo);

    expect(settingsStatus()).toBe("clean");
    expect(out.captured()).toContain("not readable JSON");
  });

  test("does not overwrite a working copy git cannot read the status of", () => {
    writeRepoSettings(settings("local"));
    replaceLink(settings("replaced"));
    writeFileSync(join(repo, ".git", "index"), "corrupt");
    adoptReplacedSettings(out, repo);

    expect(readFileSync(join(repo, FILE), "utf8")).toContain("local");
  });

  test("reports a working copy it cannot write", () => {
    replaceLink(settings("replaced"));
    rmSync(join(repo, FILE));
    mkdirSync(join(repo, FILE));
    must(["git", "update-index", "--assume-unchanged", FILE], { cwd: repo });
    adoptReplacedSettings(out, repo);

    expect(out.captured()).toContain(`Could not write ${FILE}`);
  });
});
