import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot, run } from "../scripts/lib/shell-fixtures.ts";

// Read out of the path.zsh files rather than listed here, so a topic added
// later is covered without touching this test. The set spans mise on both
// sides: herdr sorts before it, theme after.
function topicBins(): string[] {
  const topics = readdirSync(repoRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  const found = new Set<string>();
  for (const topic of topics) {
    let contents: string;
    try {
      contents = readFileSync(join(repoRoot, topic.name, "path.zsh"), "utf8");
    } catch {
      continue;
    }
    for (const match of contents.matchAll(/\$ZSH(?:\/[A-Za-z0-9_.-]+)+\/bin/g)) {
      found.add(match[0].replace("$ZSH", repoRoot));
    }
  }
  return [...found].sort();
}

// $PATH one entry per line, as a shell of the given shape built it. The shell
// writes to a file because terminal integration prefixes stdout with escapes.
//
// A shell reads its per-user .zshenv from $ZDOTDIR when that is set, so what
// the directory holds decides whether the path.zsh loop runs at all.
function pathOf(files: string[]): string[] {
  const zdotdir = mkdtempSync(join(tmpdir(), "zdotdir-"));
  const outdir = mkdtempSync(join(tmpdir(), "pathof-"));
  const out = join(outdir, "out");
  for (const file of files) {
    symlinkSync(join(repoRoot, "zsh", file), join(zdotdir, file));
  }
  run(["zsh", "-i", "-c", `print -l $path > ${out}`], {
    onlyPath: ["/usr/bin", "/bin", "/usr/sbin", "/sbin"],
    env: { ZDOTDIR: zdotdir, DOTFILES_USE_DEV: repoRoot },
    stdin: "ignore",
  });
  const built = readFileSync(out, "utf8");
  rmSync(zdotdir, { recursive: true, force: true });
  rmSync(outdir, { recursive: true, force: true });
  return built.split("\n").filter(Boolean);
}

function missingFrom(built: string[]): string[] {
  return topicBins().filter((bin) => !built.includes(bin));
}

describe("PATH", () => {
  // zsh/symlinks.conf installs only .zshrc under $ZDOTDIR, and .zshenv exports
  // ZDOTDIR, so this is every zsh below the first one: a pane, or anything a
  // long-lived server spawns. Such a shell used to keep whatever PATH its
  // parent froze, which for a server started before a topic existed never held
  // that topic's bin. PATH here arrives without any of them to stand in for
  // that.
  describe("in a shell that reads no .zshenv", () => {
    let built: string[] = [];

    beforeAll(() => {
      built = pathOf([".zshrc"]);
    });

    test("still puts every topic's bin on it", () => {
      expect(missingFrom(built)).toEqual([]);
    });

    test("still keeps the repo's own bin first", () => {
      expect(built[0]).toBe(join(repoRoot, "bin"));
    });
  });

  describe("in a shell that reads one", () => {
    let built: string[] = [];

    beforeAll(() => {
      built = pathOf([".zshenv", ".zshrc"]);
    });

    test("puts every topic's bin on it", () => {
      expect(missingFrom(built)).toEqual([]);
    });

    test("builds it once, rather than rebuilding over the top", () => {
      const seen = new Set<string>();
      const duplicates = built.filter((entry) => (seen.has(entry) ? true : (seen.add(entry), false)));
      expect(duplicates).toEqual([]);
    });
  });

  // An exported marker would let a child shell read its parent's startup as
  // its own and skip the rebuild it needs, which is the whole bug again.
  test("does not export the marker the rebuild keys on", () => {
    const r = run([
      "zsh",
      "-fc",
      `source '${join(repoRoot, "zsh", ".zshenv")}' >/dev/null 2>&1
       zsh -fc 'echo \${DOTFILES_ZSHENV_RAN:-unset}'`,
    ]);
    expect(r.stdout.trim()).toBe("unset");
  });
});
