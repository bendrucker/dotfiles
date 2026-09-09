import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { skipMessage } from "#jobs/sync-gate";
import {
  credentialFindings,
  currentRevision,
  driftFingerprint,
  logExcerpt,
  syncFingerprint,
  tailLines,
} from "./dotfiles-upgrade";

const ESC = "\u001b";

describe("tailLines", () => {
  const numbered = (count: number): string =>
    `${Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n")}\n`;

  test("keeps only the last lines of a log longer than the count", () => {
    const kept = tailLines(numbered(153), 100).split("\n");
    expect(kept.length).toBe(100);
    expect(kept[0]).toBe("line 54");
    expect(kept.at(-1)).toBe("line 153");
  });

  test("keeps a log shorter than the count whole", () => {
    expect(tailLines("one\ntwo\n", 100)).toBe("one\ntwo");
  });

  // The newline a log ends with terminates its last line. Counting it as a line
  // of its own costs a line of the tail and leaves the excerpt one short.
  test("reads the terminating newline as part of the last line", () => {
    expect(tailLines("first\nsecond\n", 1)).toBe("second");
  });

  test("keeps a last line that has no terminating newline", () => {
    expect(tailLines("first\nsecond", 1)).toBe("second");
  });
});

describe("logExcerpt", () => {
  test("strips the colour escapes the child tools write", () => {
    expect(logExcerpt(`${ESC}[31mfatal${ESC}[0m: could not read\n`)).toBe(
      "fatal: could not read",
    );
  });

  test("strips a cursor-positioning escape", () => {
    expect(logExcerpt(`${ESC}[2K${ESC}[1Gprogress\n`)).toBe("progress");
  });

  // An OSC sequence carries the title text a reader may want, and it does not
  // end in a letter, so the CSI pattern would take an arbitrary bite out of it.
  test("leaves an OSC title sequence alone", () => {
    const osc = `${ESC}]0;installing${ESC}done`;
    expect(logExcerpt(`${osc}\n`)).toBe(osc);
  });

  // The note's closing fence sits directly after the last log line.
  test("drops the trailing blank lines a step leaves behind", () => {
    expect(logExcerpt("done\n\n\n")).toBe("done");
  });
});

describe("credentialFindings", () => {
  const report = [
    "~/.npmrc               plaintext    put it in 1Password, then: credential-audit --adopt",
    "~/.ssh/id_ed25519.bak  passphrased  Secretive holds the working keys",
  ].join("\n");

  test("takes the subject and verdict out of an aligned report", () => {
    expect(credentialFindings(report).standing).toEqual([
      { subject: "~/.npmrc", verdict: "plaintext" },
      { subject: "~/.ssh/id_ed25519.bak", verdict: "passphrased" },
    ]);
  });

  // A verdict that moves is a different finding, so a key that loses its
  // passphrase reopens the to-do rather than sitting under the old one.
  test("reads a changed verdict on the same subject as a different finding", () => {
    const [before] = credentialFindings("~/.ssh/id_rsa  passphrased  x").standing;
    const [after] = credentialFindings("~/.ssh/id_rsa  unencrypted  x").standing;
    expect(before).not.toEqual(after);
  });

  test("holds a subject it could not read rather than standing it", () => {
    const findings = credentialFindings("~/.npmrc  unreadable  could not be read this run");
    expect(findings.standing).toEqual([]);
    expect(findings.held).toEqual(["~/.npmrc"]);
  });

  test("reads a clean run as nothing standing", () => {
    expect(credentialFindings("")).toEqual({ standing: [], held: [] });
  });

  // ~/.ssh is globbed, so whatever a key is named reaches the report. Each of
  // these defeats one of the two signals on its own: the doubled space matches
  // a column gap, and "open" matches a verdict.
  test.each<{ name: string; line: string; subject: string }>([
    { name: "a single space", line: "~/.ssh/old key.pem  unencrypted  move it", subject: "~/.ssh/old key.pem" },
    { name: "two spaces", line: "~/.ssh/old  key.pem  unencrypted  move it", subject: "~/.ssh/old  key.pem" },
    { name: "a word that is also a verdict", line: "~/.ssh/my open key.pem  unencrypted  move it", subject: "~/.ssh/my open key.pem" },
  ])("keeps a subject carrying $name whole", ({ line, subject }) => {
    expect(credentialFindings(line).standing).toEqual([{ subject, verdict: "unencrypted" }]);
  });
});

