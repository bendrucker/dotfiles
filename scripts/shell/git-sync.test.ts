import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { must, quote, repoRoot, run, sandbox, shell, stubGum, type Run, type Sandbox } from "#harness";

const spinLib = join(repoRoot, "scripts", "shell", "spin.sh");
const gitSyncLib = join(repoRoot, "scripts", "shell", "git-sync.sh");
const pinKey = "url.https://github.com/bendrucker/claude.git.insteadOf";

let box: Sandbox;
let repo: string;
let global: string;
let baseEnv: Record<string, string>;

beforeEach(() => {
  box = sandbox("git-https");
  stubGum(box);
  repo = box.path("repo");
  must(["git", "init", "-q", "-b", "main", repo]);

  // A url.*.insteadOf rule anywhere above the repo decides which transport a
  // fetch uses, so these examples supply the only ones that apply.
  global = box.write("gitconfig", "");
  baseEnv = { GIT_CONFIG_GLOBAL: global, GIT_CONFIG_SYSTEM: "/dev/null" };
});

afterEach(() => {
  box.remove();
});

function runLib(script: string, options: { args?: string[]; env?: Record<string, string | undefined> } = {}): Run {
  return shell(`. ${quote(spinLib)}\n. ${quote(gitSyncLib)}\n${script}`, {
    path: [box.bin],
    args: options.args,
    env: { ...baseEnv, ...options.env },
  });
}

// What an org that standardizes on SSH installs. It undoes an HTTPS remote.
function forceSsh(): void {
  must(["git", "config", "--file", global, "url.git@github.com:.insteadOf", "https://github.com/"]);
}

function pushUrl(): string {
  return run(["git", "-C", repo, "config", "--get", "remote.origin.pushurl"], { env: baseEnv }).stdout.trim();
}

function effectiveUrl(): string {
  return run(["git", "-C", repo, "ls-remote", "--get-url", "origin"], { env: baseEnv }).stdout.trim();
}

function pin(): string {
  return run(["git", "-C", repo, "config", "--get", pinKey], { env: baseEnv }).stdout.trim();
}

function pins(): string {
  return run(["git", "-C", repo, "config", "--get-all", pinKey], { env: baseEnv }).stdout;
}

function pinCount(url: string): number {
  return pins()
    .split("\n")
    .filter((line) => line === url).length;
}

function rewrite(url: string): Run {
  return runLib(
    [
      `git -C ${quote(repo)} remote add origin "$1"`,
      `git_https_remote ${quote(repo)}`,
      `git -C ${quote(repo)} config --get remote.origin.url`,
    ].join("\n"),
    { args: [url] },
  );
}

