import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { repoRoot, run, sandbox, type Sandbox } from "#harness";

const script = join(repoRoot, "git", "install-signing");
const key = "ecdsa-sha2-nistp256 AAAAsigning";

let box: Sandbox;

beforeEach(() => {
  box = sandbox("install-signing");
  box.write("gitconfig", "[user]\n  email = me@example.com\n");
  box.stub("scutil", "echo Studio");
  box.stub("gh", 'echo "$* $(cat)" >> "${0%/bin/*}/gh.log"; exit "${GH_STATUS:-0}"');
  agentKeys([`ecdsa-sha2-nistp256 AAAAlogin GitHub@secretive.Studio.local`, `${key} Git-Signing@secretive.Studio.local`]);
});

afterEach(() => box.remove());

function agentKeys(lines: string[]) {
  box.stub("ssh-add", lines.length ? `printf '%s\\n' ${lines.map((l) => `'${l}'`).join(" ")}` : "exit 1");
}

function install(env: Record<string, string> = {}, args: string[] = []) {
  return run([script, ...args], {
    path: [box.bin],
    env: { HOME: box.dir, XDG_CONFIG_HOME: box.path("config"), GIT_CONFIG_GLOBAL: box.path("gitconfig"), ...env },
  });
}

function local(name: string) {
  return run(["git", "config", "--file", box.path("config/git/config.local"), name]).stdout.trim();
}

describe("install-signing", () => {
  test("configures signing with the Git Signing key", () => {
    expect(install().status).toBe(0);
    expect(local("user.signingkey")).toBe(`key::${key}`);
    expect(local("commit.gpgsign")).toBe("true");
    expect(local("tag.gpgsign")).toBe("true");
    expect(box.read("config/git/allowed_signers")).toBe(`me@example.com ${key}\n`);
    expect(box.read("gh.log")).toBe(`ssh-key add - --type signing --title Git Signing (Studio) ${key}\n`);
  });

  test("finds a key named by --name", () => {
    agentKeys([`${key} Work-Signing@secretive.Studio.local`]);
    install({}, ["--name", "Work Signing"]);
    expect(local("user.signingkey")).toBe(`key::${key}`);
    expect(box.read("gh.log")).toContain("--title Work Signing (Studio)");
  });

  test("registers with GitHub and records the signer once", () => {
    install();
    install();
    expect(box.read("gh.log").split("\n").filter(Boolean)).toHaveLength(1);
    expect(box.read("config/git/allowed_signers")).toBe(`me@example.com ${key}\n`);
  });

  test("prints the commands to run when GitHub refuses the key", () => {
    const r = install({ GH_STATUS: "1" });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("gh auth refresh -h github.com -s admin:ssh_signing_key");
    expect(r.stderr).toContain(`echo '${key}' | gh ssh-key add`);
  });

  test("prints the commands to run without gh", () => {
    rmSync(join(box.bin, "gh"));
    const tools = box.mkdir("tools");
    symlinkSync(Bun.which("git") ?? "git", join(tools, "git"));
    symlinkSync(process.execPath, join(tools, "bun"));
    const r = run([script], {
      onlyPath: [box.bin, tools],
      env: { HOME: box.dir, XDG_CONFIG_HOME: box.path("config"), GIT_CONFIG_GLOBAL: box.path("gitconfig") },
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain(`echo '${key}' | gh ssh-key add`);
  });

  test("starts a new line after a signer file missing its final newline", () => {
    box.write("config/git/allowed_signers", "me@example.com ecdsa-sha2-nistp256 AAAAother");
    install();
    expect(box.read("config/git/allowed_signers")).toBe(`me@example.com ecdsa-sha2-nistp256 AAAAother\nme@example.com ${key}\n`);
  });

  test.each<{ name: string; lines: string[] }>([
    { name: "Secretive is unreachable", lines: [] },
    { name: "Secretive holds no Git Signing key", lines: ["ecdsa-sha2-nistp256 AAAAlogin GitHub@secretive.Studio.local"] },
  ])("leaves signing off when $name", ({ lines }) => {
    agentKeys(lines);
    expect(install().status).toBe(0);
    expect(box.read("config/git/config.local")).toBe("");
    expect(box.read("gh.log")).toBe("");
  });
});