describe("driftFingerprint", () => {
  // The latch stores this verbatim, so the encoding is what every standing
  // to-do was filed under. Changing it refiles all of them once.
  test("joins the listing with single spaces and a trailing one", () => {
    expect(driftFingerprint("brew 'cmake'\ncask 'figma'")).toBe("brew 'cmake' cask 'figma' ");
  });

  test("gives a single entry the same trailing space", () => {
    expect(driftFingerprint("brew 'cmake'")).toBe("brew 'cmake' ");
  });

  // Homebrew orders the listing by a dependency sort taken over every installed
  // package, so installing something unrelated and declared reshuffles the
  // undeclared names without changing the set.
  test("reads the same set in another order as the same finding", () => {
    expect(driftFingerprint("cask 'figma'\nbrew 'cmake'")).toBe(
      driftFingerprint("brew 'cmake'\ncask 'figma'"),
    );
  });

  test("reads a set that gained a member as a different finding", () => {
    expect(driftFingerprint("brew 'cmake'\ncask 'figma'")).not.toBe(
      driftFingerprint("brew 'cmake'"),
    );
  });

  // `sort` collated by the ambient locale, so the nightly job (which inherits no
  // LANG) and a hand run in Terminal computed different keys for a listing whose
  // lines differ only in case, and each refiled what the other had already filed.
  // A Mac App Store entry is the one kind that carries capitals.
  test("orders by code unit rather than by locale collation", () => {
    expect(driftFingerprint("mas 'iMovie', id: 1\nmas 'Xcode', id: 2")).toBe(
      "mas 'Xcode', id: 2 mas 'iMovie', id: 1 ",
    );
  });

  // The latch keys on this. A fingerprint carrying anything that moves on its
  // own refiles the same untouched to-do every night, which has happened twice
  // in this repo through a version number joined into the key.
  test("carries nothing but the lines of the listing", () => {
    expect(driftFingerprint("cask 'figma'\nbrew 'cmake'")).toBe("brew 'cmake' cask 'figma' ");
  });
});

const SCRIPT = join(import.meta.dir, "dotfiles-upgrade");
const REAL_PATH = process.env.PATH ?? "";
const GIT = Bun.which("git", { PATH: REAL_PATH });
// $PATH holds nothing but the stub directory, so the real utilities the
// wrapper and the stubs shell out to have to be linked into it: bin/spin
// resolves scripts/shell/spin.sh through `dirname`, and the stubs print their
// fixtures with `cat`. Neither touches anything outside the sandbox.
const UTILITIES = ["dirname", "cat"].map(
  (name) => Bun.which(name, { PATH: REAL_PATH }) ?? join("/usr/bin", name),
);

// `gum log … msg` echoes msg to stderr, where the real gum writes it.
const GUM_STUB = `#!/bin/sh
case "$1" in
  spin)
    shift
    while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done
    [ "$1" = "--" ] && shift
    exec "$@"
    ;;
  log)
    shift
    while [ "$#" -gt 1 ]; do shift; done
    printf '%s\\n' "$1" >&2
    ;;
esac
`;

let sandbox: string;
let stubs: string;
let home: string;
let state: string;
let opened: string;

