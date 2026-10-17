import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { must, repoRoot, run, sandbox, stubGum, type Sandbox } from "#harness";

const script = join(repoRoot, "scripts", "brew-taps-https");

let box: Sandbox;
let env: Record<string, string>;

beforeEach(() => {
  box = sandbox("brew-taps-https");
  stubGum(box);
  box.stub("brew", `echo ${box.path("brew")}`);

  // What an org that standardizes on SSH installs. It undoes an HTTPS remote.
  const global = box.write("gitconfig", "");
  env = { GIT_CONFIG_GLOBAL: global, GIT_CONFIG_SYSTEM: "/dev/null" };
  must(["git", "config", "--file", global, "url.git@github.com:.insteadOf", "https://github.com/"]);
});

afterEach(() => {
  box.remove();
});

function clone(dir: string, url: string): string {
  must(["git", "init", "-q", dir]);
  must(["git", "-C", dir, "remote", "add", "origin", url]);
  return dir;
}

function fetchUrl(dir: string): string {
  return run(["git", "-C", dir, "ls-remote", "--get-url", "origin"], { env }).stdout.trim();
}

test("pins Homebrew and every tap past an SSH insteadOf rule", () => {
  const brew = clone(box.path("brew"), "https://github.com/Homebrew/brew");
  box.mkdir("brew", "Library", "Taps", "rjyo");
  const tap = clone(box.path("brew", "Library", "Taps", "rjyo", "homebrew-moshi"), "https://github.com/rjyo/homebrew-moshi");
  expect(fetchUrl(tap)).toBe("git@github.com:rjyo/homebrew-moshi");

  const r = run([script], { path: [box.bin], env });

  expect(r.status).toBe(0);
  expect(fetchUrl(brew)).toBe("https://github.com/Homebrew/brew");
  expect(fetchUrl(tap)).toBe("https://github.com/rjyo/homebrew-moshi");
});

test("writes nothing without an SSH insteadOf rule", () => {
  clone(box.path("brew"), "https://github.com/Homebrew/brew");
  const before = readFileSync(box.path("brew", ".git", "config"), "utf8");

  const r = run([script], { path: [box.bin], env: { ...env, GIT_CONFIG_GLOBAL: "/dev/null" } });

  expect(r.status).toBe(0);
  expect(readFileSync(box.path("brew", ".git", "config"), "utf8")).toBe(before);
});

test("skips a tap directory that is not a clone", () => {
  clone(box.path("brew"), "https://github.com/Homebrew/brew");
  box.mkdir("brew", "Library", "Taps", "someone", "homebrew-copied");

  const r = run([script], { path: [box.bin], env });

  expect(r.status).toBe(0);
});
