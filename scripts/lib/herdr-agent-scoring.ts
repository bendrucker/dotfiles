// herdr scoring a screen, and herdr reporting which manifest it settled on.
//
// The scorer is herdr rather than a re-implementation of its matching semantics.
// An earlier version of the spec ran the patterns through `rg` and passed against
// a rule that matched nothing at all, because herdr ANDs the matchers within a
// rule. Only herdr can say what herdr does with a manifest.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readScreen, screenName, screenText } from "./herdr-agent-screens.ts";

// The manifest a run wants scored, named in words. The path it lands on is a
// throwaway under $TMPDIR, so the label is what a stderr line can usefully name.
export interface ManifestUnderTest {
  label: string;
  text: string;
}

// `ok` is "every screen came back with a state". A short read is a scorer that
// gave up partway, which callers must keep apart from screens that scored
// nothing: the difference decides whether `ablate` is naming a rule that can go
// or reporting a herdr that was not running. The partial scores travel with the
// failure because the count is what the message reports.
export interface Scoring {
  ok: boolean;
  scores: Map<string, string>;
}

export type Serving = { asked: true; source: string } | { asked: false };

// herdr reads an agent manifest out of $XDG_CONFIG_HOME, so a throwaway one puts
// the manifest under test in front of herdr without touching what is installed.
//
// macOS `mktemp` ignores $TMPDIR, which is why the sandbox is placed by
// mkdtempSync over node:os tmpdir() rather than by the shell.
export function scoreScreens(
  agent: string,
  manifest: ManifestUnderTest,
  screens: string[],
  err: (line: string) => void,
): Scoring {
  const scores = new Map<string, string>();
  const herdr = Bun.which("herdr", { PATH: process.env.PATH });

  let sandbox: string;
  try {
    sandbox = mkdtempSync(join(tmpdir(), "herdr-detection-"));
    mkdirSync(join(sandbox, "herdr", "agent-detection"), { recursive: true });
    writeFileSync(join(sandbox, "herdr", "agent-detection", `${agent}.toml`), manifest.text);
  } catch {
    err(`could not stage ${manifest.label} for scoring`);
    return { ok: false, scores };
  }

  const screenFile = join(sandbox, "screen.txt");
  try {
    for (const screen of screens) {
      const name = screenName(screen);
      writeFileSync(screenFile, screenText(readScreen(screen)));
      const output = explain(herdr, sandbox, screenFile, agent);

      // herdr ignores an override it cannot parse and reads the manifest it
      // fetched instead, which scores every screen against upstream while
      // reading as a result for the manifest under test. Taking a rule out to
      // find what it is worth is precisely the operation that produces
      // unparseable TOML, so every score below is worthless without this. herdr
      // marks the fallback by prefixing the path it reports with `remote:`.
      if (field(output, "manifest").startsWith("remote:")) {
        err(`herdr fell back to its own manifest; ${manifest.label} did not load`);
        return { ok: false, scores };
      }

      // A herdr that answered nothing at all, because its server is down or the
      // binary is gone. Recording the empty state would let every caller compare
      // empty against empty: the redundancy check would find both sides equal
      // and report the overlay dead, and ablation would report every rule as
      // moving nothing. A scorer that failed must not read as evidence a rule is
      // unused.
      const state = field(output, "state");
      if (state === "") {
        err(`herdr scored no state for ${name} against ${manifest.label}`);
        return { ok: false, scores };
      }

      scores.set(name, state);
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }

  return { ok: scores.size === screens.length, scores };
}

// Composing onto herdr's cache covers one of the two paths this program knows
// only by convention. This covers the other: the directory it installs into. A
// file written where herdr no longer looks composes, validates and installs
// without complaint, and herdr goes on reading the manifest it fetched, so the
// detection gap comes back looking like herdr never had the rule.
//
// `asked: false` is herdr not answering at all, and it has to stay separate from
// an answer naming something else. The server is not running during every
// install, and no answer must not read as a bad one.
export function servedManifest(agent: string): Serving {
  const herdr = Bun.which("herdr", { PATH: process.env.PATH });
  if (herdr === null) return { asked: false };

  let output: string;
  try {
    const run = Bun.spawnSync({
      cmd: [herdr, "server", "agent-manifests", "--json"],
      env: process.env,
      stdin: "ignore",
      stderr: "ignore",
    });
    output = run.stdout.toString();
  } catch {
    return { asked: false };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return { asked: false };
  }

  if (!isRecord(parsed) || !isRecord(parsed.result)) return { asked: false };
  const manifests = parsed.result.manifests;
  if (!Array.isArray(manifests)) return { asked: false };

  for (const entry of manifests) {
    if (!isRecord(entry) || entry.agent !== agent) continue;
    if (typeof entry.source !== "string") continue;
    return { asked: true, source: entry.source };
  }
  return { asked: false };
}

// An unresolvable or unrunnable herdr answers nothing, which the caller reads as
// a scorer that failed. Bun.spawnSync throws where the shell returned 127, so the
// resolution and the throw both have to land here rather than escaping an
// unattended run partway through.
function explain(
  herdr: string | null,
  sandbox: string,
  screenFile: string,
  agent: string,
): string {
  if (herdr === null) return "";
  try {
    const run = Bun.spawnSync({
      cmd: [herdr, "agent", "explain", "--file", screenFile, "--agent", agent],
      env: { ...process.env, XDG_CONFIG_HOME: sandbox },
      stdin: "ignore",
      stderr: "ignore",
    });
    return run.stdout.toString();
  } catch {
    return "";
  }
}

// herdr prints `key: value` lines. The `manifest:` value is `<path> <version>`,
// so the path is a prefix of the value rather than the whole of it.
function field(output: string, key: string): string {
  const prefix = `${key}: `;
  for (const line of output.split("\n")) {
    if (line.startsWith(prefix)) return line.slice(prefix.length);
  }
  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
