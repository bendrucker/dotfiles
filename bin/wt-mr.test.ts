import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The scope in the query path picks the canned result set, and the identity
// call answers from its own file. A file that is not there is the call glab
// could not answer, which real glab reports by exiting nonzero.
const GLAB_STUB = `#!/usr/bin/env bash
[ "$1" = "--stub-check" ] && { echo "glab stub"; exit 0; }
printf '%s\\n' "$*" >>"$GLAB_LOG"
case "$2" in
  /user)            file="$GLAB_USER" ;;
  *created_by_me*)  file="$GLAB_MINE" ;;
  *reviewer_username*) file="$GLAB_REVIEW" ;;
  *) exit 1 ;;
esac
[ -f "$file" ] || exit 1
cat "$file"
`;

const FZF_STUB = `#!/usr/bin/env bash
[ "$1" = "--stub-check" ] && { echo "fzf stub"; exit 0; }
cat >"$FZF_STDIN"
[ -n "$FZF_PICK" ] || exit 130
sed -n "\${FZF_PICK}p" "$FZF_STDIN"
`;

const CLONE_STUB = `#!/usr/bin/env bash
[ "$1" = "--stub-check" ] && { echo "clone-repo stub"; exit 0; }
printf '%s\\n' "$*" >>"$CLONE_LOG"
echo /checkouts/proj
`;

const WT_STUB = `#!/usr/bin/env bash
[ "$1" = "--stub-check" ] && { echo "wt stub"; exit 0; }
printf '%s\\n' "$*" >>"$WT_LOG"
`;

const GUM_STUB = `#!/usr/bin/env bash
[ "$1" = "--stub-check" ] && { echo "gum stub"; exit 0; }
printf '%s\\n' "$*" >>"$GUM_LOG"
`;

const SCRIPT = join(import.meta.dir, "wt-mr");
const STUBS: Record<string, string> = {
  glab: GLAB_STUB,
  fzf: FZF_STUB,
  "clone-repo": CLONE_STUB,
  wt: WT_STUB,
  gum: GUM_STUB,
};

let sandbox: string;
let stubs: string;
let path: string;
let variables: Record<string, string>;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "wt-mr-"));
  stubs = join(sandbox, "stub");
  mkdirSync(stubs);
  for (const [name, script] of Object.entries(STUBS)) {
    writeFileSync(join(stubs, name), script);
    chmodSync(join(stubs, name), 0o755);
  }

  // The stub directory ahead of the two system ones, which hold none of the
  // tools under stub and do hold the bash every stub runs on.
  path = `${stubs}:/usr/bin:/bin`;
  variables = {
    PATH: path,
    GLAB_LOG: join(sandbox, "glab.log"),
    GLAB_USER: join(sandbox, "user.json"),
    GLAB_MINE: join(sandbox, "mine.ndjson"),
    GLAB_REVIEW: join(sandbox, "review.ndjson"),
    FZF_STDIN: join(sandbox, "fzf.stdin"),
    CLONE_LOG: join(sandbox, "clone.log"),
    WT_LOG: join(sandbox, "wt.log"),
    GUM_LOG: join(sandbox, "gum.log"),
  };

  for (const log of ["GLAB_LOG", "CLONE_LOG", "WT_LOG", "GUM_LOG"]) {
    writeFileSync(variables[log] as string, "");
  }
  writeFileSync(variables.GLAB_USER as string, JSON.stringify({ username: "a.reviewer" }));
  results("GLAB_MINE", []);
  results("GLAB_REVIEW", []);

  proveStubs();
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

// The PATH these cases hand the script is their whole isolation. A stub that
// did not shadow its real binary would let a case reach GitLab, open a picker
// on the terminal, or clone a project and still look like it passed.
function proveStubs(): void {
  for (const name of Object.keys(STUBS)) {
    const run = Bun.spawnSync({ cmd: [name, "--stub-check"], env: { PATH: path }, stdin: "ignore" });
    const said = run.stdout.toString().trim();
    if (said !== `${name} stub`) {
      throw new Error(`the ${name} stub is not on PATH: --stub-check said ${JSON.stringify(said)}`);
    }
  }
}

interface MergeRequest {
  iid: number;
  title: string;
  project: string;
  host?: string;
}

function results(name: "GLAB_MINE" | "GLAB_REVIEW", merges: MergeRequest[]): void {
  const lines = merges.map((merge) => {
    const host = merge.host ?? "https://gitlab.com";
    return JSON.stringify({
      iid: merge.iid,
      title: merge.title,
      web_url: `${host}/${merge.project}/-/merge_requests/${merge.iid}`,
      references: { full: `${merge.project}!${merge.iid}` },
    });
  });
  writeFileSync(variables[name] as string, lines.map((line) => `${line}\n`).join(""));
}

interface Outcome {
  status: number;
  stdout: string;
  stderr: string;
}

// Run through bun by path rather than by shebang, so PATH can hold only what
// the case wants the script to find.
function run(args: string[], extra: Record<string, string> = {}): Outcome {
  const spawned = Bun.spawnSync({
    cmd: [process.execPath, SCRIPT, ...args],
    env: { ...process.env, ...variables, ...extra },
    stdin: "ignore",
  });
  return {
    status: spawned.exitCode,
    stdout: spawned.stdout.toString(),
    stderr: spawned.stderr.toString(),
  };
}

