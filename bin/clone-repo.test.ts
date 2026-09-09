import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { run, type Sandbox, sandbox } from "#harness";

const SCRIPT = join(import.meta.dir, "clone-repo");

const GH_STUB = `
printf '%s\\n' "$*" >>"$GH_LOG"
case "$1 $2" in
  "api user") echo "$GH_LOGIN" ;;
  "api user/orgs")
    [ -n "$GH_ORGS" ] && printf '%s\\n' $GH_ORGS
    exit "\${GH_ORGS_STATUS:-0}"
    ;;
  "repo clone")
    [ -n "$GH_CLONE_STDERR" ] && echo "$GH_CLONE_STDERR" >&2
    exit "\${GH_CLONE_STATUS:-0}"
    ;;
esac
`;

const GLAB_STUB = `
printf '%s\\n' "$*" >>"$GLAB_LOG"
`;

let box: Sandbox;
let projects: string;
let env: Record<string, string | undefined>;

beforeEach(() => {
  box = sandbox("clone-repo");
  box.stub("gh", GH_STUB);
  box.stub("glab", GLAB_STUB);
  box.stub("claude-overlay", "exit 0");
  projects = box.mkdir("src");
  env = {
    PROJECTS: projects,
    XDG_CACHE_HOME: box.mkdir("cache"),
    GH_LOG: box.path("gh.log"),
    GLAB_LOG: box.path("glab.log"),
    GH_LOGIN: "me",
    GH_CLONE_STATUS: undefined,
    GH_CLONE_STDERR: undefined,
    GH_ORGS: undefined,
    GH_ORGS_STATUS: undefined,
  };
});

afterEach(() => box.remove());

function clone(...args: string[]) {
  return run([SCRIPT, ...args], { path: [box.bin], env });
}

test("a bare name is one of your own repositories", () => {
  const result = clone("code-hub");
  expect(result.status).toBe(0);
  expect(result.stdout).toBe(`${projects}/me/code-hub\n`);
  expect(box.read("gh.log")).toBe(
    ["api user --jq .login", `repo clone me/code-hub ${projects}/me/code-hub`, ""].join("\n"),
  );
});

test("owner/repo clones as given without asking gh who you are", () => {
  const result = clone("owner/repo");
  expect(result.status).toBe(0);
  expect(result.stdout).toBe(`${projects}/owner/repo\n`);
  expect(box.read("gh.log")).toBe(`repo clone owner/repo ${projects}/owner/repo\n`);
});

test("a github URL is handed to gh whole", () => {
  const result = clone("https://github.com/owner/repo.git");
  expect(result.status).toBe(0);
  expect(result.stdout).toBe(`${projects}/owner/repo\n`);
  expect(box.read("gh.log")).toBe(`repo clone https://github.com/owner/repo.git ${projects}/owner/repo\n`);
});

test("a gitlab URL clones through glab by path", () => {
  const result = clone("https://gitlab.com/group/project");
  expect(result.status).toBe(0);
  expect(result.stdout).toBe(`${projects}/group/project\n`);
  expect(box.read("glab.log")).toBe(`repo clone group/project ${projects}/group/project\n`);
  expect(box.read("gh.log")).toBe("");
});

test("an existing checkout is printed without cloning", () => {
  box.mkdir("src", "me", "code-hub");
  const result = clone("code-hub");
  expect(result.status).toBe(0);
  expect(result.stdout).toBe(`${projects}/me/code-hub\n`);
  expect(box.read("gh.log")).toBe("api user --jq .login\n");
});

test.each([
  ["", "a repository is required"],
  ["--bogus", "unknown option --bogus"],
  ["owner/", "owner/ does not name a repository"],
  ["/repo", "/repo does not name an owner"],
  ["a/b/c", "a/b/c has more than owner/repo in it"],
  ["git@github.com:owner/repo.git", "git@github.com:owner/repo.git does not name an owner"],
  ["https://github.com/owner", "https://github.com/owner does not name a repository"],
  ["https://github.com/a/b/c", "https://github.com/a/b/c has more than owner/repo in its path"],
])("rejects %j before reaching gh", (input, message) => {
  const result = input === "" ? clone() : clone(input);
  expect(result.status).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toStartWith(`clone-repo: ${message}\nusage: clone-repo`);
  expect(box.read("gh.log")).toBe("");
});

test("a failed clone repeats gh's own message and one line more", () => {
  env.GH_CLONE_STATUS = "1";
  env.GH_CLONE_STDERR = "GraphQL: Could not resolve to a Repository with the name 'owner/repo'. (repository)";
  const result = clone("owner/repo");
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe(
    [
      "GraphQL: Could not resolve to a Repository with the name 'owner/repo'. (repository)",
      "clone-repo: gh could not clone owner/repo",
      "",
    ].join("\n"),
  );
});

test("a gh that cannot say who you are stops a bare name", () => {
  env.GH_LOGIN = "";
  const result = clone("code-hub");
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toStartWith("clone-repo: gh could not report your login");
  expect(box.read("gh.log")).toBe("api user --jq .login\n");
});

test("an unset PROJECTS is named rather than cloned under undefined", () => {
  env.PROJECTS = undefined;
  const result = clone("owner/repo");
  expect(result.status).toBe(1);
  expect(result.stderr).toBe("clone-repo: PROJECTS is not set, so there is nowhere to clone into\n");
  expect(box.read("gh.log")).toBe("");
});

test("completion of a partial owner/repo searches that owner", () => {
  const result = clone("owner/re", "--completions");
  expect(result.status).toBe(0);
  expect(box.read("gh.log")).toBe("search repos re --owner owner --json fullName --jq .[].fullName --limit 20\n");
});

test("completion of an empty prefix offers @me before the cached owners", () => {
  box.write("cache/clone-repo/owners.json", JSON.stringify(["me", "org"]));
  const result = clone("", "--completions");
  expect(result.status).toBe(0);
  expect(result.stdout).toBe("@me\nme\norg\n");
  expect(box.read("gh.log")).toBe("");
});

test("refreshing owners caches the login ahead of the orgs", () => {
  env.GH_ORGS = "org1 org2";
  const result = clone("--refresh-owners");
  expect(result.status).toBe(0);
  expect(box.read("cache/clone-repo/owners.json")).toBe(JSON.stringify(["me", "org1", "org2"]));
});

test("a failed org listing leaves the owner cache alone", () => {
  box.write("cache/clone-repo/owners.json", JSON.stringify(["me", "org1"]));
  env.GH_ORGS_STATUS = "1";
  const result = clone("--refresh-owners");
  expect(result.status).toBe(0);
  expect(box.read("cache/clone-repo/owners.json")).toBe(JSON.stringify(["me", "org1"]));
});
