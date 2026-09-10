import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { repoRoot, run, sandbox, type Sandbox } from "#harness";
import { launcherContract } from "#harness/launchers";

const launcher = join(repoRoot, "herdr", "bin", "herdr-preview");

let box: Sandbox;

beforeEach(() => {
  box = sandbox("herdr-preview");
});

afterEach(() => {
  box.remove();
});

launcherContract("herdr", "herdr-preview");

function stubHerdr(body: string): void {
  box.stub("herdr", `echo "$*" >> ${box.path("calls")}\n${body}`);
}

const log = () => box.read("calls").trim().split("\n").filter(Boolean);

// Sessions are rooted under XDG_CONFIG_HOME, so pointing it at the sandbox is
// what keeps a test off the live session directory and its running sockets.

// A herdr whose `server` binds the session socket the way the real one does, so
// `start` gets past the readiness wait and on to the pane it is filling.
function stubHerdrThatStarts({ freePane = false } = {}): void {
  const busy = `{"result":{"process_info":{"foreground_processes":[{"name":"herdr"}]}}}`;
  const free = `{"result":{"process_info":{"foreground_processes":[]}}}`;
  box.stub(
    "herdr",
    `echo "$*" >> ${box.path("calls")}
case "$1" in
server)
  dir="$XDG_CONFIG_HOME/herdr/sessions/$HERDR_SESSION"
  mkdir -p "$dir"
  python3 -c 'import socket,sys
s = socket.socket(socket.AF_UNIX)
s.bind(sys.argv[1])' "$dir/herdr.sock"
  sleep 3
  ;;
tab) echo '{"result":{"root_pane":{"pane_id":"w9:p2"}}}' ;;
pane)
  case "$2" in
  process-info) ${freePane ? `if [ -f ${box.path("launched")} ]; then echo '${busy}'; else echo '${free}'; fi` : `echo '${busy}'`} ;;
  run) : > ${box.path("launched")} ;;
  esac
  ;;
esac
exit 0`,
  );
}

const preview = (args: string[], env: Record<string, string | undefined> = {}) =>
  run(["bash", launcher, ...args], {
    path: [box.bin],
    env: { XDG_CONFIG_HOME: box.mkdir("config"), ...env },
  });

test("refuses without herdr on PATH", () => {
  const r = run(["bash", launcher, "start"], { onlyPath: ["/usr/bin", "/bin"] });
  expect(r.status).not.toBe(0);
  expect(r.stdout + r.stderr).toContain("not on PATH");
});

// `herdr config check` answers `config: ok` for a path that does not exist, so
// a typo in --config would otherwise buy a green light and a server running
// stock defaults.
test("rejects a config path that does not exist", () => {
  stubHerdr("exit 0");
  const r = preview(["start", "--config", box.path("absent.toml")]);
  expect(r.status).not.toBe(0);
  expect(r.stdout + r.stderr).toContain("no config at");
  expect(log().some((c) => c.startsWith("server"))).toBe(false);
});

test("rejects a config herdr will not accept", () => {
  box.write("bad.toml", 'onboarding = false\n[ui]\nagent_panel_sort = "nope"\n');
  stubHerdr(`[ "$1 $2" = "config check" ] && { echo "unknown variant \\\`nope\\\`"; exit 1; }\nexit 0`);
  const r = preview(["start", "--config", box.path("bad.toml")]);
  expect(r.status).not.toBe(0);
  expect(r.stdout + r.stderr).toContain("unknown variant");
  expect(log().some((c) => c.startsWith("server"))).toBe(false);
});

// The config check is what makes a preview trustworthy, and it only reads the
// file named by HERDR_CONFIG_PATH. Checking the installed config instead would
// pass while previewing something else entirely.
test("points the config check at the file it is about to preview", () => {
  box.write("mine.toml", "onboarding = false\n");
  stubHerdr(
    `[ "$1 $2" = "config check" ] && { echo "$HERDR_CONFIG_PATH" > ${box.path("checked")}; exit 0; }\nexit 1`,
  );
  preview(["start", "--config", box.path("mine.toml")]);
  expect(box.read("checked").trim()).toBe(box.path("mine.toml"));
});

