import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { must, repoRoot, run, sandbox, type Sandbox } from "#harness";

const installer = join(repoRoot, "rex", "install.sh");

let box: Sandbox;
let env: Record<string, string | undefined>;
let clone: string;

function tagAt(dir: string): string {
  return must(["git", "-C", dir, "describe", "--tags", "--exact-match"]).trim();
}

beforeAll(() => {
  box = sandbox("rex-install");
  const upstream = box.mkdir("upstream");
  const global = box.write(
    "gitconfig",
    `[url "${upstream}"]\n\tinsteadOf = https://github.com/YangJonghun/rex-agent-resume.git\n` +
      "[user]\n\tname = t\n\temail = t@t\n[commit]\n\tgpgsign = false\n[tag]\n\tgpgsign = false\n",
  );
  const git = { env: { GIT_CONFIG_GLOBAL: global } };
  must(["git", "-C", upstream, "init", "--quiet"], git);
  for (const tag of ["v1", "v2"]) {
    must(["git", "-C", upstream, "commit", "--quiet", "--allow-empty", "-m", tag], git);
    must(["git", "-C", upstream, "tag", tag], git);
  }
  const home = box.mkdir("home");
  clone = join(home, ".local", "share", "rex-agent-resume");
  env = { HOME: home, GIT_CONFIG_GLOBAL: global, GIT_CONFIG_SYSTEM: "/dev/null", ZDOTDIR: box.mkdir("zdotdir") };
});

afterAll(() => {
  box.remove();
});

describe("rex/install.sh", () => {
  test("clones the pinned tag", () => {
    const result = run([installer], { env: { ...env, REX_AGENT_RESUME_TAG: "v1" } });
    expect(result.status).toBe(0);
    expect(tagAt(clone)).toBe("v1");
  });

  test("moves an existing clone to a new tag", () => {
    expect(run([installer], { env: { ...env, REX_AGENT_RESUME_TAG: "v2" } }).status).toBe(0);
    expect(tagAt(clone)).toBe("v2");
  });

  test("leaves a clone at the pinned tag alone", () => {
    const result = run([installer], { env: { ...env, REX_AGENT_RESUME_TAG: "v2" } });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  test("warns and exits 0 when the tag is missing", () => {
    const result = run([installer], { env: { ...env, REX_AGENT_RESUME_TAG: "v3" } });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("could not be checked out at v3");
    expect(tagAt(clone)).toBe("v2");
  });
});
