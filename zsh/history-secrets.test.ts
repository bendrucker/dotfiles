import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ordinary, secrets } from "#history-secrets";
import { quote, repoRoot, sandbox, shell } from "#harness";

const filter = join(repoRoot, "zsh", "history-secrets.zsh");
const source = `source ${quote(filter)}`;

/** Call the hook the way zsh does, on a line that still carries its newline. */
function saves(command: string): boolean {
  return shell(`${source}; _history_secret_filter ${quote(`${command}\n`)}`, { shell: "zsh" }).status === 0;
}

describe("the zshaddhistory filter", () => {
  for (const { name, command } of secrets) {
    test(`drops ${name}`, () => {
      expect(saves(command)).toBe(false);
    });
  }

  for (const { name, command } of ordinary) {
    test(`keeps ${name}`, () => {
      expect(saves(command)).toBe(true);
    });
  }

  test("registers itself on the zshaddhistory hook", () => {
    const r = shell(`${source}; print -r -- $zshaddhistory_functions`, { shell: "zsh" });
    expect(r.stdout.trim()).toBe("_history_secret_filter");
  });

  test("registers once when the file is sourced twice", () => {
    const r = shell(`${source}; ${source}; print -r -- $#zshaddhistory_functions`, { shell: "zsh" });
    expect(r.stdout.trim()).toBe("1");
  });
});

// The hook only earns its place if zsh honours it at the point it writes the
// file, so this drives a real interactive shell rather than the function alone.
describe("the history file a real shell writes", () => {
  const box = sandbox("history-secrets");
  afterAll(() => box.remove());

  const histfile = box.path("history");
  box.write(
    ".zshrc",
    [
      `HISTFILE=${quote(histfile)}`,
      "HISTSIZE=1000",
      "SAVEHIST=1000",
      "setopt APPEND_HISTORY INC_APPEND_HISTORY SHARE_HISTORY HIST_IGNORE_SPACE",
      source,
      "",
    ].join("\n"),
  );

  const typed = ["echo ordinary", "export DB_PASS=hunter2super-secret", "exit"];
  shell(`printf %s ${quote(typed.map((line) => `${line}\n`).join(""))} | zsh -i`, {
    env: { ZDOTDIR: box.dir },
  });
  const history = box.read("history");

  test("records the ordinary command", () => {
    expect(history).toContain("echo ordinary");
  });

  test("records nothing from the line carrying a password", () => {
    expect(history).not.toContain("hunter2");
  });
});
