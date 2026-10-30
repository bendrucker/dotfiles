import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { quote, repoRoot, run, sandbox, type Sandbox } from "#harness";

const installer = join(repoRoot, "herdr", "install-app.sh");

let box: Sandbox;

// Each installer stub prints a script that records which installer ran, for the
// `| sh` on the other end of the pipe.
function stubCurl(): void {
  const calls = quote(box.path("curl"));
  box.stub(
    "curl",
    [
      'url=""; for a in "$@"; do url=$a; done',
      `echo "$url" >> ${calls}`,
      'case "$url" in',
      `  */core/install.sh) echo 'mkdir -p "$HC_INSTALL_DIR" && printf "#!/bin/sh\\nexit 0\\n" > "$HC_INSTALL_DIR/herdr-core" && chmod +x "$HC_INSTALL_DIR/herdr-core"' ;;`,
      `  */app/install.sh) echo 'mkdir -p "$HOME/Applications/Herdr.app"' ;;`,
      "esac",
    ].join("\n"),
  );
}

function install(os: string, env: Record<string, string | undefined> = {}) {
  box.stub("uname", `echo ${os}`);
  return run([installer], {
    path: [box.bin],
    env: {
      HOME: box.mkdir("home"),
      ZDOTDIR: box.mkdir("zdotdir"),
      HC_INSTALL_DIR: box.path("local-bin"),
      CI: undefined,
      ...env,
    },
  });
}

beforeEach(() => {
  box = sandbox("herdr-install-app");
  stubCurl();
});

afterEach(() => {
  box.remove();
});

describe("herdr/install-app.sh", () => {
  test("installs herdr-core and the app on macOS", () => {
    const r = install("Darwin");
    expect(r.status).toBe(0);
    expect(existsSync(box.path("local-bin", "herdr-core"))).toBe(true);
    expect(existsSync(box.path("home", "Applications", "Herdr.app"))).toBe(true);
    expect(box.read("curl").trim().split("\n")).toEqual([
      "https://releases.herdr.dev/core/install.sh",
      "https://releases.herdr.dev/app/install.sh",
    ]);
  });

  test("updates an installed herdr-core with hc update and leaves the app to update itself", () => {
    box.stub("local-bin/herdr-core", `echo "$@" > ${quote(box.path("hc-update"))}`);
    box.mkdir("home", "Applications", "Herdr.app");
    const r = install("Darwin");
    expect(r.status).toBe(0);
    expect(box.read("hc-update").trim()).toBe("update");
    expect(box.read("curl")).toBe("");
  });

  test("warns rather than failing when hc update does", () => {
    box.stub("local-bin/herdr-core", "exit 1");
    box.mkdir("home", "Applications", "Herdr.app");
    const r = install("Darwin");
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("hc update did not finish");
  });

  test("warns rather than failing when an installer download fails", () => {
    box.stub("curl", "exit 22");
    const r = install("Darwin");
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("herdr-core install failed");
    expect(r.stderr).toContain("Herdr app install failed");
  });

  test("installs only herdr-core on Linux", () => {
    const r = install("Linux");
    expect(r.status).toBe(0);
    expect(box.read("curl").trim()).toBe("https://releases.herdr.dev/core/install.sh");
  });

  test("does nothing under CI", () => {
    const r = install("Darwin", { CI: "true" });
    expect(r.status).toBe(0);
    expect(box.read("curl")).toBe("");
  });
});
