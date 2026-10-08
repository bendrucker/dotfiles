import { expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const manifest = Bun.TOML.parse(readFileSync(join(import.meta.dir, "herdr-plugin.toml"), "utf8"));
const config = readFileSync(join(import.meta.dir, "..", "config.toml"), "utf8");

test("prefix+alt+f invokes the manifest's open action", () => {
  expect(manifest).toMatchObject({ id: "bendrucker.cleanup", actions: [{ id: "open" }] });
  expect(config).toContain('command = "bendrucker.cleanup.open"');
});

test("the board opens as an overlay, which keeps its pane ids", () => {
  expect(manifest).toMatchObject({ panes: [{ id: "board", placement: "overlay" }] });
});

test("the entrypoint is executable", () => {
  expect(statSync(join(import.meta.dir, "bin", "herdr-cleanup")).mode & 0o111).not.toBe(0);
});
