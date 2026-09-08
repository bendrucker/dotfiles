import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type Check,
  differingPaths,
  foldUnderMarketplace,
  namedPaths,
  type Outcome,
  peeledCommit,
  pileFor,
  plural,
  rawManifestUrl,
  recordedCommit,
  run,
  verdictWord,
} from "./claude-plugin-audit";

// The commit every fixture install records, and by default the one the stubbed
// remote reports, so a repo-backed plugin starts out current.
const RECORDED_SHA = "1111111111111111111111111111111111111111";
const MOVED_SHA = "2222222222222222222222222222222222222222";
const OTHER_SHA = "3333333333333333333333333333333333333333";

// `claude plugin list --json` is the whole of what the inventory asks the CLI
// for, and only ls-remote and rev-parse are asked of git.
const CLAUDE_STUB = `#!/bin/sh
case "$2" in
  list) cat "$HOME/plugin-list.json" ;;
esac
exit 0
`;

const GIT_STUB = `#!/bin/sh
case "$1" in
  ls-remote) printf '%s\\trefs/heads/main\\n' "$REMOTE_SHA" ;;
  -C)        [ "$3" = "rev-parse" ] && printf '%s\\n' "$CLONE_SHA" ;;
esac
exit 0
`;

const environment = { HOME: process.env.HOME, PATH: process.env.PATH };
const network = globalThis.fetch;

let sandbox: string;
let plugins: string;
let installs: { id: string; path: string }[];
let recorded: Map<string, Record<string, string>>;
let listed: Map<string, { name: string; source?: unknown }[]>;
let known: string[];
let fetched: string[];

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "claude-plugin-audit-"));
  plugins = join(sandbox, ".claude", "plugins");
  mkdirSync(plugins, { recursive: true });

  const stubs = join(sandbox, "stub");
  mkdirSync(stubs);
  writeStub(join(stubs, "claude"), CLAUDE_STUB);
  writeStub(join(stubs, "git"), GIT_STUB);

  process.env.HOME = sandbox;
  process.env.PATH = `${stubs}:${environment.PATH}`;
  process.env.REMOTE_SHA = RECORDED_SHA;
  process.env.CLONE_SHA = RECORDED_SHA;

  // No example reaches the network. One that means to read a manifest replaces
  // this, and every other one asserting on a fetch that never happened would
  // otherwise depend on whatever the runner can resolve.
  fetched = [];
  globalThis.fetch = ((input: Request | URL | string) => {
    fetched.push(String(input));
    return Promise.reject(new Error("the spec makes no network calls"));
  }) as typeof fetch;

  installs = [];
  recorded = new Map();
  listed = new Map();
  known = ["first", "third"];
  buildFixture();
});

afterEach(() => {
  process.env.HOME = environment.HOME;
  process.env.PATH = environment.PATH;
  delete process.env.REMOTE_SHA;
  delete process.env.CLONE_SHA;
  globalThis.fetch = network;
  rmSync(sandbox, { recursive: true, force: true });
});

function writeStub(path: string, script: string): void {
  writeFileSync(path, script);
  chmodSync(path, 0o755);
}

function ensure(...segments: string[]): string {
  const path = join(...segments);
  mkdirSync(path, { recursive: true });
  return path;
}

