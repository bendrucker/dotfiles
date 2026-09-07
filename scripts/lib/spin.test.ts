import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { quote, repoRoot, run, sandbox, shell, type Sandbox } from "./shell-fixtures.ts";

const lib = join(repoRoot, "scripts", "lib", "spin.sh");

const esc = "\x1b";

function spinCall(args: string[], options: Parameters<typeof shell>[1] = {}) {
  return shell(`. ${quote(lib)}\nspin "$@"`, { args, ...options });
}

let box: Sandbox;

beforeEach(() => {
  box = sandbox("spin");
});

afterEach(() => {
  box.remove();
});

// These examples run the real gum. Every other spec here stubs it, which is why
// gum 2 shipped this repo a regression nothing caught: its spinner renders
// through Bubble Tea v2, which writes frames to stderr whether or not a
// terminal is there to interpret them. The unattended jobs all run under
// `2>&1 | tee`, so the frames land in the log as raw control characters and
// ride into the Things to-do filed from it.
describe("spin", () => {
  // The runner captures both streams through pipes, so every case here takes
  // the branch the unattended jobs take.
  describe("with no terminal on stderr", () => {
    test("runs the command and passes its output through", () => {
      const r = spinCall(["--title", "Working", "--", "printf", "ran\\n"]);
      expect(r.stdout.trim()).toBe("ran");
      expect(r.stderr).not.toBe("");
    });

    test("names the step, since there is no spinner to name it", () => {
      const r = spinCall(["--title", "Fetching origin/main (attempt 1/4)", "--", "true"]);
      expect(r.stderr).toContain("Fetching origin/main (attempt 1/4)");
    });

    test("returns the command's status", () => {
      const r = spinCall(["--title", "Pushing", "--", "false"]);
      expect(r.status).not.toBe(0);
      expect(r.stderr).not.toBe("");
    });

    test("accepts the output flags gum takes", () => {
      const r = spinCall(["--show-output", "--show-error", "--title", "Syncing", "--", "printf", "ran\\n"]);
      expect(r.stdout.trim()).toBe("ran");
      expect(r.stderr).toContain("Syncing");
    });

    test("accepts an inline title", () => {
      const r = spinCall(["--title=Syncing", "--", "true"]);
      expect(r.stderr).toContain("Syncing");
    });

    // gum spin rejects a call with nothing after the separator. Running the
    // empty argument list instead would report a sync that never fetched as a
    // success.
    test("refuses a call with no command", () => {
      const r = spinCall(["--title", "Syncing", "--"]);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("no command");
    });

    // bin/dotf runs before scripts/install has installed gum, and a missing
    // spinner is no reason to skip the work it was wrapping.
    test("runs the command when gum is not installed", () => {
      const empty = box.mkdir("empty");
      const r = run(
        ["/bin/bash", "-c", `. ${quote(lib)}\nspin "$@"`, "bash", "--title", "Working", "--", "/bin/echo", "ran"],
        { onlyPath: [empty] },
      );
      expect(r.stdout.trim()).toBe("ran");
      expect(r.stderr).toBe("");
    });

    test("writes no terminal control sequences", () => {
      const r = spinCall(["--title", "Working", "--", "printf", "ran\\n"]);
      expect(r.stdout).not.toContain(esc);
      expect(r.stderr).not.toContain(esc);
    });
  });

  describe("with a terminal on stderr", () => {
    test("hands the command to gum with its flags intact", () => {
      const gumLog = box.path("gum.log");
      box.stub("gum", `printf "%s\\n" "$*" >>${quote(gumLog)}`);

      // The one branch a spec cannot reach by redirecting streams.
      const r = shell(`. ${quote(lib)}\nspin_has_terminal() { true; }\nspin "$@"`, {
        args: ["--show-error", "--title", "Pushing branch", "--", "git", "push", "-u", "origin", "branch"],
        path: [box.bin],
      });

      expect(r.status).toBe(0);
      expect(readFileSync(gumLog, "utf8").trim()).toBe(
        "spin --show-error --title Pushing branch -- git push -u origin branch",
      );
    });
  });
});
