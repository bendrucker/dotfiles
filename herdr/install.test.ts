import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { quote, repoRoot, run, sandbox, type Sandbox } from "#harness";

const installer = join(repoRoot, "herdr", "install.sh");
const pin = "=url.https://github.com/natori-hrj/herdr-lazy.insteadOf\n";

let box: Sandbox;
let env: Record<string, string | undefined>;

// Record the GIT_CONFIG_* env a command ran with, and the URL git would open
// for a plugin clone under it.
function recorder(name: string): string {
  return [
    `out=${quote(box.path("calls"))}/${name}`,
    `env | grep '^GIT_CONFIG_' | sort > "$out"`,
    `git ls-remote --get-url https://github.com/natori-hrj/herdr-lazy >> "$out"`,
  ].join("\n");
}

beforeEach(() => {
  box = sandbox("herdr-install");
  box.mkdir("calls");
  const root = box.mkdir("lazy");
  // What an org that standardizes on SSH installs. It undoes an HTTPS clone.
  const global = box.write("gitconfig", '[url "git@github.com:"]\n\tinsteadOf = https://github.com/\n');
  box.write("dotfiles/macos/shell/launch-agent.sh", "install_launch_agent() { :; }\n");

  const listed = JSON.stringify({ result: { plugins: [{ plugin_id: "herdr-lazy", plugin_root: root }] } });
  box.stub(
    "herdr",
    [
      'case "$1 $2" in',
      `  "status server") echo '{"running":true}' ;;`,
      `  "plugin list") [ -e ${quote(box.path("installed"))} ] && echo ${quote(listed)} || echo '{"result":{"plugins":[]}}' ;;`,
      `  "plugin install") ${recorder("install").replaceAll("\n", "; ")}; touch ${quote(box.path("installed"))} ;;`,
      "esac",
    ].join("\n"),
  );
  box.stub("lazy/target/release/herdr-lazy", recorder('"$1"'));

  env = {
    GIT_CONFIG_GLOBAL: global,
    GIT_CONFIG_SYSTEM: "/dev/null",
    ZSH: box.path("dotfiles"),
    ZDOTDIR: box.mkdir("zdotdir"),
    CI: undefined,
  };
});

afterEach(() => {
  box.remove();
});

describe("herdr/install.sh", () => {
  test.each(["install", "update", "sync"])("%s clones plugins over HTTPS past a rule forcing SSH", (call) => {
    const r = run([installer], { path: [box.bin], env });
    expect(r.status).toBe(0);
    const recorded = box.read(join("calls", call));
    expect(recorded).toContain(pin);
    expect(recorded.trim().split("\n").at(-1)).toBe("https://github.com/natori-hrj/herdr-lazy");
  });

  test("leaves the rewrite off commands that clone nothing", () => {
    const r = run([installer], { path: [box.bin], env });
    expect(r.status).toBe(0);
    const recorded = box.read(join("calls", "auto-sync"));
    expect(recorded).not.toContain(pin);
    expect(recorded.trim().split("\n").at(-1)).toBe("git@github.com:natori-hrj/herdr-lazy");
  });
});
