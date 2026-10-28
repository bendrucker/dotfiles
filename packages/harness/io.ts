// A scripted Io for tests. Commands are answered from a table by argv prefix
// instead of spawning, logs and picks are answered in-process, and everything
// asked of it is recorded.

import { type Capture, type ChooseOptions, type Level, NOT_RUN, type Result, spawn, type SpawnOptions } from "#io";

export interface Answer {
  argv: string[];
  status?: number;
  stdout?: string;
  stderr?: string;
}

export interface FakeIoOptions {
  // Checked in order, so a narrower prefix listed first wins over a broader one.
  answers?: Answer[];
  // What each successive `choose` returns. An exhausted queue returns [].
  choices?: string[][];
  // Spawn an unmatched command for real, with stdout and stderr piped, rather
  // than answering 127.
  passthrough?: boolean;
}

export interface Call {
  method: "run" | "read";
  argv: string[];
  options?: SpawnOptions;
}

export interface LogLine {
  level: Level;
  message: string;
}

export interface Prompt {
  items: string[];
  options?: ChooseOptions;
}

export interface FakeIo extends Capture {
  calls: Call[];
  logs: LogLine[];
  prompts: Prompt[];
  // Appended to while the fake is in use, for a case that scripts a reply
  // after building the context it hands over.
  answers: Answer[];
}

export function fakeIo(options: FakeIoOptions = {}): FakeIo {
  const answers = [...(options.answers ?? [])];
  const choices = [...(options.choices ?? [])];
  const calls: Call[] = [];
  const logs: LogLine[] = [];
  const prompts: Prompt[] = [];
  const chunks: string[] = [];
  const keep = (text: string): void => {
    if (text !== "") chunks.push(text);
  };

  const answer = (method: Call["method"], argv: string[], spawnOptions?: SpawnOptions): Result => {
    calls.push({ method, argv, options: spawnOptions });
    const match = answers.find((candidate) => startsWith(argv, candidate.argv));
    if (match !== undefined) {
      return { status: match.status ?? 0, stdout: match.stdout ?? "", stderr: match.stderr ?? "" };
    }
    if (!options.passthrough) return { status: NOT_RUN, stdout: "", stderr: "" };
    const stdin = spawnOptions?.stdin === undefined || spawnOptions.stdin === "inherit" ? "ignore" : spawnOptions.stdin;
    const { status, stdout, stderr } = spawn(argv, { ...spawnOptions, stdin }, "pipe", "pipe");
    return { status, stdout, stderr };
  };

  // The child's stderr lands where the real adapters route it.
  const routeStderr = (result: Result, spawnOptions?: SpawnOptions): string => {
    const stderr = spawnOptions?.stderr ?? "log";
    if (stderr === "log") keep(result.stderr);
    return stderr === "pipe" ? result.stderr : "";
  };

  const read = (argv: string[], spawnOptions?: SpawnOptions): Result => {
    const result = answer("read", argv, spawnOptions);
    return { status: result.status, stdout: result.stdout, stderr: routeStderr(result, spawnOptions) };
  };

  return {
    calls,
    logs,
    prompts,
    answers,
    write(_fd, text) {
      keep(text);
    },
    run(argv, spawnOptions) {
      const result = answer("run", argv, spawnOptions);
      keep(result.stdout);
      routeStderr(result, spawnOptions);
      return result.status;
    },
    read,
    async readAsync(argv, spawnOptions) {
      return read(argv, spawnOptions);
    },
    log(level, message) {
      logs.push({ level, message });
      keep(`${message}\n`);
    },
    // A pick the prompt never offered fails the test, so a case cannot pass
    // against a prompt that dropped or renamed the option it asks for.
    choose(items, chooseOptions) {
      prompts.push({ items, options: chooseOptions });
      const picks = choices.shift() ?? [];
      const missing = picks.find((pick) => !items.includes(pick));
      if (missing !== undefined) throw new Error(`fakeIo choose: ${JSON.stringify(missing)} was not offered`);
      return picks;
    },
    captured() {
      return chunks.join("");
    },
  };
}

function startsWith(argv: string[], prefix: string[]): boolean {
  return prefix.length <= argv.length && prefix.every((word, index) => argv[index] === word);
}
