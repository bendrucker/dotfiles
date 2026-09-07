// Locks the guard around the Vibe Island preference write: it touches nothing on
// a machine without the app, it writes at most once so the nightly install does
// not rewrite a preference already set, and when the app is running it quits
// before writing and reopens after. Writing under a running app is what let the
// app put its own value back while this preference still read 0.
//
// Black-box: PATH-shim stubs for defaults, pgrep, osascript, open, sleep, and
// gum drive the real script, and VIBE_ISLAND_APP points at a fixture bundle so
// no real preference domain is read or written. Every stub appends to one log,
// so an example can assert on the order the script did things in.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { run, sandbox, type Run, type Sandbox } from "../scripts/lib/shell-fixtures.ts";

const script = join(import.meta.dir, "vibe-island.sh");

function stubActions(box: Sandbox): void {
  box.stub(
    "defaults",
    [
      'printf "%s\\n" "defaults $*" >>"$ACTION_LOG"',
      'case "$1" in',
      "  read)",
      '    value="$CURRENT_VALUE"',
      '    [ -f "$PREF_FILE" ] && value=$(cat "$PREF_FILE")',
      '    [ -n "$value" ] || exit 1',
      '    printf "%s\\n" "$value"',
      "    ;;",
      "  write)",
      '    [ -n "$WRITE_FAILS" ] && exit 1',
      '    case "${*: -1}" in',
      '      false) printf 0 >"$PREF_FILE" ;;',
      '      *)     printf 1 >"$PREF_FILE" ;;',
      "    esac",
      "    ;;",
      "esac",
      "exit 0",
    ].join("\n"),
    { shebang: "#!/usr/bin/env bash" },
  );

  box.stub("pgrep", ['[ -f "$QUIT_FLAG" ] && exit 1', '[ -n "$APP_RUNNING" ]'].join("\n"), {
    shebang: "#!/usr/bin/env bash",
  });

  box.stub(
    "osascript",
    ['printf "%s\\n" "osascript $*" >>"$ACTION_LOG"', '[ -n "$QUIT_REFUSED" ] || : >"$QUIT_FLAG"', "exit 0"].join(
      "\n",
    ),
    { shebang: "#!/usr/bin/env bash" },
  );

  box.stub(
    "open",
    [
      'printf "%s\\n" "open $*" >>"$ACTION_LOG"',
      '[ -n "$OPEN_FAILS" ] && exit 1',
      'rm -f "$QUIT_FLAG"',
      '[ -n "$APP_CLOBBERS" ] && printf 1 >"$PREF_FILE"',
      "exit 0",
    ].join("\n"),
    { shebang: "#!/usr/bin/env bash" },
  );

  // The waits are bounded in real seconds. An example should not spend them.
  box.stub("sleep", "exit 0", { shebang: "#!/usr/bin/env bash" });

  // The real gum logs to stderr, so the warning stays off captured stdout.
  box.stub("gum", 'printf "%s\\n" "${@: -1}" >&2', { shebang: "#!/usr/bin/env bash" });
}

function runVibeIsland(env: Record<string, string>): Run {
  return run(["bash", script], { path: [box.bin], env });
}

let box: Sandbox;
let env: Record<string, string>;

beforeEach(() => {
  box = sandbox("vibe-island");
  box.write("actions.log", "");

  // An installed app, by default. CURRENT_VALUE is what `defaults read` answers
  // with until something writes, empty standing for a key that was never
  // written, which the real defaults reports as a failure rather than as empty
  // output. A write lands in PREF_FILE, so a later read sees it.
  env = {
    VIBE_ISLAND_APP: box.mkdir("Vibe Island.app"),
    CURRENT_VALUE: "",
    PREF_FILE: box.path("pref"),
    // The app is either not running, or running and willing to quit.
    // QUIT_REFUSED makes it ignore the quit, and QUIT_FLAG is how the
    // osascript stub tells the pgrep stub the process is gone.
    APP_RUNNING: "",
    QUIT_REFUSED: "",
    QUIT_FLAG: box.path("quit"),
    // The app that ignores the opt-out: relaunching puts hook management back on.
    APP_CLOBBERS: "",
    // A reopen that fails: the app stays down, and the user's menu bar with it.
    OPEN_FAILS: "",
    // A preference write that does not take, leaving the key unset behind it.
    WRITE_FAILS: "",
    ACTION_LOG: box.path("actions.log"),
  };

  stubActions(box);
});

afterEach(() => {
  box.remove();
});

function actionLog(): string {
  return box.read("actions.log");
}

