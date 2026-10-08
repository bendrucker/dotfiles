import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { run, sandbox, type Sandbox } from "#harness";

const script = join(import.meta.dir, "watch-theme-change");

describe("watch-theme-change", () => {
  let box: Sandbox;

  beforeEach(() => {
    box = sandbox("watch-theme-change");
    copyFileSync(script, join(box.bin, "watch-theme-change"));
    box.stub("uname", "echo Darwin");
    box.stub(
      "theme-sync",
      [
        'printf "start %s\\n" "$1" >>"$SYNC_LOG"',
        "sleep 0.1",
        'printf "end %s\\n" "$1" >>"$SYNC_LOG"',
        '[ "$1" != "$SYNC_FAIL" ]',
      ].join("\n"),
    );
    box.stub("dark-notify", 'printf "dark\\nlight\\ndark\\n"; exit "${NOTIFY_EXIT:-0}"');
  });

  afterEach(() => box.remove());

  function watch(env: Record<string, string> = {}) {
    return run([join(box.bin, "watch-theme-change")], {
      path: [box.bin],
      env: { SYNC_LOG: box.path("sync.log"), SYNC_FAIL: "", ...env },
    });
  }

  test("runs theme-sync to completion for each appearance before reading the next", () => {
    expect(watch().status).toBe(0);
    expect(box.read("sync.log")).toBe(
      ["start dark", "end dark", "start light", "end light", "start dark", "end dark", ""].join("\n"),
    );
  });

  test("keeps watching after theme-sync fails", () => {
    const result = watch({ SYNC_FAIL: "light" });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("theme-sync light exited 1");
    expect(box.read("sync.log")).toContain("end dark\nstart light\nend light\nstart dark");
  });

  test("exits with dark-notify's status so launchd restarts it", () => {
    expect(watch({ NOTIFY_EXIT: "3" }).status).toBe(3);
  });
});
