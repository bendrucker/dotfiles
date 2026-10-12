import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, readlinkSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { repoRoot, run, sandbox, type Sandbox } from "#harness";

const installSymlinks = join(repoRoot, "scripts", "install-symlinks");

let box: Sandbox;
let root: string;
let home: string;
let xdg: string;

beforeEach(() => {
  box = sandbox("install-symlinks");
  root = box.mkdir("root");
  home = box.mkdir("home");
  xdg = box.mkdir("home", ".config");
});

afterEach(() => {
  box.remove();
});

// A mise whose status reports one entry in each state that matters, and which
// records every apply it is asked for.
function stubMise(targets: Record<string, string>) {
  const files = Object.entries(targets).map(([target, state]) => ({ target, state }));
  box.write("status.json", JSON.stringify({ files }));
  box.stub(
    "mise",
    `[ "$2" = status ] && exec cat "${box.path("status.json")}"\necho "$@" >> "${box.path("applied")}"\n`,
  );
}

function runInstall() {
  return run([installSymlinks, root], { env: { HOME: home, XDG_CONFIG_HOME: xdg }, path: [box.bin] });
}

function applied(): string {
  try {
    return readFileSync(box.path("applied"), "utf8");
  } catch {
    return "";
  }
}

describe("install-symlinks", () => {
  test("links conf.d to the dotfiles root and applies with force", () => {
    stubMise({ "~/.kept": "applied", "~/.config/file": "differs" });
    box.write("home/.config/file", "replaced by the link\n");

    expect(runInstall().status).toBe(0);

    expect(readlinkSync(join(xdg, "mise", "conf.d"))).toBe(root);
    expect(applied()).toBe("dot apply --yes --force\n");
  });

  test("repoints conf.d at another root", () => {
    stubMise({});
    box.mkdir("home", ".config", "mise");
    symlinkSync(box.mkdir("other"), join(xdg, "mise", "conf.d"));

    expect(runInstall().status).toBe(0);

    expect(readlinkSync(join(xdg, "mise", "conf.d"))).toBe(root);
  });

  test("refuses a real directory at a target", () => {
    stubMise({ "~/.config/nvim": "differs" });
    box.write("home/.config/nvim/init.lua", "mine\n");

    const r = runInstall();

    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`${xdg}/nvim is a directory`);
    expect(applied()).toBe("");
  });

  test("applies nothing while conf.d is still a directory", () => {
    stubMise({});
    box.mkdir("home", ".config", "mise", "conf.d");

    const r = runInstall();

    expect(r.status).toBe(1);
    expect(r.stderr).toContain("migrate conf.d first");
    expect(applied()).toBe("");
  });
});