function log(name: "GLAB_LOG" | "FZF_STDIN" | "CLONE_LOG" | "WT_LOG" | "GUM_LOG"): string {
  const file = variables[name] as string;
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

test("prints the usage on --help", () => {
  const outcome = run(["--help"]);
  expect(outcome.status).toBe(0);
  expect(outcome.stdout).toStartWith("usage: wt mr [--mine|--review]");
  expect(log("GLAB_LOG")).toBe("");
});

test("refuses --mine and --review together", () => {
  const outcome = run(["--mine", "--review"]);
  expect(outcome.status).toBe(2);
  expect(outcome.stderr).toStartWith("wt mr: --mine and --review select opposite halves\n");
  expect(log("GLAB_LOG")).toBe("");
});

test("names a tool it needs and cannot find", () => {
  rmSync(join(stubs, "clone-repo"));

  expect(run([]).status).toBe(1);
  expect(log("GUM_LOG")).toBe("log --level error clone-repo is required\n");
  expect(log("GLAB_LOG")).toBe("");
});

// The checkout is the merge request's own URL with the merge request cut off
// its end, so a self-hosted host survives into what clone-repo is given.
test("switches to the merge request that was picked", () => {
  results("GLAB_MINE", [
    { iid: 7, title: "a change", project: "group/proj", host: "https://git.example.test" },
  ]);

  const outcome = run(["--mine", "-x", "claude"], { FZF_PICK: "1" });
  expect(outcome.status).toBe(0);
  expect(log("FZF_STDIN")).toBe(
    `${[
      "mine",
      "group/proj!7",
      "a change",
      "https://git.example.test/group/proj/-/merge_requests/7",
      "https://git.example.test/group/proj",
    ].join("\t")}\n`,
  );
  expect(log("CLONE_LOG")).toBe("https://git.example.test/group/proj\n");
  expect(log("WT_LOG")).toBe(
    "-C /checkouts/proj switch https://git.example.test/group/proj/-/merge_requests/7 -x claude\n",
  );
});

test("asks for both halves and shows them in one picker", () => {
  results("GLAB_MINE", [{ iid: 5, title: "mine", project: "group/proj" }]);
  results("GLAB_REVIEW", [{ iid: 1, title: "theirs", project: "other/proj" }]);

  run([], { FZF_PICK: "1" });
  expect(log("GLAB_LOG")).toBe(
    [
      "api /user",
      "api /merge_requests?state=opened&per_page=50&scope=created_by_me --output ndjson",
      "api /merge_requests?state=opened&per_page=50&scope=all&reviewer_username=a.reviewer --output ndjson",
      "",
    ].join("\n"),
  );
  expect(log("FZF_STDIN").split("\n").filter(Boolean).map((row) => row.split("\t")[1])).toEqual([
    "group/proj!5",
    "other/proj!1",
  ]);
});

// GitLab has no @me alias for a reviewer, so the review half needs an identity
// lookup the authored half does not.
test("--mine leaves the identity lookup unasked", () => {
  results("GLAB_MINE", [{ iid: 5, title: "mine", project: "group/proj" }]);

  run(["--mine"], { FZF_PICK: "1" });
  expect(log("GLAB_LOG")).not.toContain("/user");
});

test("stops when glab cannot name the current user", () => {
  rmSync(variables.GLAB_USER as string);

  expect(run(["--review"]).status).toBe(1);
  expect(log("GUM_LOG")).toBe("log --level error glab could not name the current user\n");
  expect(log("FZF_STDIN")).toBe("");
});

test("shows a merge request in both halves once", () => {
  results("GLAB_MINE", [{ iid: 5, title: "mine", project: "group/proj" }]);
  results("GLAB_REVIEW", [{ iid: 5, title: "mine", project: "group/proj" }]);

  run([], { FZF_PICK: "1" });
  expect(log("FZF_STDIN").split("\n").filter(Boolean)).toHaveLength(1);
});

// A failed query is not an empty result set. Showing the picker here would put
// half of what is waiting on you on screen as the whole of it.
test("stops on a query glab could not answer", () => {
  rmSync(variables.GLAB_MINE as string);

  expect(run(["--mine"]).status).toBe(1);
  expect(log("GUM_LOG")).toBe(
    "log --level error glab api /merge_requests?scope=created_by_me failed\n",
  );
  expect(log("FZF_STDIN")).toBe("");
});

test("says so when nothing is open", () => {
  expect(run([]).status).toBe(1);
  expect(log("GUM_LOG")).toBe("log --level warn no open merge requests\n");
  expect(log("FZF_STDIN")).toBe("");
});

test("switches nowhere when the picker is dismissed", () => {
  results("GLAB_MINE", [{ iid: 7, title: "a change", project: "group/proj" }]);

  expect(run([]).status).toBe(1);
  expect(log("CLONE_LOG")).toBe("");
  expect(log("WT_LOG")).toBe("");
});
