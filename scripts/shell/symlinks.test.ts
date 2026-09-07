import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { lstatSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { quote, repoRoot, sandbox, shell, type Sandbox } from "#harness";

const lib = join(repoRoot, "scripts", "shell", "symlinks.sh");

function symlinkCreate(src: string, dst: string) {
  return shell(`. ${quote(lib)}\nsymlink_create "$1" "$2"`, { args: [src, dst] });
}

function symlinkPrune(root: string, desired: string, candidates: string[]) {
  return shell(`. ${quote(lib)}\nprintf '%s\\n' "$@" | symlink_prune "$1" "$2"`, {
    args: [root, desired, ...candidates],
  });
}

let box: Sandbox;

beforeEach(() => {
  box = sandbox("symlinks-lib");
});

afterEach(() => {
  box.remove();
});

describe("symlinks.sh", () => {
  describe("symlink_create", () => {
    test("creates missing parent directories and an idempotent link", () => {
      const src = box.path("source");
      const dst = box.path("nested", "deep", "link");
      writeFileSync(src, "content\n");

      const r = symlinkCreate(src, dst);
      expect(r.status).toBe(0);
      expect(lstatSync(dst).isSymbolicLink()).toBe(true);
      expect(readFileSync(dst, "utf8").trim()).toBe("content");

      // A second call must succeed without error and leave the same link.
      symlinkCreate(src, dst);
      expect(lstatSync(dst).isSymbolicLink()).toBe(true);
    });
  });

  describe("symlink_prune", () => {
    let root: string;
    let other: string;
    let home: string;

    beforeEach(() => {
      root = box.mkdir("root");
      other = box.mkdir("other");
      home = box.mkdir("home");
      writeFileSync(join(root, "declared-source"), "x\n");
      writeFileSync(join(root, "stale-source"), "x\n");
      writeFileSync(join(other, "outside-source"), "x\n");

      symlinkSync(join(root, "declared-source"), join(home, "declared"));
      symlinkSync(join(root, "stale-source"), join(home, "stale"));
      symlinkSync(join(other, "outside-source"), join(home, "outside"));
    });

    test("removes an undeclared link into root, keeps declared and outside links", () => {
      const declared = join(home, "declared");
      const stale = join(home, "stale");
      const outside = join(home, "outside");

      const r = symlinkPrune(root, declared, [declared, stale, outside]);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(`removing stale symlink ${stale}`);
      expect(lstatSync(declared).isSymbolicLink()).toBe(true);
      expect(() => lstatSync(stale)).toThrow();
      expect(lstatSync(outside).isSymbolicLink()).toBe(true);
    });
  });
});