function writeExecutable(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

function stub(name: string, body: string): void {
  writeExecutable(join(stubs, name), body);
}

function syncStub(body: string): void {
  writeExecutable(join(home, "bin", "dotfiles-sync"), body);
}

function installStub(body: string): void {
  writeExecutable(join(home, "scripts", "install"), body);
}

function driftStub(body: string): void {
  writeExecutable(join(home, "scripts", "brew-drift"), body);
}

interface Run {
  status: number;
  stdout: string;
  stderr: string;
}

function runUpgrade(options: { path?: string; args?: string[] } = {}) {
  const result = Bun.spawnSync({
    cmd: [process.execPath, SCRIPT, ...(options.args ?? [])],
    env: {
      ...process.env,
      PATH: options.path ?? stubs,
      DOTFILES_HOME: home,
      XDG_STATE_HOME: state,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    status: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  } satisfies Run;
}

// report_failure files the to-do by handing a things:/// URL to `open`. The stub
// records it rather than launching Things.
function filedTodos(): string[] {
  try {
    return readFileSync(opened, "utf8")
      .split("\n")
      .filter((line) => line.includes("things:///add"));
  } catch {
    return [];
  }
}

// URL.searchParams would read a `+` in a cask token as a space, and Homebrew
// allows one.
function field(url: string, name: string): string {
  const match = url.match(new RegExp(`[?&]${name}=([^&]*)`));
  return match ? decodeURIComponent(match[1]) : "";
}

function latch(job: string): string {
  try {
    return readFileSync(join(state, "dotfiles", `${job}.status`), "utf8");
  } catch {
    return "";
  }
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "dotfiles-upgrade-"));
  stubs = join(sandbox, "stub");
  home = join(sandbox, "dotfiles");
  state = join(sandbox, "state");
  opened = join(sandbox, "opened");
  mkdirSync(stubs);
  mkdirSync(join(home, "bin"), { recursive: true });
  mkdirSync(join(home, "scripts"), { recursive: true });
  mkdirSync(state);

  for (const utility of UTILITIES) symlinkSync(utility, join(stubs, basename(utility)));

  stub("gum", GUM_STUB);
  stub("open", `#!/bin/sh\nprintf '%s\\n' "$1" >> '${opened}'\n`);
  stub("osascript", "#!/bin/sh\nexit 0\n");
  // Unstubbed, a `brew cleanup` here runs against this machine's Homebrew cache.
  stub("brew", "#!/bin/sh\nexit 0\n");

  syncStub("#!/bin/sh\nexit 0\n");
  installStub("#!/bin/sh\nexit 0\n");
  driftStub("#!/bin/sh\nexit 0\n");
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe("syncFingerprint", () => {
  // The wording and the pattern that reads it back are exported together from
  // the gate. This is what holds them together: reword one without the other
  // and the fingerprint silently flattens to "sync" again, which is the silence
  // the escalation exists to break.
  test("matches the line the gate actually logs", () => {
    expect(syncFingerprint(`WARN ${skipMessage(4)}`)).toBe("sync Sync skipped 4 runs in a row");
  });

  // The gate prints the dirty tree's diff to the stream this reads, and the
  // phrase is tracked text in this repo, so an uncommitted edit to a test file
  // that carries it would otherwise forge an escalation out of diff content.
  test("ignores the phrase outside a WARN line the gate logged", () => {
    const diff = [
      "ERRO Local changes present - skipping sync",
      "+++ b/bin/dotfiles-upgrade.test.ts",
      `+    skipped('echo "WARN ${skipMessage(2)}" >&2\\n');`,
    ].join("\n");

    expect(syncFingerprint(diff)).toBe("sync");
  });
});

describe("the sync step", () => {
  const FAILING_SYNC = '#!/bin/sh\necho "fatal: could not read from remote" >&2\nexit 1\n';

  // Regression: a failing sync used to log and exit 1 with no report, so an
  // unattended failure surfaced only as a notification banner that fires at 3am
  // and is gone before anyone looks.
  test("files a to-do when the sync fails", () => {
    syncStub(FAILING_SYNC);

    const run = runUpgrade();
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("sync failed");
    expect(filedTodos().length).toBe(1);
  });

  // The to-do carries the sync's own output, which is the part worth reading the
  // next morning, and the sync writes its failure to stderr.
  test("names the sync and carries its output", () => {
    syncStub(FAILING_SYNC);

    const run = runUpgrade();
    const [todo] = filedTodos();
    expect(field(todo, "title")).toBe("Dotfiles sync failed");
    expect(field(todo, "notes")).toContain("could not read from remote");
    expect(field(todo, "notes")).toContain("dotfiles-sync");
    expect(run.stdout).toContain("could not read from remote");
  });

  // The latch keeps a job that stays broken from filing a fresh to-do every
  // night.
  test("stays quiet while the sync keeps failing", () => {
    syncStub(FAILING_SYNC);
    runUpgrade();

    const run = runUpgrade();
    expect(run.status).toBe(1);
    expect(filedTodos().length).toBe(1);
    expect(run.stderr).toContain("to-do already filed");
  });

  // The gate logs the unattended skips in a row from the second on, at the power of two below the count.
  test("files again as the skipped syncs mount", () => {
    const skipped = (escalation: string): void =>
      syncStub(
        `#!/bin/sh\necho "ERRO Local changes present - skipping sync" >&2\n${escalation}exit 1\n`,
      );
    skipped("");
    runUpgrade();
    skipped('echo "WARN Sync skipped 2 runs in a row" >&2\n');
    runUpgrade();
    runUpgrade();
    skipped('echo "WARN Sync skipped 4 runs in a row" >&2\n');
    runUpgrade();

    expect(filedTodos().length).toBe(3);
  });

  // The latch records which step broke. Sharing one value between the two steps
  // let a sync failure silence the install failure that followed it, and the run
  // exits before it can ever clear the latch.
  test("files a fresh to-do when the break moves to the install", () => {
    syncStub(FAILING_SYNC);
    runUpgrade();

    syncStub("#!/bin/sh\nexit 0\n");
    installStub("#!/bin/sh\necho 'symlink target is a directory' >&2\nexit 1\n");

    const run = runUpgrade();
    expect(run.status).toBe(1);
    const todos = filedTodos();
    expect(todos.length).toBe(2);
    expect(field(todos[1], "title")).toBe("Dotfiles install failed");
  });

  // The step title rides into the captured log, because the redirection that
  // captures the sync predates the pipe spin's own log line goes down.
  test("carries the step title into the job's stdout", () => {
    syncStub(FAILING_SYNC);

    const run = runUpgrade();
    expect(run.stdout).toContain("Syncing dotfiles");
  });

  // An install run on top of a failed sync installs from a stale tree.
  test("runs nothing after a failed sync", () => {
    syncStub(FAILING_SYNC);
    const marker = join(sandbox, "installed");
    installStub(`#!/bin/sh\n: > '${marker}'\n`);
    driftStub(`#!/bin/sh\n: > '${join(sandbox, "drifted")}'\n`);

    runUpgrade();
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(sandbox, "drifted"))).toBe(false);
  });

  // A failure ends at the end of its log, and Things drops a note past 10,000
  // characters from the tail, which is the wrong end to lose.
  test("carries the end of a long log and none of the escapes in it", () => {
    const lines = Array.from({ length: 153 }, (_, index) => `${ESC}[32mstep ${index + 1}${ESC}[0m`);
    syncStub(`#!/bin/sh\ncat <<'LOG' >&2\n${lines.join("\n")}\nLOG\nexit 1\n`);

    runUpgrade();
    const notes = field(filedTodos()[0], "notes");
    expect(notes).toContain("step 153");
    expect(notes).toContain("step 54");
    expect(notes).not.toContain("step 53");
    expect(notes).not.toContain(ESC);
  });

  test("reads a sync that cannot be run as a failed sync", () => {
    rmSync(join(home, "bin", "dotfiles-sync"));

    const run = runUpgrade();
    expect(run.status).toBe(1);
    expect(filedTodos().length).toBe(1);
  });
});