// `tab create` with no --workspace resolves to the UI-focused workspace, which
// belongs to whoever last touched the keyboard. An unattended run planted its
// tab in another agent's workspace before this was pinned.
test("creates its tab in the calling workspace, not the focused one", () => {
  box.write("ok.toml", "onboarding = false\n");
  stubHerdrThatStarts();
  preview(["start", "--config", box.path("ok.toml")], { HERDR_WORKSPACE_ID: "wZZ" });
  expect(log().join("\n")).toContain("--workspace wZZ");
});

test("uses the pane it was handed instead of creating a tab", () => {
  box.write("ok.toml", "onboarding = false\n");
  stubHerdrThatStarts({ freePane: true });
  preview(["start", "--config", box.path("ok.toml"), "--pane", "w9:p7"], {
    HERDR_WORKSPACE_ID: "wZZ",
  });
  const calls = log();
  expect(calls.some((c) => c.startsWith("tab create"))).toBe(false);
  expect(calls.some((c) => c.startsWith("pane run w9:p7"))).toBe(true);
});

test("refuses to guess a workspace when it is not running in a herdr pane", () => {
  box.write("ok.toml", "onboarding = false\n");
  stubHerdr(`case "$1 $2" in
"config check") exit 0 ;;
"tab create") echo '{"result":{"root_pane":{"pane_id":"w9:p2"}}}' ;;
*) exit 0 ;;
esac`);
  const r = preview(["start", "--config", box.path("ok.toml")], { HERDR_WORKSPACE_ID: undefined });
  expect(r.stdout + r.stderr).toContain("HERDR_WORKSPACE_ID");
  expect(log().some((c) => c.startsWith("tab create"))).toBe(false);
});

// The server inherits the calling pane's environment. HERDR_SOCKET_PATH is the
// one that matters: left set, every command the preview runs would drive the
// live server instead.
test("clears the inherited herdr environment before starting the server", () => {
  const script = run(["bash", "-c", `grep -n 'herdr server' -B4 ${launcher}`]).stdout;
  for (const name of [
    "HERDR_ENV",
    "HERDR_PANE_ID",
    "HERDR_TAB_ID",
    "HERDR_WORKSPACE_ID",
    "HERDR_SOCKET_PATH",
  ]) {
    expect(script).toContain(`-u ${name}`);
  }
});

// `pane run` hands its string to the pane's interactive shell, which expands
// aliases. colors/grc.zsh aliases `env`, so an inline `env -u ... herdr` became
// `grc --colour=auto env ...` and the client rendered into a pipe instead of
// the tty. Running a file is what keeps the shell out of it.
test("launches the client through a file rather than an alias-expanded string", () => {
  const script = run(["bash", "-c", `grep -n 'pane run' ${launcher}`]).stdout;
  expect(script).toContain("bash $launcher");
  expect(script).not.toContain("env -u");
});

// Against a pane already holding a TUI, `pane run` types into that TUI and
// reports success, so a relaunch reads as a client that started and did
// nothing.
test("refuses a pane that is already running something", () => {
  box.write("ok.toml", "onboarding = false\n");
  stubHerdr(`case "$1 $2" in
"config check") exit 0 ;;
"pane process-info") echo '{"result":{"process_info":{"foreground_processes":[{"name":"nvim"}]}}}' ;;
*) exit 0 ;;
esac`);
  const r = preview(["start", "--config", box.path("ok.toml"), "--pane", "w9:p2"], { HERDR_WORKSPACE_ID: "wZZ" });
  expect(r.stdout + r.stderr).toContain("already running something");
  expect(log().some((c) => c.startsWith("pane run"))).toBe(false);
});

