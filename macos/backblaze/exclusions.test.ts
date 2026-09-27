// Drives the real script against a sandbox copy of Backblaze's editable rules
// file, named through BACKBLAZE_EXCLUDE_RULES, so no test touches /Library.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { run, sandbox, type Run, type Sandbox } from "#harness";
import { block, merge, rulesFrom } from "./exclusions.ts";

const script = join(import.meta.dir, "exclusions.ts");
const rules = rulesFrom(readFileSync(join(import.meta.dir, "exclusions.xml"), "utf8"));

const shipped = [
  '<?xml version="1.0" encoding="UTF-8" ?>',
  "<bzexclusions>",
  '<excludefname_rule plat="mac" osVers="*"  ruleIsOptional="t" skipFirstCharThenStartsWith="users/" contains_1="/itunes/" contains_2="*" doesNotContain="*" endsWith="*" hasFileExtension="*" />',
  '<excludefname_rule bzmergeblock="002" plat="mac" osVers="*"  ruleIsOptional="t" skipFirstCharThenStartsWith="users/" contains_1="/library/containers/com.docker.docker/" contains_2="*" doesNotContain="*" endsWith="*" hasFileExtension="*" />',
  "</bzexclusions>",
  "",
].join("\n");

let box: Sandbox;
let file: string;

beforeEach(() => {
  box = sandbox("backblaze");
  file = box.write("bzexcluderules_editable.xml", shipped);
});

afterEach(() => {
  box.remove();
});

function install(env: Record<string, string | undefined> = {}): Run {
  // CI is unset so the examples exercise the merge when the suite itself runs in CI.
  return run(["bun", script], { env: { BACKBLAZE_EXCLUDE_RULES: file, CI: undefined, ...env } });
}

function contents(): string {
  return box.read("bzexcluderules_editable.xml");
}

describe("macos/backblaze/exclusions.ts", () => {
  test("inserts the rules ahead of the closing tag on a fresh file", () => {
    const r = install();
    expect(r.status).toBe(0);
    expect(contents()).toBe(shipped.replace("</bzexclusions>", `${block(rules)}</bzexclusions>`));
  });

  test("keeps Backblaze's own rules", () => {
    install();
    expect(contents()).toContain('bzmergeblock="002"');
    expect(contents()).toContain('contains_1="/itunes/"');
  });

  // The nightly install runs this every time. A second write would be harmless
  // to the rules but would still touch a file Backblaze watches.
  test("changes nothing on a re-run", () => {
    install();
    const first = contents();
    const r = install();
    expect(r.status).toBe(0);
    expect(contents()).toBe(first);
    expect(r.stderr).toBe("");
  });

  test("replaces an older block rather than adding a second", () => {
    box.write("bzexcluderules_editable.xml", merge(shipped, '<excludefname_rule contains_1="/old/" />'));
    const r = install();
    expect(r.status).toBe(0);
    expect(contents()).not.toContain("/old/");
    expect(contents().split("BEGIN dotfiles").length).toBe(2);
    expect(contents()).toBe(merge(shipped, rules));
  });

  test("replaces a block installed under differently worded markers", () => {
    const reworded = "<!-- BEGIN dotfiles, an older wording -->\n<old />\n<!-- END dotfiles, older -->\n";
    box.write("bzexcluderules_editable.xml", shipped.replace("</bzexclusions>", `${reworded}</bzexclusions>`));
    const r = install();
    expect(r.status).toBe(0);
    expect(contents()).toBe(merge(shipped, rules));
  });

  test("reports an unreadable file in one line", () => {
    chmodSync(file, 0o000);
    const r = install();
    expect(r.status).toBe(1);
    expect(r.stderr.trim().split("\n")).toEqual([expect.stringMatching(/^backblaze: .*permission denied/i)]);
  });

  test("leaves the file alone when only one marker is there", () => {
    const broken = shipped.replace("</bzexclusions>", `${block(rules).split("\n")[0]}\n</bzexclusions>`);
    box.write("bzexcluderules_editable.xml", broken);
    const r = install();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("unbalanced");
    expect(contents()).toBe(broken);
  });

  test("does nothing where Backblaze is not installed", () => {
    const missing = box.path("absent", "bzexcluderules_editable.xml");
    const r = install({ BACKBLAZE_EXCLUDE_RULES: missing });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    expect(box.read("absent/bzexcluderules_editable.xml")).toBe("");
  });

  test.each<{ name: string; root: string }>([
    { name: "a bare root", root: "<bzexclusions>" },
    { name: "a root with an attribute", root: '<bzexclusions version="1">' },
  ])("reads the rules inside $name", ({ root }) => {
    expect(rulesFrom(`<?xml version="1.0" ?>\n${root}\n<rule />\n</bzexclusions>\n`)).toBe("<rule />");
  });

  test("does nothing in CI", () => {
    const r = install({ CI: "true" });
    expect(r.status).toBe(0);
    expect(contents()).toBe(shipped);
  });
});
