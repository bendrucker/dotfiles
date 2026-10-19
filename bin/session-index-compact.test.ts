import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { run, sandbox, stubGum, type Sandbox } from "#harness";

const script = join(import.meta.dir, "session-index-compact");
const REFRESH = "repo/plugins/observability/skills/session/scripts/refresh.ts";

let box: Sandbox;

beforeEach(() => {
  box = sandbox("session-index-compact");
  stubGum(box);
  // A to-do is filed by handing a things:/// URL to `open`.
  box.stub("open", `printf '%s\\n' "$2" >>"${box.path("todos")}"`);
  box.stub("scutil", "printf '%s\\n' Testbox");
  box.stub("ioreg", `printf '"IOPlatformUUID" = "%s"\\n' 0000-TEST`);
});

afterEach(() => box.remove());

function compact() {
  return run([script], {
    path: [box.bin],
    env: {
      CLAUDE_REPO_HOME: box.path("repo"),
      XDG_STATE_HOME: box.path("state"),
      THINGS_DATABASE: box.path("things.sqlite"),
    },
  });
}

test("skips a clone without the session skill", () => {
  expect(compact().status).toBe(0);
  expect(box.read("todos")).toBe("");
});

test("runs refresh.ts --compact and clears the latch", () => {
  box.write(REFRESH, "console.log(process.argv.slice(2).join(' '));");
  const result = compact();
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("--compact");
  expect(box.read("state/dotfiles/session-index-compact.status")).toBe("ok\n");
});

test("files a to-do when the compaction fails", () => {
  box.write(REFRESH, "console.error('disk full'); process.exit(1);");
  expect(compact().status).toBe(1);
  expect(box.read("todos")).toContain("Session%20index%20compaction%20failed");
});