describe("git_https_remote", () => {
  test("rewrites an scp-style github remote", () => {
    const r = rewrite("git@github.com:bendrucker/claude.git");
    expect(r.stdout.trim()).toBe("https://github.com/bendrucker/claude.git");
    expect(r.stderr).toContain("pushing over SSH");
  });

  test("rewrites an ssh:// github remote", () => {
    const r = rewrite("ssh://git@github.com/bendrucker/claude.git");
    expect(r.stdout.trim()).toBe("https://github.com/bendrucker/claude.git");
    expect(r.stderr).toContain("pushing over SSH");
  });

  test("leaves an https github remote alone", () => {
    const r = rewrite("https://github.com/bendrucker/claude.git");
    expect(r.stdout.trim()).toBe("https://github.com/bendrucker/claude.git");
  });

  // Only github.com is public enough to fetch anonymously. A work host keeps
  // whatever transport its credentials are set up for.
  test("leaves a non-github ssh remote alone", () => {
    const r = rewrite("git@gitlab.com:bendrucker/private.git");
    expect(r.stdout.trim()).toBe("git@gitlab.com:bendrucker/private.git");
  });

  test("does nothing when the remote is missing", () => {
    const r = runLib(`git_https_remote ${quote(repo)}`);
    expect(r.status).toBe(0);
  });

  // Only the fetch URL moves. Pushing over anonymous HTTPS would need
  // credentials the SSH remote already had.
  test("keeps the SSH url for pushes", () => {
    const r = rewrite("git@github.com:bendrucker/claude.git");
    expect(r.stdout.trim()).toBe("https://github.com/bendrucker/claude.git");
    expect(pushUrl()).toBe("git@github.com:bendrucker/claude.git");
  });

  test("does not clobber a pushurl that is already set", () => {
    must(["git", "-C", repo, "remote", "add", "origin", "git@github.com:bendrucker/claude.git"]);
    must(["git", "-C", repo, "remote", "set-url", "--push", "origin", "git@github.com:someone/fork.git"]);
    runLib(`git_https_remote ${quote(repo)}`);
    expect(pushUrl()).toBe("git@github.com:someone/fork.git");
  });

  // Regression: `git remote get-url` resolves insteadOf rules, so reading the
  // remote through it reports HTTPS while .git/config still holds SSH, and the
  // rewrite silently never happens.
  test("still rewrites when an insteadOf rule already maps the url", () => {
    const r = runLib(
      [
        "git_https_env",
        `git -C ${quote(repo)} remote add origin "$1"`,
        `git_https_remote ${quote(repo)}`,
        `git -C ${quote(repo)} config --get remote.origin.url`,
      ].join("\n"),
      { args: ["git@github.com:bendrucker/claude.git"] },
    );
    expect(r.stdout.trim()).toBe("https://github.com/bendrucker/claude.git");
    expect(r.stderr).toContain("pushing over SSH");
  });

  // Regression: a remote already stored as HTTPS looks done, and every 3am fetch
  // still went out over SSH and died on "agent refused operation", because the
  // rule rewrote it on the way out.
  test("holds an https remote on HTTPS against a rule mapping it back to SSH", () => {
    forceSsh();
    const r = rewrite("https://github.com/bendrucker/claude.git");
    expect(r.stdout.trim()).toBe("https://github.com/bendrucker/claude.git");
    expect(effectiveUrl()).toBe("https://github.com/bendrucker/claude.git");
    expect(r.stderr).toContain("Pinning origin");
  });

  test("rewrites and pins an ssh remote when the rule is present", () => {
    forceSsh();
    const r = rewrite("git@github.com:bendrucker/claude.git");
    expect(r.stdout.trim()).toBe("https://github.com/bendrucker/claude.git");
    expect(effectiveUrl()).toBe("https://github.com/bendrucker/claude.git");
  });

  // The pin takes the rule out of the fetch path, and a push that was going over
  // SSH has to keep going there. Its credentials are set up for that transport.
  test("keeps pushes on SSH when it pins the fetch", () => {
    forceSsh();
    const r = rewrite("https://github.com/bendrucker/claude.git");
    expect(r.stdout.trim()).toBe("https://github.com/bendrucker/claude.git");
    expect(pushUrl()).toBe("git@github.com:bendrucker/claude.git");
  });

  // Only the stored url decides. A rule that sends another host to github does
  // not make this a github remote, and acting on one whose replacement drops the
  // repo path would store a url naming a repository that does not exist.
  test("leaves a non-github remote alone when a rule sends it to github", () => {
    must(["git", "config", "--file", global, "url.https://github.com/.insteadOf", "https://"]);
    const r = rewrite("https://bitbucket.org/bendrucker/private.git");
    expect(r.stdout.trim()).toBe("https://bitbucket.org/bendrucker/private.git");
    expect(pin()).toBe("");
    expect(r.stderr).not.toContain("Pinning");
  });

  // A mirror or proxy rule can be the only route out of a network. Pinning past
  // it would bypass it for fetches and aim pushes at a mirror that may be read
  // only, and neither has anything to do with an agent that will not sign.
  test("leaves a rule routing the remote to another https host in place", () => {
    must([
      "git",
      "config",
      "--file",
      global,
      "url.https://mirror.corp.example/github/.insteadOf",
      "https://github.com/",
    ]);
    const r = rewrite("https://github.com/bendrucker/claude.git");
    expect(r.stdout.trim()).toBe("https://github.com/bendrucker/claude.git");
    expect(effectiveUrl()).toBe("https://mirror.corp.example/github/bendrucker/claude.git");
    expect(pushUrl()).toBe("");
    expect(r.stderr).not.toContain("Pinning");
  });

  // Most machines have no such rule. Writing the pin anyway would leave an
  // unexplained url.*.insteadOf in every repo the nightly job touches.
  test("writes no pin when nothing rewrites the url", () => {
    const r = rewrite("git@github.com:bendrucker/claude.git");
    expect(r.stdout.trim()).toBe("https://github.com/bendrucker/claude.git");
    expect(pin()).toBe("");
    expect(r.stderr).not.toContain("Pinning");
  });

  // insteadOf is multi-valued. A plain write refuses a key already carrying two
  // rules, which left the pin unwritten and the fetch back on SSH.
  test("pins alongside existing rules on the key it claims", () => {
    forceSsh();
    must(["git", "config", "--file", global, "--add", "url.git@github.com:.insteadOf", "https://git.example.com/"]);
    must(["git", "-C", repo, "config", "--add", pinKey, "https://mirror.example/"]);
    must(["git", "-C", repo, "config", "--add", pinKey, "https://mirror2.example/"]);
    const r = rewrite("https://github.com/bendrucker/claude.git");
    expect(r.stdout.trim()).toBe("https://github.com/bendrucker/claude.git");
    expect(effectiveUrl()).toBe("https://github.com/bendrucker/claude.git");
    expect(pins()).toContain("https://mirror.example/");
    expect(pins()).toContain("https://mirror2.example/");
  });

  // A rule of equal length registered earlier wins the tie, so this pin never
  // takes. It has to stop trying rather than grow .git/config a line a night.
  test("adds the pin once when an equal-length rule outranks it", () => {
    must([
      "git",
      "config",
      "--file",
      global,
      "url.git@github.com:bendrucker/claude.git.insteadOf",
      "https://github.com/bendrucker/claude.git",
    ]);
    const r = runLib(
      [
        `git -C ${quote(repo)} remote add origin "$1"`,
        `git_https_remote ${quote(repo)}`,
        `git_https_remote ${quote(repo)}`,
        `git_https_remote ${quote(repo)}`,
        `git -C ${quote(repo)} config --get remote.origin.url`,
      ].join("\n"),
      { args: ["https://github.com/bendrucker/claude.git"] },
    );
    expect(r.stdout.trim()).toBe("https://github.com/bendrucker/claude.git");
    expect(pinCount("https://github.com/bendrucker/claude.git")).toBe(1);
    expect(r.stderr).toContain("still resolves to");
  });
});