describe("the install step", () => {
  const FAILING_INSTALL = "#!/bin/sh\necho 'mise install failed' >&2\nexit 1\n";

  // The reproduction command is the only instruction the morning reader gets.
  // `brew bundle` is the first of the installer's six steps, so a run failing at
  // symlinks, mise or a topic install.sh reproduces nothing from it.
  test("names the installer as the command that reproduces the failure", () => {
    installStub(FAILING_INSTALL);

    const run = runUpgrade();
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("install failed");
    const notes = field(filedTodos()[0], "notes");
    expect(notes).toContain(join(home, "scripts", "install"));
    expect(notes).toContain("mise install failed");
  });

  test("stops before brew cleanup and the drift check", () => {
    installStub(FAILING_INSTALL);
    stub("brew", `#!/bin/sh\n: > '${join(sandbox, "cleaned")}'\n`);
    driftStub(`#!/bin/sh\n: > '${join(sandbox, "drifted")}'\n`);

    runUpgrade();
    expect(existsSync(join(sandbox, "cleaned"))).toBe(false);
    expect(existsSync(join(sandbox, "drifted"))).toBe(false);
  });

  // The install's own log is what the to-do carries. The line naming the step is
  // written to the job's stderr and stays out of it.
  test("keeps the job's own progress line out of the to-do", () => {
    installStub(FAILING_INSTALL);

    const run = runUpgrade();
    expect(run.stderr).toContain("Running install");
    expect(field(filedTodos()[0], "notes")).not.toContain("Running install");
  });
});

