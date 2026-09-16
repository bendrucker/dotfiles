import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
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

/** An installer that records the path it ran as, so order is assertable. */
function installer(path: string) {
  box.stub(join("root", path), `echo ${path} >> "$LOG"`);
}

/** The url key is what a section carries besides path, so the read has to pass it over. */
function submodules(...paths: string[]) {
  const sections = paths.map(
    (path) => `[submodule "${path}"]\n\tpath = ${path}\n\turl = https://example.test/${path}.git\n`,
  );
  box.write("root/.gitmodules", sections.join(""));
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

  test("leaves a submodule alone whose path carries a space", () => {
    submodules("some vendor");
    installer("git/install.sh");
    installer("some vendor/install.sh");

    install();
    expect(ran()).toEqual(["git/install.sh"]);
  });

  test("runs the topic a nested submodule sits under", () => {
    submodules("bat/catppuccin");
    installer("bat/install.sh");

    install();
    expect(ran()).toEqual(["bat/install.sh"]);
  });

  test("refuses to guess when .gitmodules cannot be read", () => {
    box.write("root/.gitmodules", "this is not a config file\n");
    installer("vendor/install.sh");

    // Reading an unparsable .gitmodules as "declares nothing" would run the
    // installer of whatever it does declare.
    const result = install();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("cannot read .gitmodules");
    expect(ran()).toEqual([]);
  });

  test("stops at a failing installer", () => {
    installer("a-topic/install.sh");
    installer("b-topic/install.sh");
    installer("c-topic/install.sh");
    box.stub(join("root", "b-topic", "install.sh"), "exit 3");

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
