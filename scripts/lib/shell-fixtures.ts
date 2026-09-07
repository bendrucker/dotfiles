// A stub only shadows the real command while the directory holding it comes
// first on $PATH, so `run` and `shell` take the stub directories rather than
// leaving each test to assemble a PATH.

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface Run {
  status: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  /** Directories to put in front of the inherited $PATH. */
  path?: string[];
  /** Directories to use as the whole $PATH, so nothing outside them resolves. */
  onlyPath?: string[];
  env?: Record<string, string | undefined>;
  cwd?: string;
  stdin?: "ignore" | "inherit";
}

/** Quote a value for the shell, so a path with a space or a quote survives. */
export function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function environment(options: RunOptions): Record<string, string> {
  const merged: Record<string, string | undefined> = { ...process.env, ...options.env };
  if (options.onlyPath) merged.PATH = options.onlyPath.join(":");
  else if (options.path) merged.PATH = [...options.path, merged.PATH].join(":");

  // An explicit undefined unsets the variable, which is how a test reproduces
  // `env -u NAME` for a script that reads whatever it was already handed.
  const defined: Record<string, string> = {};
  for (const [key, value] of Object.entries(merged)) if (value !== undefined) defined[key] = value;
  return defined;
}

/** Run a command, reporting its status and both streams rather than throwing. */
export function run(cmd: string[], options: RunOptions = {}): Run {
  const spawned = Bun.spawnSync({
    cmd,
    env: environment(options),
    cwd: options.cwd,
    stdin: options.stdin ?? "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    // A signalled process reports a null exit code, which would otherwise read
    // as a success anywhere a test compares against a number.
    status: spawned.exitCode ?? 128,
    stdout: spawned.stdout.toString(),
    stderr: spawned.stderr.toString(),
  };
}

export interface ShellOptions extends RunOptions {
  shell?: "bash" | "zsh";
  /** Positional arguments the script reads as "$1", "$2", and "$@". */
  args?: string[];
}

/**
 * Run a snippet under bash or zsh. This is what replaces sourcing a library and
 * calling one of its functions: the snippet sources the library and calls it,
 * so a redefinition placed after the source still wins.
 */
export function shell(script: string, options: ShellOptions = {}): Run {
  const { shell: interpreter = "bash", args = [], ...rest } = options;
  return run([interpreter, "-c", script, interpreter, ...args], rest);
}

/** Run a command and fail the test on a nonzero status, for fixture setup. */
export function must(cmd: string[], options: RunOptions = {}): string {
  const result = run(cmd, options);
  if (result.status !== 0) {
    throw new Error(`${cmd.join(" ")} exited ${result.status}: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

export function commandExists(name: string): boolean {
  return run(["sh", "-c", `command -v ${quote(name)}`]).status === 0;
}

export interface Sandbox {
  dir: string;
  /** A directory for stub commands, empty until something is written into it. */
  bin: string;
  /** A path inside the sandbox, creating no directories. */
  path(...parts: string[]): string;
  /** Write an executable stub into `bin`, or into `dir` when given a path. */
  stub(name: string, body: string, options?: { shebang?: string }): string;
  mkdir(...parts: string[]): string;
  /** Write a file inside the sandbox, creating its parent directories. */
  write(name: string, contents: string): string;
  /** Read a file inside the sandbox, answering "" for one that was never written. */
  read(name: string): string;
  remove(): void;
}

export function sandbox(prefix: string): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  const bin = join(dir, "bin");
  mkdirSync(bin);

  const path = (...parts: string[]) => join(dir, ...parts);

  return {
    dir,
    bin,
    path,
    stub(name, body, options = {}) {
      // A path is for a stub that has to sit somewhere else, such as a second
      // PATH holding fewer commands.
      const target = name.includes("/") ? path(name) : join(bin, name);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, `${options.shebang ?? "#!/bin/sh"}\n${body}\n`);
      chmodSync(target, 0o755);
      return target;
    },
    mkdir(...parts) {
      const target = path(...parts);
      mkdirSync(target, { recursive: true });
      return target;
    },
    write(name, contents) {
      const target = path(name);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, contents);
      return target;
    },
    read(name) {
      try {
        return readFileSync(path(name), "utf8");
      } catch {
        return "";
      }
    },
    remove() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * A gum stub. `gum spin … -- cmd` runs cmd; `gum log … msg` echoes msg to
 * stderr, where the real gum writes it, so a caller reading stdout through
 * command substitution keeps log lines out of what it captured.
 */
export function stubGum(box: Sandbox): void {
  box.stub(
    "gum",
    [
      'case "$1" in',
      "  spin)",
      "    shift",
      '    while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done',
      '    [ "$1" = "--" ] && shift',
      '    exec "$@"',
      "    ;;",
      "  log)",
      '    for last; do :; done',
      '    printf "%s\\n" "$last" >&2',
      "    ;;",
      "esac",
    ].join("\n"),
  );
}

/** A no-op osascript, so a notification stays silent and side-effect-free. */
export function stubOsascript(box: Sandbox): void {
  box.stub("osascript", "exit 0");
}

export const repoRoot = dirname(dirname(import.meta.dir));

/**
 * Resolve a command the way a login shell does, through one topic's path.zsh.
 *
 * `.zshrc` skips the path files and sources them from `.zshenv` instead, so
 * sourcing one under a chosen $ZSH is what the shell does to it. `zsh -f` keeps
 * the installed root out, which is what makes this read the worktree rather
 * than ~/.dotfiles.
 */
export function resolveOnPath(topic: string, name: string, root = repoRoot): string {
  const resolved = run([
    "zsh",
    "-fc",
    `ZSH=$1; source "$ZSH/${topic}/path.zsh"; command -v ${quote(name)}`,
    "_",
    root,
  ]);
  if (resolved.status !== 0) throw new Error(`${name} did not resolve on PATH: ${resolved.stderr}`);
  return realpathSync(resolved.stdout.trim());
}
