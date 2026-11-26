import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { sandbox, type Sandbox } from "#harness";
import { up } from "./202611190001-remove-android-file-transfer";

let box: Sandbox;

beforeEach(() => {
  box = sandbox("remove-android-file-transfer");
});

afterEach(() => {
  box.remove();
});

async function withPath(path: string, body: () => Promise<void>): Promise<void> {
  const original = process.env.PATH;
  process.env.PATH = path;
  try {
    await body();
  } finally {
    process.env.PATH = original;
  }
}

describe("remove-android-file-transfer", () => {
  test("uninstalls the cask", async () => {
    const calls = box.path("calls");
    box.stub("brew", `echo "$*" >> "${calls}"; [ "$1" = list ] && echo android-file-transfer; exit 0`);

    await withPath(box.bin, () => up());

    expect(readFileSync(calls, "utf8")).toContain("uninstall --cask android-file-transfer");
  });

  test("a machine without brew is untouched", async () => {
    await withPath("", () => up());
  });
});