// Every runtime path hangs off the session name, which is what keeps the
// preview off the live server's socket.
test("roots the socket under the named session", () => {
  stubHerdr("exit 0");
  const r = preview(["socket", "--session", "scratch"]);
  expect(r.stdout.trim()).toBe(`${box.path("config")}/herdr/sessions/scratch/herdr.sock`);
});

// A preview left running holds a server and a tab. Stop has to reach both, and
// delete the saved shape so the next start is empty rather than a replay.
test("stop closes the pane, stops the server, and deletes the saved session", () => {
  stubHerdr(`case "$1 $2" in
"api snapshot") echo '{"result":{"snapshot":{"tabs":[{"tab_id":"w9:t2","label":"herdr-preview:preview"}],"panes":[{"pane_id":"w9:p2","tab_id":"w9:t2"}]}}}' ;;
"pane get") echo '{"result":{"pane":{"tab_id":"w9:t2"}}}' ;;
*) exit 0 ;;
esac`);
  const r = preview(["stop"]);
  expect(r.status).toBe(0);
  const calls = log();
  expect(calls.some((c) => c.startsWith("tab close w9:t2"))).toBe(true);
  expect(calls.some((c) => c.startsWith("session delete preview"))).toBe(true);
});

// The server resolves a bare tab bar command against its own PATH, which is
// the installed copy. A preview of a config whose tokens come from a script
// under test would render those rows bare, which reads as a config bug.
test("repoints a bare command naming a repo script at the worktree copy", () => {
  const config = box.write("c.toml", 'tab_bar_right = [{ command = "herdr-workspace-status" }]\n');
  stubHerdrThatStarts();
  const r = preview(["start", "--config", config], { HERDR_WORKSPACE_ID: "wZZ" });
  expect(r.stderr).toContain("pointed herdr-workspace-status at the worktree copy");
  const derived = box.read("config/herdr/sessions/preview/config.toml");
  expect(derived).toContain(`command = "${join(repoRoot, "herdr", "bin", "herdr-workspace-status")}"`);
});

test("leaves a command that is not a repo script alone", () => {
  const config = box.write("c.toml", 'tab_bar_right = [{ command = "date" }]\n');
  stubHerdrThatStarts();
  preview(["start", "--config", config], { HERDR_WORKSPACE_ID: "wZZ" });
  expect(box.read("config/herdr/sessions/preview/config.toml")).toContain('command = "date"');
});

// A client that attached can still be painting the workspace list it started
// with. Handing that pane back has an agent read a stale screen and believe it.
test("fails when the client never renders live state", () => {
  box.write("ok.toml", "onboarding = false\n");
  box.stub(
    "herdr",
    `echo "$*" >> ${box.path("calls")}
case "$1 $2" in
"pane wait-output") exit 1 ;;
"tab create") echo '{"result":{"root_pane":{"pane_id":"w9:p2"}}}' ;;
esac
exit 0`,
  );
  const r = preview(["start", "--config", box.path("ok.toml")], { HERDR_WORKSPACE_ID: "wZZ" });
  expect(r.status).not.toBe(0);
  expect(r.stdout + r.stderr).toContain("not live");
});

// The name is a path segment before herdr sees it, so `--session ..` would put
// the derived config on ~/.config/herdr/config.toml, the symlink to the
// tracked one.
test("refuses a session name that would escape the sessions directory", () => {
  stubHerdr("exit 0");
  for (const name of ["..", "../elsewhere", 'x"; touch /tmp/pwn; #']) {
    const r = preview(["start", "--session", name]);
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toContain("session name takes letters");
  }
  expect(log()).toEqual([]);
});

