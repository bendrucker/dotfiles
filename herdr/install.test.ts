import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { quote, repoRoot, run, sandbox, type Run, type Sandbox } from "#harness";

const installer = join(repoRoot, "herdr", "install.sh");
const pin = "=url.https://github.com/natori-hrj/herdr-lazy.insteadOf\n";

let box: Sandbox;
let result: Run;
let env: Record<string, string | undefined>;

function recorder(name: string): string {
  return [
    `out=${quote(box.path("calls"))}/${name}`,
    `env | grep '^GIT_CONFIG_' | sort > "$out"`,
    `git ls-remote --get-url https://github.com/natori-hrj/herdr-lazy >> "$out"`,
  ].join("\n");
}

beforeAll(() => {
  box = sandbox("herdr-install");
  box.mkdir("calls");
  const root = box.mkdir("lazy");
  // What an org that standardizes on SSH installs. It undoes an HTTPS clone.
  const global = box.write("gitconfig", '[url "git@github.com:"]\n\tinsteadOf = https://github.com/\n');
  // Answers like a machine whose herdr server launchd does not hold.
  box.stub("launchctl", "exit 1");

  const listed = JSON.stringify({ result: { plugins: [{ plugin_id: "herdr-lazy", plugin_root: root }] } });
  box.stub(
    "herdr",
    [
      'case "$1 $2" in',
      `  "status server") echo '{"running":true}' ;;`,
      `  "plugin list") [ -e ${quote(box.path("installed"))} ] && echo ${quote(listed)} || echo '{"result":{"plugins":[]}}' ;;`,
      `  "plugin install") ${recorder("install").replaceAll("\n", "; ")}; touch ${quote(box.path("installed"))} ;;`,
      `  "update --handoff") echo "$@" > ${quote(box.path("calls", "herdr-update"))} ;;`,
      "esac",
    ].join("\n"),
  );
  box.stub("lazy/target/release/herdr-lazy", recorder('"$1"'));

  env = {
    GIT_CONFIG_GLOBAL: global,
    GIT_CONFIG_SYSTEM: "/dev/null",
    ZDOTDIR: box.mkdir("zdotdir"),
    HERDR_INSTALL_DIR: box.bin,
    HERDR_ENV: undefined,
    CI: undefined,
  };
  result = run([installer], { path: [box.bin], env });
});

afterAll(() => {
  box.remove();
});

describe("herdr/install.sh", () => {
  test("exits cleanly", () => {
    expect(result.status).toBe(0);
  });

  test.each(["install", "update", "sync"])("%s clones plugins over HTTPS past a rule forcing SSH", (call) => {
    const recorded = box.read(join("calls", call));
    expect(recorded).toContain(pin);
    expect(recorded.trim().split("\n").at(-1)).toBe("https://github.com/natori-hrj/herdr-lazy");
  });

  test("leaves the rewrite off commands that clone nothing", () => {
    const recorded = box.read(join("calls", "auto-sync"));
    expect(recorded).not.toContain(pin);
    expect(recorded.trim().split("\n").at(-1)).toBe("git@github.com:natori-hrj/herdr-lazy");
  });

  test("updates herdr with a live handoff", () => {
    expect(box.read(join("calls", "herdr-update")).trim()).toBe("update --handoff");
  });

  test("leaves the update alone from inside a herdr pane", () => {
    const box2 = sandbox("herdr-install-inside");
    box2.stub("herdr", `[ "$1" = update ] && touch ${quote(box2.path("updated"))}; exit 0`);
    box2.stub("launchctl", "exit 1");
    const r = run([installer], { path: [box2.bin], env: { ...env, HERDR_INSTALL_DIR: box2.bin, HERDR_ENV: "1" } });
    expect(r.stderr).toContain("inside herdr");
    expect(existsSync(box2.path("updated"))).toBe(false);
    box2.remove();
  });

  test("installs herdr with its own installer when it is missing", () => {
    const box2 = sandbox("herdr-install-fresh");
    const dir = box2.path("local-bin");
    box2.stub("curl", `echo 'mkdir -p "$HERDR_INSTALL_DIR" && printf "#!/bin/sh\\nexit 0\\n" > "$HERDR_INSTALL_DIR/herdr" && chmod +x "$HERDR_INSTALL_DIR/herdr"'`);
    box2.stub("launchctl", "exit 1");
    const r = run([installer], { path: [box2.bin], env: { ...env, HERDR_INSTALL_DIR: dir } });
    expect(r.stdout).toContain(`installing herdr to ${dir}`);
    expect(existsSync(join(dir, "herdr"))).toBe(true);
    box2.remove();
  });
});