function writeText(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function writeJson(path: string, value: unknown): void {
  writeText(path, `${JSON.stringify(value)}\n`);
}

function install(id: string, path: string): void {
  installs.push({ id, path });
}

// What `claude plugin list --json` reports and what installed_plugins.json
// records, rendered from the same rows so the two always agree. A duplicated id
// keeps one install record, the last one written, which is what an uninstall
// that left its metadata behind produces.
function writePluginList(): void {
  writeJson(
    join(sandbox, "plugin-list.json"),
    installs.map(({ id, path }) => ({ id, scope: "user", enabled: true, installPath: path })),
  );

  const records: Record<string, unknown> = {};
  for (const { id, path } of installs) {
    records[id] = [{ installPath: path, gitCommitSha: RECORDED_SHA, ...recorded.get(id) }];
  }
  writeJson(join(plugins, "installed_plugins.json"), [{ key: "plugins", value: records }]);
}

// The `version` an install records, which Claude Code keeps current. It holds an
// abbreviated commit for a plugin tracked by commit and a version string for one
// that declares a version.
function setInstalledField(id: string, field: string, value: string): void {
  recorded.set(id, { ...recorded.get(id), [field]: value });
  writePluginList();
}

function writeMarketplace(name: string): void {
  writeJson(join(plugins, "marketplaces", name, ".claude-plugin", "marketplace.json"), {
    name,
    plugins: listed.get(name) ?? [],
  });
}

function writeKnownMarketplaces(): void {
  const entries: Record<string, unknown> = {};
  for (const name of known) {
    entries[name] = {
      source: { source: "github", repo: `example/${name}` },
      installLocation: join(plugins, "marketplaces", name),
    };
  }
  writeJson(join(plugins, "known_marketplaces.json"), entries);
}

function writeSettings(): void {
  writeJson(join(sandbox, ".claude", "settings.json"), {
    enabledPlugins: {
      "alpha@first": true,
      "beta@third": true,
      "gamma@first": true,
      "delta@third": true,
      "disabled@first": false,
    },
  });
}

function payload(...segments: string[]): string {
  return join(plugins, "cache", ...segments);
}

function marketplace(...segments: string[]): string {
  return join(plugins, "marketplaces", ...segments);
}

function buildFixture(): void {
  // alpha ships its own .claude-plugin and matches its marketplace, down to the
  // .in_use marker Claude Code writes into the payload at runtime.
  const alpha = ensure(payload("first", "alpha", "1.0.0"));
  const alphaSource = ensure(marketplace("first", "plugins", "alpha"));
  writeJson(join(alphaSource, ".claude-plugin", "plugin.json"), { name: "alpha" });
  cpSync(alphaSource, alpha, { recursive: true });
  writeText(join(alpha, ".in_use"), "");
  install("alpha@first", alpha);

  // beta ships no .claude-plugin, so Claude Code synthesizes one into the
  // payload, and its dependencies land there as node_modules. Neither comes from
  // the marketplace, and neither is drift.
  const beta = ensure(payload("third", "beta", "abc123"));
  const betaSource = ensure(marketplace("third", "plugins", "beta"));
  writeText(join(betaSource, "README.md"), "beta\n");
  cpSync(betaSource, beta, { recursive: true });
  writeJson(join(beta, ".claude-plugin", "plugin.json"), { name: "beta" });
  ensure(beta, "node_modules", "dep");
  install("beta@third", beta);

  // gamma carries a second record left behind by an uninstall, pointing at a
  // payload directory that was never created.
  const gamma = ensure(payload("first", "gamma", "1.0.0"));
  const gammaSource = ensure(marketplace("first", "plugins", "gamma"));
  writeText(join(gammaSource, "README.md"), "gamma\n");
  cpSync(gammaSource, gamma, { recursive: true });
  install("gamma@first", gamma);
  install("gamma@first", payload("first", "gamma", "unknown"));

  // delta lives in its own repo, so it is checked against the commit that repo
  // currently points at.
  install("delta@third", ensure(payload("third", "delta", "1.0.0")));

  listed.set("first", [
    { name: "alpha", source: "./plugins/alpha" },
    { name: "gamma", source: "./plugins/gamma" },
  ]);
  listed.set("third", [
    { name: "beta", source: "./plugins/beta" },
    { name: "delta", source: { source: "github", repo: "example/delta" } },
  ]);
  writeMarketplace("first");
  writeMarketplace("third");

  ensure(marketplace("first", ".git"));
  ensure(marketplace("third", ".git"));
  writeKnownMarketplaces();
  writeSettings();
  writePluginList();
}

// A plugin whose source still offers the version already installed. `claude
// plugin update` compares those two strings, so it changes nothing however far
// the tree behind the version has moved.
function pinAlphaAt(version: string): void {
  writeJson(join(marketplace("first", "plugins", "alpha"), ".claude-plugin", "plugin.json"), {
    name: "alpha",
    version,
  });
  writeJson(join(payload("first", "alpha", "1.0.0"), ".claude-plugin", "plugin.json"), {
    name: "alpha",
    version,
  });
  setInstalledField("alpha@first", "version", version);
}

// An installed plugin its marketplace stopped offering. Nothing can update it,
// so the audit has to name it.
function addOrphan(): void {
  install("ghost@first", ensure(payload("first", "ghost", "1.0.0")));
  writePluginList();
}

// A plugin the marketplace still carries but no longer says where to get.
function dropSource(name: string, from: string): void {
  listed.set(
    from,
    (listed.get(from) ?? []).map((entry) => (entry.name === name ? { name } : entry)),
  );
  writeMarketplace(from);
}

// A marketplace Claude Code materialized from GCS. It has no .git, and records
// the commit it was built from in .gcs-sha, written without a trailing newline.
function materialize(name: string, sha: string): void {
  rmSync(marketplace(name, ".git"), { recursive: true, force: true });
  writeText(marketplace(name, ".gcs-sha"), sha);
}

// A single-plugin marketplace, whose whole tree is the payload. The install gets
// the tree without the provenance marker, which belongs to the marketplace.
function rootSource(name: string, from: string, path: string): void {
  listed.set(
    from,
    (listed.get(from) ?? []).map((entry) => (entry.name === name ? { name, source: "." } : entry)),
  );
  writeMarketplace(from);
  rmSync(path, { recursive: true, force: true });
  cpSync(marketplace(from), path, { recursive: true });
  rmSync(join(path, ".gcs-sha"), { force: true });
  rmSync(join(path, ".git"), { recursive: true, force: true });
}

// Fields on the source a known marketplace records, beyond the repo the fixture
// gives every one of them.
function amendMarketplaceSource(name: string, extra: Record<string, unknown>): void {
  const path = join(plugins, "known_marketplaces.json");
  const entries = JSON.parse(readFileSync(path, "utf8")) as Record<
    string,
    { source: Record<string, unknown> }
  >;
  entries[name].source = { ...entries[name].source, ...extra };
  writeJson(path, entries);
}

// A second install record for one id at the same path, carrying nothing but the
// path, ahead of the record that holds the fields.
function prependBareRecord(id: string): void {
  const path = join(plugins, "installed_plugins.json");
  const held = JSON.parse(readFileSync(path, "utf8")) as {
    key: string;
    value: Record<string, { installPath: string }[]>;
  }[];
  const records = held[0].value;
  records[id] = [{ installPath: records[id][0].installPath }, ...records[id]];
  writeJson(path, held);
}

// Enough enabled-but-uninstalled plugins to carry the report past a pipe
// buffer. Their marketplace does not list them, so each one is a row.
function padEnabledPlugins(count: number): void {
  const path = join(sandbox, ".claude", "settings.json");
  const settings = JSON.parse(readFileSync(path, "utf8")) as {
    enabledPlugins: Record<string, boolean>;
  };
  for (let index = 0; index < count; index += 1) {
    settings.enabledPlugins[`pad${String(index).padStart(4, "0")}@first`] = true;
  }
  writeJson(path, settings);
}

// A marketplace serving installed plugins that known_marketplaces.json never
// names, so its plugins have no marketplace row to be folded under.
function forgetMarketplace(name: string): void {
  known = known.filter((entry) => entry !== name);
  writeKnownMarketplaces();
}

function audit(): Promise<Outcome> {
  return run([]);
}

function lines(outcome: Outcome): string[] {
  return outcome.stdout.split("\n");
}

describe("plural", () => {
  test("keeps a count of one singular and pluralizes everything else", () => {
    expect(plural(1, "path")).toBe("1 path");
    expect(plural(2, "path")).toBe("2 paths");
    expect(plural(0, "check")).toBe("0 checks");
  });
});

describe("differingPaths", () => {
  const payloadRoot = "/cache/beta";
  const sourceRoot = "/marketplaces/third/plugins/beta";

  test("relativizes a differing pair to the payload", () => {
    expect(
      differingPaths(
        [`Files ${payloadRoot}/skills/a.md and ${sourceRoot}/skills/a.md differ`],
        payloadRoot,
        sourceRoot,
      ),
    ).toEqual(["skills/a.md"]);
  });

  // A naive dir + "/" + name produces "/README.md" for a top-level one-sided
  // file, which reads as an absolute path.
  test("emits no leading slash for a one-sided entry at the top level", () => {
    expect(differingPaths([`Only in ${payloadRoot}: README.md`], payloadRoot, sourceRoot)).toEqual([
      "README.md",
    ]);
  });

  test("relativizes a one-sided entry under a subdirectory, from either side", () => {
    expect(
      differingPaths(
        [`Only in ${payloadRoot}/skills: extra.md`, `Only in ${sourceRoot}/skills: gone.md`],
        payloadRoot,
        sourceRoot,
      ),
    ).toEqual(["skills/extra.md", "skills/gone.md"]);
  });

  // A path holding a glob metacharacter was read as a pattern by the shell's
  // prefix strip, which then silently did the wrong thing.
  test("strips the prefix literally", () => {
    const globbed = "/cache/beta[1]";
    expect(
      differingPaths(
        [`Files ${globbed}/README.md and ${sourceRoot}/README.md differ`],
        globbed,
        sourceRoot,
      ),
    ).toEqual(["README.md"]);
  });

  // Anything else diff can say about a pair already names the paths in its own
  // words.
  test("passes a line it does not recognize through", () => {
    expect(differingPaths(["File /cache/beta/pipe is a fifo"], payloadRoot, sourceRoot)).toEqual([
      "File /cache/beta/pipe is a fifo",
    ]);
  });
});

describe("namedPaths", () => {
  test("names up to three and counts the rest", () => {
    expect(namedPaths(["a"])).toBe("a");
    expect(namedPaths(["a", "b", "c"])).toBe("a, b, c");
    expect(namedPaths(["a", "b", "c", "d", "e"])).toBe("a, b, c, and 2 more");
  });
});

describe("recordedCommit", () => {
  // Claude Code keeps `version` current and writes gitCommitSha once, so an
  // in-place update leaves gitCommitSha at the commit the install arrived at.
  test("reads a commit-shaped version the payload does not declare", () => {
    expect(recordedCommit("111111111111", "", OTHER_SHA)).toBe("111111111111");
  });

  test("falls back to gitCommitSha for a version string", () => {
    expect(recordedCommit("1.0.0", "1.0.0", RECORDED_SHA)).toBe(RECORDED_SHA);
  });

  // A version spelled entirely in hex digits is still a version, and the
  // payload's own manifest is the only thing that separates the two.
  test("falls back to gitCommitSha for a hex version the payload declares", () => {
    expect(recordedCommit("20260601", "20260601", RECORDED_SHA)).toBe(RECORDED_SHA);
  });

  // A ref that came back to the commit an install first arrived at would match a
  // payload that has moved on, so there is no fallback from a commit-shaped
  // version that disagrees.
  test("does not fall back when the version disagrees with the manifest", () => {
    expect(recordedCommit("444444444444", "1.0.0", OTHER_SHA)).toBe("444444444444");
  });

  test("reads nothing recorded as nothing", () => {
    expect(recordedCommit("", "", "")).toBe("");
  });
});

describe("peeledCommit", () => {
  // An annotated tag resolves to a tag object, and only its peeled line carries
  // the commit the install would hold.
  test("prefers the first peeled line", () => {
    expect(
      peeledCommit(`${RECORDED_SHA}\trefs/tags/v1\n${MOVED_SHA}\trefs/tags/v1^{}\n`),
    ).toBe(MOVED_SHA);
  });

  test("falls back to the first line", () => {
    expect(peeledCommit(`${RECORDED_SHA}\trefs/heads/main\n`)).toBe(RECORDED_SHA);
  });

  test("reads no output as no commit", () => {
    expect(peeledCommit("")).toBe("");
  });
});

describe("verdict classification", () => {
  test("counts current, banks unknown as unverified, and drifts the rest", () => {
    expect(pileFor("current")).toBe("current");
    expect(pileFor("unknown")).toBe("unverified");
    expect(pileFor("stale")).toBe("drifted");
    expect(pileFor("pinned")).toBe("drifted");
    expect(pileFor("orphaned")).toBe("drifted");
  });

  // The word `unknown` never reaches stdout: every spec assertion, and the
  // reader, looks for the bucket by the word `unverified`.
  test("writes an unknown verdict into the row as unverified", () => {
    expect(verdictWord("unknown")).toBe("unverified");
    expect(verdictWord("stale")).toBe("stale");
  });
});

describe("foldUnderMarketplace", () => {
  const current: Check = { verdict: "current", detail: "" };
  const stale: Check = { verdict: "stale", detail: "differs" };

  test("keeps a plugin whose marketplace is vouched for", () => {
    expect(foldUnderMarketplace(current, "first", true, true)).toEqual({
      fold: false,
      check: current,
    });
  });

  test("folds a current plugin into an unvouched marketplace that has a row", () => {
    expect(foldUnderMarketplace(current, "first", false, true)).toEqual({ fold: true });
  });

  // Folding needs a marketplace row to fold into.
  test("keeps a current plugin whose marketplace was never listed", () => {
    expect(foldUnderMarketplace(current, "first", false, false)).toEqual({
      fold: false,
      check: {
        verdict: "unknown",
        detail: "matches marketplace first, which is itself unverified",
      },
    });
  });

  // A plugin whose own check said something else is a separate answer.
  test("keeps the verdict of a plugin that drifted under an unvouched marketplace", () => {
    expect(foldUnderMarketplace(stale, "first", false, true)).toEqual({ fold: false, check: stale });
  });
});

describe("rawManifestUrl", () => {
  test("addresses a GitHub repository's manifest at one commit", () => {
    const manifest = `https://raw.githubusercontent.com/example/delta/${RECORDED_SHA}/.claude-plugin/plugin.json`;
    expect(rawManifestUrl("https://github.com/example/delta", RECORDED_SHA)).toBe(manifest);
    expect(rawManifestUrl("https://github.com/example/delta.git", RECORDED_SHA)).toBe(manifest);
    expect(rawManifestUrl("git@github.com:example/delta.git", RECORDED_SHA)).toBe(manifest);
  });

  // Every other host would need a clone, which this runs against every installed
  // plugin every night.
  test("declines a host it cannot address a single file on", () => {
    expect(rawManifestUrl("https://gitlab.com/example/delta", RECORDED_SHA)).toBeUndefined();
    expect(rawManifestUrl("https://github.com/example", RECORDED_SHA)).toBeUndefined();
  });
});

describe("the audit over a payload tree", () => {
  test("passes when every payload matches its marketplace", async () => {
    const result = await audit();
    expect(result.status).toBe(0);
    // The marketplaces are checked alongside the plugins, so four plugins under
    // two marketplaces is six.
    expect(result.stdout).toContain("6 checks current");
  });

  test("prints the usage for --help and refuses any other argument", async () => {
    expect(await run(["--help"])).toMatchObject({
      status: 0,
      stdout: expect.stringContaining("Usage: claude-plugin-audit"),
    });
    expect(await run(["--everything"])).toMatchObject({
      status: 1,
      stdout: "",
      stderr: "claude-plugin-audit: unknown option --everything\n",
    });
  });

  // The marketplace clones are what every payload is compared against, and
  // `claude plugin marketplace update` only warns when it fails.
  test("flags a marketplace clone behind its source", async () => {
    process.env.CLONE_SHA = OTHER_SHA;
    const result = await audit();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("marketplace/first");
    expect(result.stdout).toContain("stale");
  });

  // A marketplace tree advances with the ref it follows, so a sha recorded
  // beside that ref is not what its freshness is measured against. Reading it
  // reported a marketplace that had done exactly what it was tracking as stale,
  // and folded away every plugin under it.
  test("checks a marketplace against the ref it tracks, not a sha beside it", async () => {
    amendMarketplaceSource("first", { sha: MOVED_SHA, ref: "main" });
    const result = await audit();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("6 checks current");
  });

  // Treating a materialized marketplace as unverifiable demoted every plugin
  // served by the official marketplace along with it.
  test("vouches for a GCS marketplace whose recorded sha matches its source", async () => {
    materialize("first", RECORDED_SHA);
    const result = await audit();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("6 checks current");
  });

  test("flags a GCS marketplace behind its source", async () => {
    materialize("first", OTHER_SHA);
    const result = await audit();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("marketplace/first");
    expect(result.stdout).toContain("stale");
    expect(result.stdout).toContain("333333333333");
  });

  // .gcs-sha belongs to the marketplace, not to the payload installed from it,
  // so on a marketplace whose whole tree is the plugin it sits on one side of
  // the comparison only. Left in, it reports a current payload as stale nightly.
  test("does not count a marketplace's own .gcs-sha as payload drift", async () => {
    materialize("first", RECORDED_SHA);
    rootSource("alpha", "first", payload("first", "alpha", "1.0.0"));
    const result = await audit();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("6 checks current");
  });

  // A marker that is not a commit says nothing about the tree, so it belongs
  // with the unverifiable results rather than being reported as drift.
  test("reports a GCS marketplace with an unusable .gcs-sha as unverified", async () => {
    materialize("first", "not-a-commit");
    const result = await audit();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("marketplace/first");
    expect(result.stdout).toContain("no readable source commit");
  });

  test("reports a marketplace carrying neither marker as unverified without failing", async () => {
    rmSync(marketplace("first", ".git"), { recursive: true, force: true });
    const result = await audit();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("marketplace/first");
    expect(result.stdout).toContain("unverified");
    expect(result.stdout).toContain("neither a git clone");
  });

  // A stale clone matches every stale payload under it, so calling those current
  // is how one unchecked marketplace hides every install it serves. Neither are
  // they separate answers: a row per plugin restated one unverifiable
  // marketplace as four more rows carrying nothing it did not already say.
  test("folds the payloads it cannot vouch for into their marketplace's row", async () => {
    rmSync(marketplace("first", ".git"), { recursive: true, force: true });
    const result = await audit();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("marketplace/first");
    expect(result.stdout).toContain("2 plugins unverified with it");
    expect(result.stdout).not.toContain("alpha@first");
    expect(result.stdout).not.toContain("gamma@first");
    // Folded is not checked. The two stay out of the current count.
    expect(result.stdout).toContain("3 checks current");
  });

  test("keeps the verdict of a plugin that drifted under an unvouched marketplace", async () => {
    rmSync(marketplace("first", ".git"), { recursive: true, force: true });
    rmSync(join(payload("first", "gamma", "1.0.0"), "README.md"));
    const result = await audit();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("gamma@first");
    expect(result.stdout).toContain("stale");
    expect(result.stdout).toContain("1 plugin unverified with it");
  });

  test("keeps the row for a plugin whose marketplace is not listed at all", async () => {
    forgetMarketplace("third");
    const result = await audit();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("beta@third");
    expect(result.stdout).toContain("itself unverified");
  });

  // "differs at 1 path" with the path thrown away left a nightly report naming a
  // plugin and nothing to go and look at.
  test("names the path a payload differs at", async () => {
    writeText(join(payload("third", "beta", "abc123"), "README.md"), "changed\n");
    const result = await audit();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("beta@third");
    expect(result.stdout).toContain("1 path: README.md");
  });

  // diff names a one-sided path against the directory holding it, which is an
  // absolute path into the cache. The plugin id already says which install.
  test("names a nested path only the payload has", async () => {
    ensure(marketplace("third", "plugins", "beta", "skills"));
    writeText(join(payload("third", "beta", "abc123"), "skills", "extra.md"), "extra\n");
    const result = await audit();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("1 path: skills/extra.md");
  });

  test("names the first few paths and counts the rest", async () => {
    for (const index of [1, 2, 3, 4, 5]) {
      writeText(join(payload("third", "beta", "abc123"), `file${index}.md`), "payload\n");
      writeText(join(marketplace("third", "plugins", "beta"), `file${index}.md`), "source\n");
    }
    const result = await audit();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("5 paths: file1.md, file2.md, file3.md, and 2 more");
  });

  // Separated by a blank line and nothing else, the two blocks read as one flat
  // list in a plain-text note, so a correct "1 finding" looked wrong against the
  // rows above it.
  test("labels the unverified rows and the findings as separate blocks", async () => {
    rmSync(marketplace("first", ".git"), { recursive: true, force: true });
    rmSync(join(payload("third", "beta", "abc123"), "README.md"));
    const result = await audit();
    expect(result.status).toBe(1);
    expect(lines(result)[0]).toBe("Unverified (could not check):");
    expect(result.stdout).toContain("Findings (act on these):");
    expect(result.stdout).toContain("1 finding to act on (2 current)");
  });

  // An inventory that could not be read is not an empty one. Reporting
  // everything current over it is the silence this tool exists to break.
  test("refuses to report on an inventory it could not read", async () => {
    writeText(join(sandbox, ".claude", "settings.json"), "not json\n");
    const result = await audit();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("could not enumerate");
    // The marketplace verdicts already computed must not leak out.
    expect(result.stdout).not.toContain("current");
  });

  test("refuses to report on a marketplace list it could not read", async () => {
    writeText(join(plugins, "known_marketplaces.json"), "not json\n");
    const result = await audit();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("could not enumerate marketplaces");
    expect(result.stdout).toBe("");
  });

  test("flags a payload that lost a file", async () => {
    rmSync(join(payload("third", "beta", "abc123"), "README.md"));
    const result = await audit();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("beta@third");
    expect(result.stdout).toContain("stale");
  });

  // A plugin that ships its own .claude-plugin stays compared. Excluding the
  // directory outright to spare the plugins Claude Code synthesizes one for
  // would blind the audit to every manifest change.
  test("flags a payload whose manifest fell behind", async () => {
    writeJson(join(marketplace("first", "plugins", "alpha"), ".claude-plugin", "plugin.json"), {
      name: "alpha",
      version: "2",
    });
    const result = await audit();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("alpha@first");
    expect(result.stdout).toContain("stale");
  });

  test("flags a payload behind the commit its repo points at", async () => {
    process.env.REMOTE_SHA = MOVED_SHA;
    const result = await audit();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("delta@third");
    expect(result.stdout).toContain("222222222222");
  });

  // Reading only the lagging gitCommitSha reported a current plugin stale every
  // night, and no update cleared it. The updater agreed it was already current.
  test("reads the commit from the version Claude Code keeps current", async () => {
    setInstalledField("delta@third", "gitCommitSha", OTHER_SHA);
    setInstalledField("delta@third", "version", "111111111111");
    const result = await audit();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("6 checks current");
  });

  // Claude Code can keep several records for one install path, and a record that
  // carries none of the fields answers for none of them. Stopping at the first
  // match reported an install whose commit is recorded on the next record as
  // having no commit recorded at all.
  test("reads a field recorded on a later record for the same install", async () => {
    prependBareRecord("delta@third");
    const result = await audit();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("6 checks current");
  });

  test("flags a payload when neither recorded commit matches", async () => {
    setInstalledField("delta@third", "gitCommitSha", OTHER_SHA);
    setInstalledField("delta@third", "version", "444444444444");
    const result = await audit();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("delta@third");
    expect(result.stdout).toContain("installed 444444444444");
  });

  test("does not read a version string as a commit", async () => {
    setInstalledField("delta@third", "version", "1.0.0");
    const result = await audit();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("6 checks current");
  });

  test("does not read a declared hex-shaped version as a commit", async () => {
    writeJson(join(payload("third", "delta", "1.0.0"), ".claude-plugin", "plugin.json"), {
      name: "delta",
      version: "20260601",
    });
    setInstalledField("delta@third", "version", "20260601");
    const result = await audit();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("6 checks current");
  });

  // gitCommitSha lags an in-place update, so a ref that came back to the commit
  // an install first arrived at would match it while the payload sits elsewhere.
  test("does not let the install commit stand in for a version that moved on", async () => {
    setInstalledField("delta@third", "version", "222222222222");
    const result = await audit();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("delta@third");
    expect(result.stdout).toContain("installed 222222222222");
    // A recorded commit is not a version any source can still be offering, so
    // nothing goes looking for a manifest.
    expect(fetched).toEqual([]);
  });

  // Stale clears on the next nightly update. This does not, so reporting it as
  // stale left a finding that came back every night with nothing to do about it.
  test("separates a payload no update can reach from one that is merely stale", async () => {
    pinAlphaAt("1.0.0");
    writeText(join(payload("first", "alpha", "1.0.0"), "README.md"), "changed\n");
    const result = await audit();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("alpha@first");
    expect(result.stdout).toContain("pinned");
    expect(result.stdout).toContain("still offered as 1.0.0");
  });

  // A source offering a version the install does not hold is what an update acts
  // on, so it stays plain staleness.
  test("calls a payload whose source moved past the installed version stale", async () => {
    pinAlphaAt("1.0.0");
    writeJson(join(marketplace("first", "plugins", "alpha"), ".claude-plugin", "plugin.json"), {
      name: "alpha",
      version: "2.0.0",
    });
    const result = await audit();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("alpha@first");
    expect(result.stdout).toContain("stale");
    expect(result.stdout).not.toContain("pinned");
  });

  test("flags a plugin its marketplace dropped", async () => {
    addOrphan();
    const result = await audit();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("ghost@first");
    expect(result.stdout).toContain("orphaned");
  });

  // Only a marketplace that stopped listing the plugin is beyond updating.
  test("does not call a plugin orphaned while its marketplace still lists it", async () => {
    dropSource("alpha", "first");
    const result = await audit();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("alpha@first");
    expect(result.stdout).toContain("unverified");
    expect(result.stdout).not.toContain("orphaned");
  });

  // A file the audit cannot read is not a file that changed. Reporting it as
  // drift files a to-do that no plugin update can ever clear.
  test.skipIf(process.getuid?.() === 0)(
    "reports an unreadable payload as unverified rather than stale",
    async () => {
      chmodSync(join(payload("third", "beta", "abc123"), "README.md"), 0o000);
      const result = await audit();
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("beta@third");
      expect(result.stdout).toContain("could not compare");
    },
  );

  // A comparison that failed says nothing about the payload whether or not diff
  // explained itself. Taking the message as the only signal left the payload
  // reported as differing at no paths at all, which is a finding no update
  // clears.
  test("reports a comparison that failed silently as unverified", async () => {
    writeStub(join(sandbox, "stub", "diff"), "#!/bin/sh\nexit 2\n");
    const result = await audit();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("could not compare");
    expect(result.stdout).not.toContain("differs from");
  });

  // macOS diff exits 0 here, having written only to stderr, so a payload with a
  // path nothing could compare would otherwise be reported as current.
  test("reports a payload it could not fully read as unverified", async () => {
    const readme = join(payload("third", "beta", "abc123"), "README.md");
    rmSync(readme);
    symlinkSync("nowhere", readme);
    const result = await audit();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("beta@third");
    expect(result.stdout).toContain("could not compare");
  });
});

// The gap the shell left: `pinned` was reachable only from a marketplace-relative
// source, so a repo-backed plugin in the same unreachable-by-update state was
// reported stale every night with nothing to do about it.
describe("a repo-backed payload no update can reach", () => {
  beforeEach(() => {
    writeJson(join(payload("third", "delta", "1.0.0"), ".claude-plugin", "plugin.json"), {
      name: "delta",
      version: "1.0.0",
    });
    setInstalledField("delta@third", "version", "1.0.0");
    process.env.REMOTE_SHA = MOVED_SHA;
  });

  test("reports it pinned when the source still offers the installed version", async () => {
    globalThis.fetch = ((input: Request | URL | string) => {
      fetched.push(String(input));
      return Promise.resolve(new Response(JSON.stringify({ name: "delta", version: "1.0.0" })));
    }) as typeof fetch;

    const result = await audit();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("delta@third");
    expect(result.stdout).toContain("pinned");
    expect(result.stdout).toContain("still offered as 1.0.0");
    // The manifest is read at the commit the ref resolves to, one file at a
    // time, because cloning every plugin's repo nightly is not affordable.
    expect(fetched).toEqual([
      `https://raw.githubusercontent.com/example/delta/${MOVED_SHA}/.claude-plugin/plugin.json`,
    ]);
  });

  test("reports it stale when the source moved past the installed version", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(new Response(JSON.stringify({ version: "2.0.0" })))) as typeof fetch;

    const result = await audit();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("delta@third");
    expect(result.stdout).toContain("stale");
    expect(result.stdout).not.toContain("pinned");
  });

  // The job runs unattended at 3am, so a host that cannot be reached leaves the
  // verdict where the commits put it rather than inventing one.
  test("falls back to stale when the manifest cannot be read", async () => {
    const result = await audit();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("delta@third");
    expect(result.stdout).toContain("stale");
    expect(result.stdout).not.toContain("pinned");
  });

  test("falls back to stale for a host it cannot read one file from", async () => {
    listed.set("third", [
      { name: "beta", source: "./plugins/beta" },
      { name: "delta", source: { source: "git", url: "https://git.example/delta.git" } },
    ]);
    writeMarketplace("third");

    const result = await audit();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("delta@third");
    expect(result.stdout).toContain("stale");
    expect(fetched).toEqual([]);
  });
});

// bin/claude-sync runs the executable with its stdout on a pipe, and reads
// the summary line out of what comes back.
describe("the executable", () => {
  test("delivers a report longer than a pipe buffer whole", () => {
    const pads = 3000;
    padEnabledPlugins(pads);

    // Through a pipe deliberately: a write that outruns the reader is what the
    // process exit used to discard, and a redirect to a file never blocks.
    const run = Bun.spawnSync({
      cmd: ["sh", "-c", '"$0" </dev/null | cat', join(import.meta.dir, "claude-plugin-audit")],
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });

    const report = run.stdout.toString();
    expect(report.length).toBeGreaterThan(131072);
    expect(report.trimEnd().split("\n").at(-1)).toBe(`${pads} findings to act on (6 current)`);
  });
});
