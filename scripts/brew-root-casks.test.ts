import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { repoRoot, run, sandbox, type Sandbox } from "#harness";
import { type Probe, rootReason } from "./brew-root-casks";

const script = join(repoRoot, "scripts", "brew-root-casks");

function probe(...paths: string[]): Probe {
  return {
    exists: (path) => paths.includes(path),
    writable: (path) => path.startsWith("/Users/me"),
  };
}

describe("rootReason", () => {
  test.each<{ name: string; artifacts: unknown; paths?: string[]; reason: string | null }>([
    {
      name: "charles removes a root-owned privileged helper",
      artifacts: [
        {
          uninstall: [
            {
              launchctl: "com.xk72.Charles.ProxyHelper",
              quit: "com.xk72.Charles",
              delete: "/Library/PrivilegedHelperTools/com.xk72.Charles.ProxyHelper",
            },
          ],
        },
        { app: ["Charles.app"] },
      ],
      paths: ["/Library/PrivilegedHelperTools/com.xk72.Charles.ProxyHelper"],
      reason: "removes /Library/PrivilegedHelperTools/com.xk72.Charles.ProxyHelper",
    },
    {
      name: "a path already gone needs nothing",
      artifacts: [{ uninstall: [{ delete: "/Library/PrivilegedHelperTools/gone" }] }],
      reason: null,
    },
    {
      name: "a path under home needs nothing",
      artifacts: [{ uninstall: [{ rmdir: "~/.docker/bin" }] }],
      paths: ["/Users/me/.docker/bin"],
      reason: null,
    },
    {
      name: "a glob is left to Homebrew",
      artifacts: [{ uninstall: [{ delete: ["/Library/Mail/Bundles.gpgmail*"] }] }],
      paths: ["/Library/Mail/Bundles.gpgmail*"],
      reason: null,
    },
    {
      name: "a pkg install",
      artifacts: [{ pkg: ["Tailscale.pkg"] }],
      reason: "installs a pkg",
    },
    {
      name: "a pkg receipt",
      artifacts: [{ uninstall: [{ pkgutil: "com.tailscale.ipn.macsys" }] }],
      reason: "forgets the pkg receipt com.tailscale.ipn.macsys",
    },
    {
      name: "an uninstall script run as root",
      artifacts: [{ uninstall: [{ script: { executable: "uninstall.sh", sudo: true } }] }],
      reason: "runs its script as root",
    },
    {
      name: "a system launch daemon",
      artifacts: [{ uninstall: [{ launchctl: ["com.docker.vmnetd"] }] }],
      paths: ["/Library/LaunchDaemons/com.docker.vmnetd.plist"],
      reason: "removes the system service com.docker.vmnetd",
    },
    {
      name: "a user launch agent needs nothing",
      artifacts: [{ uninstall: [{ launchctl: "com.example.agent", quit: "com.example" }] }],
      reason: null,
    },
    {
      name: "an app alone needs nothing",
      artifacts: [{ app: ["Raycast.app"] }],
      reason: null,
    },
    {
      name: "artifacts of an unexpected shape",
      artifacts: "nothing",
      reason: null,
    },
  ])("$name", ({ artifacts, paths = [], reason }) => {
    expect(rootReason(artifacts, probe(...paths), "/Users/me")).toBe(reason);
  });
});

describe("brew-root-casks", () => {
  let box: Sandbox;

  beforeEach(() => {
    box = sandbox("brew-root-casks");
  });

  afterEach(() => {
    box.remove();
  });

  function brew(outdated: object, info: object): void {
    box.write("outdated.json", JSON.stringify(outdated));
    box.write("info.json", JSON.stringify(info));
    box.stub(
      "brew",
      [
        `printf '%s\\n' "$*" >> '${join(box.dir, "calls")}'`,
        `[ "$HOMEBREW_NO_UPGRADE_AUTO_UPDATES_CASKS" = 1 ] || exit 3`,
        `case "$1" in`,
        `  outdated) cat '${join(box.dir, "outdated.json")}' ;;`,
        `  info) cat '${join(box.dir, "info.json")}' ;;`,
        `esac`,
      ].join("\n"),
    );
  }

  test("names each outdated cask that needs root and why", () => {
    brew(
      { formulae: [], casks: [{ name: "charles" }, { name: "raycast" }] },
      {
        casks: [
          { token: "charles", artifacts: [{ pkg: ["Charles.pkg"] }] },
          { token: "raycast", artifacts: [{ app: ["Raycast.app"] }] },
        ],
      },
    );

    const result = run([script], { path: [box.bin] });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("charles  installs a pkg\n");
    expect(box.read("calls")).toBe("outdated --cask --json=v2\ninfo --cask --json=v2 charles raycast\n");
  });

  test("prints nothing and skips the lookup when no cask is outdated", () => {
    brew({ formulae: [], casks: [] }, {});

    const result = run([script], { path: [box.bin] });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(box.read("calls")).toBe("outdated --cask --json=v2\n");
  });

  test("fails without printing when brew fails", () => {
    box.stub("brew", "exit 1");

    const result = run([script], { path: [box.bin] });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
  });
});
