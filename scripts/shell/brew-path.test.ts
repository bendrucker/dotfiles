import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { quote, repoRoot, run, sandbox, type Sandbox } from "#harness";

const lib = join(repoRoot, "scripts", "shell", "brew-path.sh");

let box: Sandbox;

beforeEach(() => {
  box = sandbox("brew-path");
});

afterEach(() => {
  box.remove();
});

/** A brew under `<prefix>/bin` whose shellenv puts that directory on PATH. */
function stubBrew(prefix: string): string {
  const bin = join(box.mkdir(prefix), "bin");
  box.stub(join(prefix, "bin", "brew"), `[ "$1" = shellenv ] && echo 'export PATH="${bin}:$PATH"'`);
  return bin;
}

function brewPath(prefixes: string[], path: string[], shell = "/bin/sh") {
  const script = `. ${quote(lib)}\nbrew_path "$@"\nst=$?\ncommand -v brew\nexit $st`;
  return run([shell, "-c", script, "sh", ...prefixes], { onlyPath: path });
}

describe("brew_path", () => {
  const zsh = run(["sh", "-c", "command -v zsh"]).stdout.trim();

  // A fresh Terminal has no Homebrew on PATH, so the brew the installer just
  // laid down is unreachable until something evaluates its shellenv.
  // scripts/setup sources this under zsh, the rest under sh.
  test.each<[string, string]>([
    ["sh", "/bin/sh"],
    ["zsh", zsh],
  ])("puts the first installed prefix on PATH under %s", (_name, shell) => {
    const empty = box.mkdir("empty");
    const bin = stubBrew("homebrew");
    const r = brewPath([box.path("missing"), box.path("homebrew")], [empty], shell);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(join(bin, "brew"));
  });

  test("leaves PATH alone when brew is already on it", () => {
    box.stub("brew", "exit 1");
    stubBrew("homebrew");
    const r = brewPath([box.path("homebrew")], [box.bin]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(join(box.bin, "brew"));
  });

  test("fails when no prefix holds brew", () => {
    const empty = box.mkdir("empty");
    const r = brewPath([box.path("missing")], [empty]);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toBe("");
  });
});
