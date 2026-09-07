import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot, run } from "#harness";

const script = join(repoRoot, "bin", "glyph-scan");

function glyphScan(args: string[] = [], cwd?: string) {
  return run([script, ...args], { cwd });
}

const font = join(homedir(), "Library", "Fonts", "MonaspiceNeNerdFontMono-Regular.otf");

describe("terminal glyphs", () => {
  test("declares every private-use glyph used in a tracked file", () => {
    const r = glyphScan();
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
  });

  test.skipIf(!existsSync(font))("renders every declared glyph in the installed font", () => {
    const r = glyphScan(["--font"]);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
  });

  // The scan reads `git ls-files` from whatever repo it is run in, so a scratch
  // repo is what lets it be pointed at a known tree.
  function scratchRepo(file: string): ReturnType<typeof run> {
    const repo = mkdtempSync(join(tmpdir(), "glyph-scan-"));
    mkdirSync(join(repo, "terminal"), { recursive: true });
    run(["git", "-C", repo, "init", "-q"]);
    writeFileSync(join(repo, "terminal", "glyphs.conf"), "# no declarations\n");
    writeFileSync(join(repo, file), Buffer.from([0xf3, 0xb0, 0xaa, 0x9f, 0x0a]));
    run(["git", "-C", repo, "add", "-A"]);
    const r = glyphScan([], repo);
    rmSync(repo, { recursive: true, force: true });
    return r;
  }

  test("reports an undeclared glyph in a file this repo renders", () => {
    const r = scratchRepo("terminal/ghostty.config");
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toContain("U+F0A9F");
  });
});
