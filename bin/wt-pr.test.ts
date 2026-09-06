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

// The filter that named the bucket picks the canned result set. A file that is
// not there is the query gh could not answer, which real gh reports by exiting
// nonzero.
const GH_STUB = `#!/usr/bin/env bash
[ "$1" = "--stub-check" ] && { echo "gh stub"; exit 0; }
printf '%s\\n' "$*" >>"$GH_LOG"
file=""
for arg in "$@"; do
  case "$arg" in
    --author=@me) file="$GH_MINE" ;;
    --review-requested=@me) file="$GH_REVIEW" ;;
  esac
done
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
echo /checkouts/repo
`;

const WT_STUB = `#!/usr/bin/env bash
[ "$1" = "--stub-check" ] && { echo "wt stub"; exit 0; }
printf '%s\\n' "$*" >>"$WT_LOG"
`;

const GUM_STUB = `#!/usr/bin/env bash
[ "$1" = "--stub-check" ] && { echo "gum stub"; exit 0; }
printf '%s\\n' "$*" >>"$GUM_LOG"
`;

const SCRIPT = join(import.meta.dir, "wt-pr");
const STUBS: Record<string, string> = {
  gh: GH_STUB,
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
  sandbox = mkdtempSync(join(tmpdir(), "wt-pr-"));
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
    GH_LOG: join(sandbox, "gh.log"),
    GH_MINE: join(sandbox, "mine.json"),
    GH_REVIEW: join(sandbox, "review.json"),
    FZF_STDIN: join(sandbox, "fzf.stdin"),
    CLONE_LOG: join(sandbox, "clone.log"),
    WT_LOG: join(sandbox, "wt.log"),
    GUM_LOG: join(sandbox, "gum.log"),
  };

  for (const log of ["GH_LOG", "CLONE_LOG", "WT_LOG", "GUM_LOG"]) {
    writeFileSync(variables[log] as string, "");
  }
  results("GH_MINE", []);
  results("GH_REVIEW", []);

  proveStubs();
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

// The PATH these cases hand the script is their whole isolation. A stub that
// did not shadow its real binary would let a case reach GitHub, open a picker
// on the terminal, or clone a repository and still look like it passed.
function proveStubs(): void {
  for (const name of Object.keys(STUBS)) {
    const run = Bun.spawnSync({ cmd: [name, "--stub-check"], env: { PATH: path }, stdin: "ignore" });
    const said = run.stdout.toString().trim();
    if (said !== `${name} stub`) {
      throw new Error(`the ${name} stub is not on PATH: --stub-check said ${JSON.stringify(said)}`);
    }
  }
}

interface PullRequest {
  number: number;
  title: string;
  project: string;
}

function results(name: "GH_MINE" | "GH_REVIEW", pulls: PullRequest[]): void {
  const entries = pulls.map((pull) => ({
    number: pull.number,
    title: pull.title,
    repository: { nameWithOwner: pull.project },
    url: `https://github.com/${pull.project}/pull/${pull.number}`,
  }));
  writeFileSync(variables[name] as string, JSON.stringify(entries));
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

function log(name: "GH_LOG" | "FZF_STDIN" | "CLONE_LOG" | "WT_LOG" | "GUM_LOG"): string {
  const file = variables[name] as string;
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

test("prints the usage on --help", () => {
  const outcome = run(["--help"]);
  expect(outcome.status).toBe(0);
  expect(outcome.stdout).toStartWith("usage: wt pr [--mine|--review]");
  expect(log("GH_LOG")).toBe("");
});

test("refuses --mine and --review together", () => {
  const outcome = run(["--mine", "--review"]);
  expect(outcome.status).toBe(2);
  expect(outcome.stderr).toStartWith("wt pr: --mine and --review select opposite halves\n");
  expect(log("GH_LOG")).toBe("");
});

test("names a tool it needs and cannot find", () => {
  rmSync(join(stubs, "clone-repo"));

  expect(run([]).status).toBe(1);
  expect(log("GUM_LOG")).toBe("log --level error clone-repo is required\n");
  expect(log("GH_LOG")).toBe("");
});

test("switches to the pull request that was picked", () => {
  results("GH_MINE", [{ number: 2, title: "a change", project: "owner/repo" }]);

  const outcome = run(["-x", "claude"], { FZF_PICK: "1" });
  expect(outcome.status).toBe(0);
  expect(log("FZF_STDIN")).toBe(
    "mine\towner/repo#2\ta change\thttps://github.com/owner/repo/pull/2\towner/repo\n",
  );
  expect(log("CLONE_LOG")).toBe("owner/repo\n");
  expect(log("WT_LOG")).toBe(
    "-C /checkouts/repo switch https://github.com/owner/repo/pull/2 -x claude\n",
  );
});

test("asks for both halves and shows them in one picker", () => {
  results("GH_MINE", [{ number: 5, title: "mine", project: "owner/repo" }]);
  results("GH_REVIEW", [{ number: 1, title: "theirs", project: "other/repo" }]);

  run([], { FZF_PICK: "1" });
  expect(log("GH_LOG")).toBe(
    [
      "search prs --state=open --author=@me --limit 50 --json number,title,repository,url",
      "search prs --state=open --review-requested=@me --limit 50 --json number,title,repository,url",
      "",
    ].join("\n"),
  );
  expect(log("FZF_STDIN").split("\n").filter(Boolean).map((row) => row.split("\t")[1])).toEqual([
    "owner/repo#5",
    "other/repo#1",
  ]);
});

test("--mine leaves the review query unasked", () => {
  results("GH_MINE", [{ number: 5, title: "mine", project: "owner/repo" }]);

  run(["--mine"], { FZF_PICK: "1" });
  expect(log("GH_LOG")).not.toContain("--review-requested");
});

// A pull request you authored and were also asked to review is one pull
// request, and the authored bucket is the one that describes it.
test("shows a pull request in both halves once", () => {
  results("GH_MINE", [{ number: 5, title: "mine", project: "owner/repo" }]);
  results("GH_REVIEW", [{ number: 5, title: "mine", project: "owner/repo" }]);

  run([], { FZF_PICK: "1" });
  expect(log("FZF_STDIN")).toBe(
    "mine\towner/repo#5\tmine\thttps://github.com/owner/repo/pull/5\towner/repo\n",
  );
});

// A failed query is not an empty result set. Showing the picker here would put
// half of what is waiting on you on screen as the whole of it.
test("stops on a query gh could not answer", () => {
  rmSync(variables.GH_MINE as string);

  expect(run([]).status).toBe(1);
  expect(log("GUM_LOG")).toBe("log --level error gh search prs --author=@me failed\n");
  expect(log("FZF_STDIN")).toBe("");
});

test("says so when nothing is open", () => {
  expect(run([]).status).toBe(1);
  expect(log("GUM_LOG")).toBe("log --level warn no open pull requests\n");
  expect(log("FZF_STDIN")).toBe("");
});

test("switches nowhere when the picker is dismissed", () => {
  results("GH_MINE", [{ number: 2, title: "a change", project: "owner/repo" }]);

  expect(run([]).status).toBe(1);
  expect(log("CLONE_LOG")).toBe("");
  expect(log("WT_LOG")).toBe("");
});
