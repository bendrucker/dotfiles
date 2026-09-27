// Usage: bun exclusions.ts
//
// Keep the rules in exclusions.xml inside Backblaze's editable exclusion file.
//
// The preferences UI excludes absolute folders and file extensions and nothing
// else. A rule that matches a directory by name wherever it appears, like every
// node_modules under every checkout, lives only in this file. Backblaze ships
// its own rules here and merges its updates in, so this owns one block between
// marker comments and replaces that block on every run, leaving the rest alone.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_RULES_FILE = "/Library/Backblaze.bzpkg/bzdata/bzexcluderules_editable.xml";
const BEGIN = "<!-- BEGIN dotfiles: macos/backblaze/exclusions.xml, replaced on every install -->";
const END = "<!-- END dotfiles -->";
const CLOSE = "</bzexclusions>";

/**
 * The children of the root element in exclusions.xml. The tracked file is a
 * whole document so xmllint can check it, and only what is inside the root goes
 * into Backblaze's file.
 */
export function rulesFrom(document: string): string {
  const open = document.indexOf("<bzexclusions>");
  const close = document.lastIndexOf(CLOSE);
  if (open === -1 || close < open) throw new Error("exclusions.xml has no <bzexclusions> root");
  return document.slice(open + "<bzexclusions>".length, close).trim();
}

export function block(rules: string): string {
  return `${BEGIN}\n${rules.trimEnd()}\n${END}\n`;
}

/**
 * Put the managed block into the file's contents, replacing one already there.
 * A new block goes just ahead of the closing tag, which keeps the file valid
 * XML without parsing it.
 */
export function merge(contents: string, rules: string): string {
  const begin = contents.indexOf(BEGIN);
  const end = contents.indexOf(END);

  if (begin === -1 && end === -1) {
    const close = contents.lastIndexOf(CLOSE);
    if (close === -1) throw new Error(`no ${CLOSE} to insert before`);
    return contents.slice(0, close) + block(rules) + contents.slice(close);
  }

  // One marker without the other, or a pair out of order, means something else
  // has edited the block. Replacing a guessed span could cut Backblaze's own
  // rules, so this stops and leaves the file as it is.
  if (begin === -1 || end === -1 || end < begin) throw new Error("managed block markers are unbalanced");

  let after = end + END.length;
  if (contents[after] === "\n") after++;
  return contents.slice(0, begin) + block(rules) + contents.slice(after);
}

function main(): number {
  // A CI runner has no Backblaze, and a runner that someday did is not a
  // machine whose backups this should change.
  if (process.env.CI) return 0;

  const file = process.env.BACKBLAZE_EXCLUDE_RULES || DEFAULT_RULES_FILE;
  // Backblaze creates the file, and recreates it after a deletion, so its
  // absence means Backblaze is not installed here.
  if (!existsSync(file)) return 0;

  const contents = readFileSync(file, "utf8");
  const rules = readFileSync(join(import.meta.dir, "exclusions.xml"), "utf8");

  let merged: string;
  try {
    merged = merge(contents, rulesFrom(rules));
  } catch (error) {
    console.error(`backblaze: ${file}: ${(error as Error).message}, leaving it unchanged`);
    return 1;
  }
  if (merged === contents) return 0;

  // Written in place rather than renamed over. The file is root:wheel 0666 in a
  // directory only root can write, so a rename would need privileges this
  // unattended install must never ask for, and would drop that ownership.
  writeFileSync(file, merged);
  console.error(`backblaze: updated exclusions in ${file}. They apply once Backblaze restarts.`);
  return 0;
}

if (import.meta.main) process.exit(main());
