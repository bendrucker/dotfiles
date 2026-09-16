import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { repoRoot, run, sandbox, type Sandbox } from "#harness";

const script = join(repoRoot, "scripts", "install-topics");

let box: Sandbox;
let root: string;

beforeEach(() => {
  box = sandbox("install-topics");
  root = box.mkdir("root");
});

afterEach(() => {
  box.remove();
});

function installer(path: string) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `#!/bin/sh\necho ${path} >> "$LOG"\n`);
  chmodSync(target, 0o755);
}

/** The url key is what a section carries besides path, so the read has to pass it over. */
function submodules(...paths: string[]) {
  const sections = paths.map(
    (path) => `[submodule "${path}"]\n\tpath = ${path}\n\turl = https://example.test/${path}.git\n`,
  );
  writeFileSync(join(root, ".gitmodules"), sections.join(""));
}

function install() {
  return run([script, root], { env: { LOG: box.path("ran") } });
}

function ran(): string[] {
  return box.read("ran").split("\n").filter(Boolean);
}

describe("install-topics", () => {
  test("runs each topic's installer", () => {
    installer("git/install.sh");
    installer("macos/install.sh");
    installer("terminal/install.sh");

    expect(install().status).toBe(0);
    expect(ran()).toEqual(["git/install.sh", "macos/install.sh", "terminal/install.sh"]);
  });

  test("leaves mise to scripts/install, which sources it first", () => {
    installer("git/install.sh");
    installer("mise/install.sh");

    install();
    expect(ran()).toEqual(["git/install.sh"]);
  });

  test("stays out of a worktree's copy of the tree", () => {
    installer("macos/install.sh");
    installer(".worktrees/some-branch/macos/install.sh");

    install();
    expect(ran()).toEqual(["macos/install.sh"]);
  });

  test("stays out of directories that hold no topic", () => {
    installer("git/install.sh");
    installer(".git/install.sh");
    installer("node_modules/some-package/install.sh");
    installer("tmp/lint-ts/install.sh");

    install();
    expect(ran()).toEqual(["git/install.sh"]);
  });

  test("leaves a submodule's own installer alone", () => {
    submodules("vendor");
    installer("git/install.sh");
    installer("vendor/install.sh");

    install();
    expect(ran()).toEqual(["git/install.sh"]);
  });

  test("runs the topic a nested submodule sits under", () => {
    submodules("bat/catppuccin");
    installer("bat/install.sh");

    install();
    expect(ran()).toEqual(["bat/install.sh"]);
  });

  test("stops at a failing installer", () => {
    installer("a-topic/install.sh");
    installer("b-topic/install.sh");
    installer("c-topic/install.sh");
    writeFileSync(join(root, "b-topic", "install.sh"), "#!/bin/sh\nexit 3\n");

    // The glob is sorted, so b-topic runs between the other two.
    const result = install();
    expect(result.status).toBe(3);
    expect(ran()).toEqual(["a-topic/install.sh"]);
  });

  test("succeeds where no topic has an installer", () => {
    box.mkdir("root", "colors");

    expect(install().status).toBe(0);
    expect(ran()).toEqual([]);
  });
});