describe("brew cleanup", () => {
  // Housekeeping after an install that already succeeded. Turning it into a
  // failure would file a to-do and abort the drift check for something that
  // broke nothing.
  test("warns and carries on when cleanup fails", () => {
    stub("brew", "#!/bin/sh\nexit 5\n");
    driftStub(`#!/bin/sh\n: > '${join(sandbox, "drifted")}'\n`);

    const run = runUpgrade();
    expect(run.status).toBe(0);
    expect(run.stderr).toContain("brew cleanup had issues");
    expect(filedTodos().length).toBe(0);
    expect(existsSync(join(sandbox, "drifted"))).toBe(true);
  });

  test("carries on when brew is not installed at all", () => {
    rmSync(join(stubs, "brew"));

    const run = runUpgrade();
    expect(run.status).toBe(0);
    expect(run.stderr).toContain("brew cleanup had issues");
  });
});

describe("the drift check", () => {
  function listing(text: string): void {
    driftStub(`#!/bin/sh\ncat <<'LISTING'\n${text}\nLISTING\n`);
  }

  test("files a to-do listing what no Brewfile declares", () => {
    listing("brew 'cmake'");

    const run = runUpgrade();
    expect(run.status).toBe(0);
    expect(run.stderr).toContain("undeclared packages installed");
    const [todo] = filedTodos();
    expect(field(todo, "title")).toBe("Undeclared Homebrew packages");
    expect(field(todo, "notes")).toContain("brew 'cmake'");
    expect(field(todo, "notes")).toContain("Undeclared Packages");
    expect(field(todo, "notes")).toContain(join(home, "scripts", "brew-drift"));
  });

  // Nothing is uninstalled, and a finding does not make the run a failure.
  test("stays quiet while the same packages stay undeclared", () => {
    listing("brew 'cmake'");
    runUpgrade();

    const run = runUpgrade();
    expect(run.status).toBe(0);
    expect(filedTodos().length).toBe(1);
    expect(run.stderr).toContain("to-do already filed");
  });

  // A plain latch would let the first standing finding suppress every finding
  // that appears after it, however long it stands.
  test("files a fresh to-do when a new package appears", () => {
    listing("brew 'cmake'");
    runUpgrade();

    listing("brew 'cmake'\ncask 'figma'");
    const run = runUpgrade();
    expect(run.status).toBe(0);
    const todos = filedTodos();
    expect(todos.length).toBe(2);
    expect(field(todos[1], "notes")).toContain("cask 'figma'");
  });

  test("stays quiet when the same packages come back in another order", () => {
    listing("brew 'cmake'\ncask 'figma'");
    runUpgrade();

    listing("cask 'figma'\nbrew 'cmake'");
    const run = runUpgrade();
    expect(run.status).toBe(0);
    expect(filedTodos().length).toBe(1);
    expect(run.stderr).toContain("to-do already filed");
  });

  test("latches on the sorted package set", () => {
    listing("cask 'figma'\nbrew 'cmake'");
    runUpgrade();

    expect(latch("brew-drift")).toBe("failed brew 'cmake' cask 'figma' \n");
  });

  // The to-do keeps Homebrew's own order, which is the order a reader sees when
  // they run the check by hand. Only the latch sorts.
  test("keeps the listing in the order the check printed it", () => {
    listing("cask 'figma'\nbrew 'cmake'");

    runUpgrade();
    expect(field(filedTodos()[0], "notes")).toContain("cask 'figma'\nbrew 'cmake'");
  });

  // Clearing the latch is the only thing that lets a finding that was fixed and
  // later recurs file again.
  test("files nothing and clears the latch when the machine matches the Brewfile", () => {
    listing("brew 'cmake'");
    runUpgrade();

    driftStub("#!/bin/sh\nexit 0\n");
    const run = runUpgrade();
    expect(run.status).toBe(0);
    expect(filedTodos().length).toBe(1);
    expect(latch("brew-drift")).toBe("ok\n");
  });

  // The check reads its listing back with the trailing newlines stripped, so a
  // run that printed nothing but blank lines has found nothing.
  test("treats a listing of only blank lines as clean", () => {
    driftStub("#!/bin/sh\nprintf '\\n\\n\\n'\n");

    const run = runUpgrade();
    expect(run.status).toBe(0);
    expect(filedTodos().length).toBe(0);
    expect(latch("brew-drift")).toBe("ok\n");
  });

  // The install has already succeeded by this point, so a drift check that
  // cannot run is worth a line in the log and nothing more. It must also leave
  // the latch where it was, or a standing finding would read as resolved.
  test("completes the run when the drift check cannot run", () => {
    listing("brew 'cmake'");
    runUpgrade();
    rmSync(join(home, "scripts", "brew-drift"));

    const run = runUpgrade();
    expect(run.status).toBe(0);
    expect(run.stderr).toContain("brew drift check could not run");
    expect(filedTodos().length).toBe(1);
    expect(latch("brew-drift")).toBe("failed brew 'cmake' \n");
  });

  // scripts/brew-drift says on stderr why it has nothing to report, and the
  // caller would file anything on stdout as a package listing.
  test("keeps the check's stderr out of the to-do", () => {
    driftStub("#!/bin/sh\necho 'cleanup produced no output' >&2\necho \"brew 'cmake'\"\n");

    const run = runUpgrade();
    expect(run.stderr).toContain("cleanup produced no output");
    expect(field(filedTodos()[0], "notes")).not.toContain("cleanup produced no output");
  });

  // The listing exists in the to-do. The launchd log gets the warning line only.
  test("does not print the listing it found", () => {
    listing("brew 'cmake'");

    const run = runUpgrade();
    expect(run.stdout).not.toContain("cmake");
    expect(run.stderr).not.toContain("cmake");
  });

  // Sharing the upgrade's job would let one latch suppress the other.
  test("files under its own job, leaving the upgrade latch clear", () => {
    listing("brew 'cmake'");

    runUpgrade();
    expect(latch("dotfiles-upgrade")).toBe("ok\n");
  });
});