// A shell that ran the documented `export HERDR_SOCKET_PATH=$(... socket)` has
// to keep working: the client's tab lives in the calling session, not the
// preview, so read must not ask the preview about it.
test("finds the client pane with a preview socket exported", () => {
  stubHerdr(`case "$1 $2" in
"api snapshot")
  [ -n "\${HERDR_SOCKET_PATH:-}" ] && exit 1
  echo '{"result":{"snapshot":{"tabs":[{"tab_id":"w9:t2","label":"herdr-preview:preview"}],"panes":[{"pane_id":"w9:p2","tab_id":"w9:t2"}]}}}' ;;
*) exit 0 ;;
esac`);
  const r = preview(["read"], {
    HERDR_SOCKET_PATH: `${box.path("config")}/herdr/sessions/preview/herdr.sock`,
  });
  expect(r.status).toBe(0);
  expect(log().some((c) => c.startsWith("pane read w9:p2"))).toBe(true);
});

// A start that gets the server up and then fails leaves a live server holding
// the socket and a tab in the user's workspace, and the next start refuses
// against a preview nobody can see.
test("tears down the server and its own tab when the client never goes live", () => {
  box.write("ok.toml", "onboarding = false\n");
  stubHerdr(`case "$1 $2" in
"pane wait-output") exit 1 ;;
"tab create") echo '{"result":{"root_pane":{"pane_id":"w9:p2"}}}' ;;
"pane get") echo '{"result":{"pane":{"tab_id":"w9:t2"}}}' ;;
esac
exit 0`);
  const r = preview(["start", "--config", box.path("ok.toml")], { HERDR_WORKSPACE_ID: "wZZ" });
  expect(r.status).not.toBe(0);
  const calls = log();
  expect(calls.some((c) => c.startsWith("tab close w9:t2"))).toBe(true);
  expect(calls.some((c) => c.startsWith("server stop"))).toBe(true);
  expect(calls.some((c) => c.startsWith("session delete preview"))).toBe(true);
});

// A pane the caller handed in is theirs, so a failed start must not close it.
test("leaves a handed-in pane open when the start fails", () => {
  box.write("ok.toml", "onboarding = false\n");
  stubHerdr(`case "$1 $2" in
"pane wait-output") exit 1 ;;
"pane process-info") echo '{"result":{"process_info":{"foreground_processes":[]}}}' ;;
esac
exit 0`);
  const r = preview(["start", "--config", box.path("ok.toml"), "--pane", "w9:p7"]);
  expect(r.status).not.toBe(0);
  expect(log().some((c) => c.startsWith("tab close") || c.startsWith("pane close"))).toBe(false);
  expect(log().some((c) => c.startsWith("server stop"))).toBe(true);
});

// `pane run` against a pane that went away reports failure, and swallowing it
// would hand back a pane id for a client that never started.
test("reports a client launch that the server refused", () => {
  box.write("ok.toml", "onboarding = false\n");
  stubHerdr(`case "$1 $2" in
"pane run") exit 1 ;;
"tab create") echo '{"result":{"root_pane":{"pane_id":"w9:p2"}}}' ;;
"pane get") echo '{"result":{"pane":{"tab_id":"w9:t2"}}}' ;;
esac
exit 0`);
  const r = preview(["start", "--config", box.path("ok.toml")], { HERDR_WORKSPACE_ID: "wZZ" });
  expect(r.status).not.toBe(0);
  expect(r.stdout + r.stderr).toContain("could not launch the client");
  expect(log().some((c) => c.startsWith("server stop"))).toBe(true);
});

// A start that crashed leaves its ready workspace in the saved session, and a
// client replaying that state would render the label off its startup list. The
// label has to be one only this run could have created.
test("waits on a ready label unique to the run", () => {
  box.write("ok.toml", "onboarding = false\n");
  stubHerdrThatStarts();
  preview(["start", "--config", box.path("ok.toml")], { HERDR_WORKSPACE_ID: "wZZ" });
  const waits = log().filter((c) => c.startsWith("pane wait-output"));
  expect(waits.length).toBe(1);
  expect(waits[0]).toMatch(/--match preview-ready-\d+\b/);
});
