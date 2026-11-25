import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { quote, repoRoot, run, sandbox, type Sandbox } from "#harness";

const installer = join(repoRoot, "terminal-browser", "install.sh");

interface Case {
  name: string;
  installed: boolean;
  ci?: boolean;
  curl?: "fails";
  upgrade?: "fails";
  calls: string[];
  warning?: string;
}

const cases: Case[] = [
  { name: "installs when missing", installed: false, calls: ["installer", "setup"] },
  { name: "upgrades when installed", installed: true, calls: ["upgrade", "setup"] },
  {
    name: "still links skills after a failed upgrade",
    installed: true,
    upgrade: "fails",
    calls: ["upgrade", "setup"],
    warning: "upgrade failed",
  },
  { name: "skips setup after a failed download", installed: false, curl: "fails", calls: [], warning: "install failed" },
  { name: "does nothing on CI", installed: true, ci: true, calls: [] },
];

let box: Sandbox;

afterEach(() => {
  box.remove();
});

describe("terminal-browser/install.sh", () => {
  test.each(cases)("$name", ({ installed, ci, curl, upgrade, calls, warning }) => {
    box = sandbox("terminal-browser-install");
    const log = quote(box.path("calls"));
    const binHome = box.mkdir("home-bin");
    const browser = box.stub(
      "app/terminal-browser",
      [`echo "$1" >> ${log}`, upgrade === "fails" ? '[ "$1" = upgrade ] && exit 1' : ":"].join("\n"),
    );
    if (installed) box.stub("home-bin/terminal-browser", `exec ${quote(browser)} "$@"`);
    box.stub(
      "curl",
      curl === "fails"
        ? "exit 22"
        : `cat <<'EOF'
echo installer >> ${log}
printf '#!/bin/sh\\nexec %s "$@"\\n' ${quote(browser)} > ${quote(join(binHome, "terminal-browser"))}
chmod +x ${quote(join(binHome, "terminal-browser"))}
EOF`,
    );

    const result = run(["bash", installer], {
      path: [box.bin],
      env: { CI: ci ? "true" : undefined, XDG_BIN_HOME: binHome },
    });

    expect(result.status).toBe(0);
    expect(box.read("calls").split("\n").filter(Boolean)).toEqual(calls);
    if (warning) expect(result.stderr).toContain(warning);
  });
});