describe("macos/vibe-island.sh", () => {
  test("turns Vibe Island's Claude hook management off", () => {
    const r = runVibeIsland(env);
    expect(r.status).toBe(0);
    expect(actionLog()).toContain("defaults write app.vibeisland.macos hookAutoConfig_claude -bool false");
  });

  // The app owns this key too. A value of 1 means it has taken hook management
  // back, so the install has to correct it.
  test("turns it off again after the app turns it back on", () => {
    const r = runVibeIsland({ ...env, CURRENT_VALUE: "1" });
    expect(r.status).toBe(0);
    expect(actionLog()).toContain("-bool false");
  });

  // The install runs nightly. Rewriting a preference already set would quit the
  // app out from under the user every night for a change that has already taken.
  test("leaves a preference already set alone", () => {
    const r = runVibeIsland({ ...env, CURRENT_VALUE: "0" });
    expect(r.status).toBe(0);
    expect(actionLog()).not.toContain("write");
    expect(actionLog()).not.toContain("osascript");
  });

  test("does nothing on a machine without the app", () => {
    rmSync(env.VIBE_ISLAND_APP, { recursive: true, force: true });
    const r = runVibeIsland(env);
    expect(r.status).toBe(0);
    expect(actionLog()).toBe("");
  });

  test("says nothing when the app is not installed but is somehow running", () => {
    rmSync(env.VIBE_ISLAND_APP, { recursive: true, force: true });
    const r = runVibeIsland({ ...env, APP_RUNNING: "1" });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
  });

  describe("with the app running", () => {
    beforeEach(() => {
      env.APP_RUNNING = "1";
    });

    // NSUserDefaults holds what the app read at launch, and the app can write
    // that copy back, so a write under a running app is the one that gets lost.
    test("quits the app before writing", () => {
      const r = runVibeIsland(env);
      expect(r.status).toBe(0);
      expect(actionLog()).toMatch(/osascript[\s\S]*quit app[\s\S]*defaults write/);
    });

    // Quitting takes the menu bar with it, so the script owns putting it back.
    test("reopens the app after writing", () => {
      const r = runVibeIsland(env);
      expect(r.status).toBe(0);
      expect(actionLog()).toMatch(/defaults write[\s\S]*open -a/);
    });

    test("stays quiet when the quit and the write both take", () => {
      const r = runVibeIsland(env);
      expect(r.status).toBe(0);
      expect(r.stderr).toBe("");
    });

    // An app that ignores the opt-out is not one a relaunch can fix, and nothing
    // downstream undoes what it writes, so the warning is the whole signal.
    test("warns when hook management is back on after the relaunch", () => {
      const r = runVibeIsland({ ...env, APP_CLOBBERS: "1" });
      expect(r.status).toBe(0);
      expect(r.stderr).toContain("ignoring the opt-out");
    });

    // Quitting the app was this script's doing, so a reopen it could not manage
    // is its to report. Silence here costs the user their menu bar.
    test("warns when it cannot reopen the app", () => {
      const r = runVibeIsland({ ...env, OPEN_FAILS: "1" });
      expect(r.status).toBe(0);
      expect(r.stderr).toContain("Could not reopen");
      expect(actionLog()).toContain("-bool false");
    });

    // stderr on the nightly run goes to a log file nobody reads, and a missing
    // menu bar is not something the user can trace back to this script.
    test("notifies when it cannot reopen the app", () => {
      const r = runVibeIsland({ ...env, OPEN_FAILS: "1" });
      expect(r.status).toBe(0);
      expect(r.stderr).toBeDefined();
      expect(actionLog()).toContain("display notification");
    });

    test("reports a failed write as its own, not as the app ignoring the opt-out", () => {
      const r = runVibeIsland({ ...env, WRITE_FAILS: "1" });
      expect(r.status).toBe(0);
      expect(r.stderr).toContain("Could not write");
      expect(r.stderr).not.toContain("ignoring the opt-out");
    });

    test("says so when it cannot read the preference back", () => {
      const r = runVibeIsland({ ...env, WRITE_FAILS: "1" });
      expect(r.status).toBe(0);
      expect(r.stderr).toContain("Could not read");
      expect(r.stderr).not.toContain("ignoring the opt-out");
    });

    // An app that will not quit leaves the old behavior: write anyway, and say
    // the value may not survive. Killing it or leaving it dead would cost the
    // user their menu bar for a preference write.
    test("writes and warns when the app will not quit", () => {
      const r = runVibeIsland({ ...env, QUIT_REFUSED: "1" });
      expect(r.status).toBe(0);
      expect(r.stderr).toContain("would not quit");
      expect(actionLog()).toContain("-bool false");
      expect(actionLog()).not.toContain("open -a");
    });
  });

  describe("with the app not running", () => {
    test("neither quits nor reopens", () => {
      const r = runVibeIsland(env);
      expect(r.status).toBe(0);
      expect(actionLog()).not.toContain("osascript");
      expect(actionLog()).not.toContain("open -a");
    });

    test("stays quiet", () => {
      const r = runVibeIsland(env);
      expect(r.status).toBe(0);
      expect(r.stderr).toBe("");
    });
  });
});
