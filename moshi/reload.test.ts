import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { repoRoot, run, sandbox, stubGum, type Run, type Sandbox } from "#harness";

const reload = join(repoRoot, "moshi", "reload.ts");

let box: Sandbox;

beforeEach(() => {
  box = sandbox("moshi-reload");
  stubGum(box);
  box.write("config/moshi/config.toml", "[gateway]\nsuppress_push_while_unlocked = true\n");
  daemon("running", 0);
});

afterEach(() => {
  box.remove();
});

// Each restart is appended to the sandbox's `restarts` file.
function daemon(state: string, restartStatus: number, version = "0.4.18"): void {
  box.stub(
    "moshi-hook",
    [
      `[ "$1" = version ] && { echo "moshi-hook ${version}"; exit 0; }`,
      'case "$2" in',
      `  status) printf '\\tstate = %s\\n' '${state}' ;;`,
      `  restart) echo restart >>"${box.path("restarts")}"; exit ${restartStatus} ;;`,
      "esac",
    ].join("\n"),
  );
}

function runReload(): Run {
  return run([process.execPath, reload], {
    path: [box.bin],
    env: { XDG_CONFIG_HOME: box.path("config"), XDG_STATE_HOME: box.path("state") },
  });
}

function restarts(): number {
  return box.read("restarts").split("\n").filter(Boolean).length;
}

describe("moshi reload", () => {
  test("restarts once for a change and skips an unchanged run", () => {
    expect(runReload().stderr).toContain("changed, restarting the daemon");
    const second = runReload();

    expect(second.status).toBe(0);
    expect(second.stderr).toContain("unchanged, skipping restart");
    expect(restarts()).toBe(1);
  });

  test("restarts again after the config changes", () => {
    runReload();
    box.write("config/moshi/config.toml", "[gateway]\nsuppress_push_while_unlocked = false\n");
    runReload();

    expect(restarts()).toBe(2);
  });

  test("restarts after an upgrade with the config unchanged", () => {
    runReload();
    daemon("running", 0, "0.4.19");
    expect(runReload().stderr).toContain("restarting the daemon on moshi-hook 0.4.19");

    expect(restarts()).toBe(2);
  });

  test("retries a restart that failed", () => {
    daemon("running", 1);
    const failed = runReload();
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain("service restart failed");

    daemon("running", 0);
    expect(runReload().stderr).toContain("restarting");
    expect(restarts()).toBe(2);
  });

  test("records a change without restarting a stopped daemon", () => {
    daemon("not running", 0);
    expect(runReload().stderr).toContain("daemon is not running");

    daemon("running", 0);
    expect(runReload().stderr).toContain("unchanged");
    expect(restarts()).toBe(0);
  });

  test("exits quietly when moshi-hook is not installed", () => {
    rmSync(box.path("bin", "moshi-hook"));
    const r = run([process.execPath, reload], {
      onlyPath: [box.bin, "/usr/bin", "/bin"],
      env: { XDG_CONFIG_HOME: box.path("config"), XDG_STATE_HOME: box.path("state") },
    });

    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    expect(box.read("state/dotfiles/moshi-hook.applied")).toBe("");
  });

  test("exits quietly when config.toml is not installed", () => {
    box.remove();
    box = sandbox("moshi-reload");
    daemon("running", 0);
    const r = runReload();

    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    expect(restarts()).toBe(0);
  });
});