describe("the run as a whole", () => {
  // Clearing this latch is what lets the next genuine failure file a to-do.
  test("clears the job latch and reports success", () => {
    const run = runUpgrade();
    expect(run.status).toBe(0);
    expect(run.stderr).toContain("All upgrades completed successfully");
    expect(latch("dotfiles-upgrade")).toBe("ok\n");
    expect(filedTodos().length).toBe(0);
  });

  // It passes none on to dotfiles-sync either, so the sync never takes its
  // --bootstrap path.
  test("ignores arguments", () => {
    syncStub(`#!/bin/sh\nprintf '%s\\n' "$@" > '${join(sandbox, "sync-args")}'\n`);

    const run = runUpgrade({ args: ["--bootstrap", "extra"] });
    expect(run.status).toBe(0);
    expect(readFileSync(join(sandbox, "sync-args"), "utf8")).toBe("\n");
  });

  test("upgrades ~/.dotfiles when DOTFILES_HOME is unset", () => {
    const defaultHome = join(sandbox, "default-home");
    mkdirSync(join(defaultHome, ".dotfiles", "bin"), { recursive: true });
    mkdirSync(join(defaultHome, ".dotfiles", "scripts"), { recursive: true });
    const marker = join(sandbox, "default-home-synced");
    writeExecutable(join(defaultHome, ".dotfiles", "bin", "dotfiles-sync"), `#!/bin/sh\n: > '${marker}'\n`);
    writeExecutable(join(defaultHome, ".dotfiles", "scripts", "install"), "#!/bin/sh\nexit 0\n");
    writeExecutable(join(defaultHome, ".dotfiles", "scripts", "brew-drift"), "#!/bin/sh\nexit 0\n");

    const result = Bun.spawnSync({
      cmd: [process.execPath, SCRIPT],
      env: { ...process.env, PATH: stubs, XDG_STATE_HOME: state, HOME: defaultHome, DOTFILES_HOME: "" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    expect(existsSync(marker)).toBe(true);
  });

  // report_failure writes the latch before it files, so a filing that dies leaves
  // a latch claiming a to-do that was never created. The status is the filer's,
  // not the 1 a reported failure carries, and nothing after it runs.
  test("carries the status of a refused filing and stops there", () => {
    syncStub("#!/bin/sh\nexit 1\n");
    stub("open", "#!/bin/sh\nexit 7\n");

    const run = runUpgrade();
    expect(run.status).toBe(7);
    expect(latch("dotfiles-upgrade")).toBe("failed sync\n");
  });

  test("stops a drift filing that is refused before clearing the upgrade latch", () => {
    driftStub("#!/bin/sh\necho \"brew 'cmake'\"\n");
    stub("open", "#!/bin/sh\nexit 7\n");

    const run = runUpgrade();
    expect(run.status).toBe(7);
    expect(latch("dotfiles-upgrade")).toBe("");
    expect(run.stderr).not.toContain("All upgrades completed successfully");
  });

  // gum is a declared dependency and the reporting library logs through it too,
  // so a machine that has lost it cannot file anything. The run ends before it
  // writes a latch claiming a to-do that was never created.
  test("exits without filing or latching when gum is missing", () => {
    syncStub("#!/bin/sh\nexit 1\n");
    rmSync(join(stubs, "gum"));

    const run = runUpgrade();
    expect(run.status).toBe(127);
    expect(filedTodos().length).toBe(0);
    expect(latch("dotfiles-upgrade")).toBe("");
  });

  test("names the revision the failure was taken at", () => {
    if (GIT === null) throw new Error("git is required to build the sandbox checkout");
    for (const args of [
      ["init", "--quiet"],
      ["-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "--allow-empty", "-m", "x"],
    ]) {
      Bun.spawnSync({
        cmd: [GIT, "-C", home, ...args],
        env: { ...process.env, HOME: sandbox, GIT_CONFIG_GLOBAL: "/dev/null" },
        stdout: "ignore",
        stderr: "ignore",
      });
    }
    const head = Bun.spawnSync({
      cmd: [GIT, "-C", home, "rev-parse", "--short", "HEAD"],
      env: process.env,
      stdout: "pipe",
    })
      .stdout.toString()
      .trim();
    // A checkout that failed to build leaves this empty, and every notes block
    // contains "**Revision:** " already, so the assertion below would hold
    // against the unknown fallback it is written to tell apart.
    expect(head).toMatch(/^[0-9a-f]{7,}$/);
    syncStub("#!/bin/sh\nexit 1\n");

    runUpgrade({ path: `${stubs}:${dirname(GIT)}` });
    expect(field(filedTodos()[0], "notes")).toContain(`**Revision:** ${head}`);
  });

  // A fresh machine has a tree that is not a checkout yet, and git's complaint
  // stays out of the launchd log.
  test("names the revision unknown outside a checkout", () => {
    syncStub("#!/bin/sh\nexit 1\n");

    const run = runUpgrade({ path: GIT === null ? stubs : `${stubs}:${dirname(GIT)}` });
    expect(field(filedTodos()[0], "notes")).toContain("**Revision:** unknown");
    expect(run.stderr).not.toContain("not a git repository");
  });
});

describe("currentRevision", () => {
  test("falls back to a literal where the tree is not a checkout", () => {
    expect(currentRevision(join(sandbox, "nowhere"))).toBe("unknown");
  });
});
