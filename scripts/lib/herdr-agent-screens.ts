// The pane captures under herdr/agent-detection/screens/<agent>, which are what
// says whether a detection rule still matches anything.
//
// A screen is a capture with every line prefixed `|>`, under `# key: value`
// metadata. The prefix is not decoration: without it these files hold spinner
// lines and agent-tree rows at column 0, which is exactly what the rules match,
// so opening one in a pane would pin that pane at working while it sat idle. Two
// characters rather than one, because a bare `|` reproduces the
// `<non-space><space>` opening the spinner rule keys on.

import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { type Finding, finding } from "./herdr-agent-findings.ts";

const SCREEN_PREFIX = "|>";

// The metadata every screen has to carry. `state` is what the screen should
// score, `claude-code` the CLI version it was captured under.
const REQUIRED_FIELDS = ["state", "claude-code"];

export function screensDir(repo: string, agent: string): string {
  return join(repo, "herdr", "agent-detection", "screens", agent);
}

// Ordered by code unit, so a run's output does not move with the ambient
// locale's collation. An agent with no screens yet returns none, which every
// caller treats as nothing to judge rather than as a judgement that failed.
export function screenFiles(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.endsWith(".txt"))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((name) => join(dir, name));
}

export function screenName(path: string): string {
  return basename(path, ".txt");
}

export function readScreen(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

// The capture the screen holds, with the prefix taken back off. A line without
// the prefix is dropped, which is what makes a screen missing one a finding
// below: the region every rule counts from the bottom shifts under it.
export function screenText(text: string): string {
  return lines(text)
    .filter((line) => line.startsWith(SCREEN_PREFIX))
    .map((line) => `${line.slice(SCREEN_PREFIX.length)}\n`)
    .join("");
}

export function screenField(text: string, key: string): string {
  const prefix = `# ${key}:`;
  for (const line of lines(text)) {
    if (!line.startsWith(prefix)) continue;
    return line.slice(prefix.length).replace(/^ */, "");
  }
  return "";
}

// A line per screen whose shape the harness cannot trust.
//
// Both failures score without complaint and both report as a rule that stopped
// matching. A line missing its `|>` is dropped rather than kept, so the screen
// loses a row and every line-counted region under it shifts. A missing
// `# state:` compares against the empty string and names the screen in a
// mismatch that reads exactly like a real regression.
export function malformedScreens(agent: string, dir: string): Finding[] {
  const findings: Finding[] = [];

  for (const path of screenFiles(dir)) {
    const text = readScreen(path);
    const name = basename(path);

    for (const key of REQUIRED_FIELDS) {
      if (screenField(text, key) === "") {
        findings.push(finding(`${agent}: ${name} has no \`# ${key}:\` line`));
      }
    }

    // A blank line is neither, so a stray one inside a capture is a finding.
    const other = lines(text).filter((line) => !line.startsWith(SCREEN_PREFIX));
    if (other.length > 0 && other.some((line) => !line.startsWith("#"))) {
      findings.push(
        finding(`${agent}: ${name} has a line that is neither \`|>\` screen text nor \`#\` metadata`),
      );
    }
  }

  return findings;
}

// The screens are pane captures, so they age with the CLI that drew them. Claude
// Code moving past all of them is the signal to recapture, because the rules may
// be matching chrome it no longer draws.
//
// Compared at minor version. Claude Code ships patches most days and its chrome
// does not move on that cadence, so comparing the full version would file a
// to-do nightly and teach whoever reads it to close this one unread.
//
// Only claude, since the version has to come from the CLI itself and this is the
// one whose command is known. Another agent's screens age the same way and go
// unwatched until someone writes the probe for it.
export function screensBehindClaude(agent: string, dir: string): Finding[] {
  if (agent !== "claude") return [];

  // Resolved rather than gated on the platform, because a check on the platform
  // cannot be stubbed and this one answers the question the call depends on.
  const claude = Bun.which("claude", { PATH: process.env.PATH });
  if (claude === null) return [];

  const installed = firstField(claudeVersion(claude));
  if (installed === "") return [];

  const versions = screenFiles(dir).map((path) => screenField(readScreen(path), "claude-code"));
  if (versions.length === 0) return [];
  const newest = [...versions].sort(compareVersions)[versions.length - 1];

  // Only when the machine is ahead. A machine pinned to an older release than
  // the screens were taken on has nothing to recapture, and an equality test
  // would send it the same to-do with the sentence pointing the wrong way.
  if (compareVersions(minorVersion(installed), minorVersion(newest)) <= 0) return [];

  // Keyed on the minor pair the comparison above turns on. The installed patch
  // level belongs in the message, where it says what to recapture against, and
  // nowhere near the latch: Claude Code ships patches most days, and a key
  // carrying one refiles this to-do on every release until someone acts.
  return [
    finding(
      `screens were captured under Claude Code ${newest}, this machine runs ${installed}`,
      `${agent}: screens captured under ${minorVersion(newest)}, machine runs ${minorVersion(installed)}`,
    ),
  ];
}

// Ascending. Dot-separated components compare as numbers where both sides spell
// one, and as text otherwise, so a version carrying a suffix still orders
// somewhere rather than throwing the sort.
export function compareVersions(a: string, b: string): number {
  const left = a.split(".");
  const right = b.split(".");

  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const one = left[index] ?? "";
    const other = right[index] ?? "";
    if (one === other) continue;

    const oneNumber = Number(one);
    const otherNumber = Number(other);
    if (Number.isInteger(oneNumber) && Number.isInteger(otherNumber)) {
      return oneNumber - otherNumber;
    }
    return one < other ? -1 : 1;
  }
  return 0;
}

export function minorVersion(version: string): string {
  const last = version.lastIndexOf(".");
  return last === -1 ? version : version.slice(0, last);
}

function claudeVersion(claude: string): string {
  try {
    const run = Bun.spawnSync({
      cmd: [claude, "--version"],
      // Handed over explicitly, so the CLI is resolved against $PATH as it stands
      // at the call rather than the one this process started with.
      env: process.env,
      stdin: "ignore",
      stderr: "ignore",
    });
    return run.stdout.toString();
  } catch {
    return "";
  }
}

// `claude --version` prints `2.1.263 (Claude Code)`.
function firstField(output: string): string {
  return output.trim().split(/\s+/)[0] ?? "";
}

// A file ending in a newline holds no line after it.
function lines(text: string): string[] {
  const split = text.split("\n");
  if (split.length > 0 && split[split.length - 1] === "") split.pop();
  return split;
}