describe("git_https_env", () => {
  test("rewrites github SSH urls for child git processes", () => {
    const r = runLib(
      [
        `git -C ${quote(repo)} remote add origin "$1"`,
        "git_https_env",
        `git -C ${quote(repo)} ls-remote --get-url origin`,
      ].join("\n"),
      { args: ["git@github.com:bendrucker/claude.git"] },
    );
    expect(r.stdout.trim()).toBe("https://github.com/bendrucker/claude.git");
  });

  // A ~/.zshenv.local can export its own GIT_CONFIG entries. Overwriting index
  // 0 and pinning the count at 2 would silently drop them.
  test("appends to inherited GIT_CONFIG entries", () => {
    const r = runLib(
      [
        `git -C ${quote(repo)} remote add origin "$1"`,
        "git_https_env",
        `git -C ${quote(repo)} ls-remote --get-url origin`,
        `printf 'GIT_CONFIG_COUNT=%s\\n' "$GIT_CONFIG_COUNT"`,
        `printf 'GIT_CONFIG_VALUE_0=%s\\n' "$GIT_CONFIG_VALUE_0"`,
      ].join("\n"),
      {
        args: ["git@github.com:bendrucker/claude.git"],
        env: { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.pager", GIT_CONFIG_VALUE_0: "cat" },
      },
    );
    const [url, count, value0] = r.stdout.trim().split("\n");
    expect(url).toBe("https://github.com/bendrucker/claude.git");
    expect(count).toBe("GIT_CONFIG_COUNT=3");
    expect(value0).toBe("GIT_CONFIG_VALUE_0=cat");
  });
});
