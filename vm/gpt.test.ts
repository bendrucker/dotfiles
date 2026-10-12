import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { APFS_RECOVERY, dropPartitions } from "./gpt.ts";
import { writeGptImage } from "./gpt-fixture.ts";

const SECTOR = 512;
const APFS = Buffer.from("ef57347c0000aa11aa1100306543ecac", "hex");
const ISC = Buffer.from("6964696100006711aa1100306543ecac", "hex");

let dir: string;
let image: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gpt-"));
  image = join(dir, "disk.img");
});

afterEach(() => {
  rmSync(dir, { recursive: true });
});

function tables(): { types: string[]; sealed: boolean }[] {
  const disk = readFileSync(image);
  const backupLba = Number(disk.readBigUInt64LE(SECTOR + 32));
  return [1, backupLba].map((lba) => {
    const header = Buffer.from(disk.subarray(lba * SECTOR, lba * SECTOR + 92));
    const offset = Number(header.readBigUInt64LE(72)) * SECTOR;
    const table = disk.subarray(offset, offset + header.readUInt32LE(80) * header.readUInt32LE(84));
    const headerCrc = header.readUInt32LE(16);
    header.writeUInt32LE(0, 16);
    const types = [0, 1, 2].map((i) => table.subarray(i * 128, i * 128 + 16).toString("hex"));
    return { types, sealed: crc32(header) === headerCrc && crc32(table) === header.readUInt32LE(88) };
  });
}

test("drops the recovery partition from both tables and reseals them", () => {
  writeGptImage(image, [ISC, APFS, APFS_RECOVERY]);
  expect(dropPartitions(image, APFS_RECOVERY)).toBe(1);
  const empty = "0".repeat(32);
  for (const table of tables()) {
    expect(table.types).toEqual([ISC.toString("hex"), APFS.toString("hex"), empty]);
    expect(table.sealed).toBe(true);
  }
});

test("leaves a disk with no recovery partition untouched", () => {
  writeGptImage(image, [ISC, APFS]);
  const before = readFileSync(image);
  expect(dropPartitions(image, APFS_RECOVERY)).toBe(0);
  expect(readFileSync(image).equals(before)).toBe(true);
});

test("refuses an image with no GPT", () => {
  writeFileSync(image, Buffer.alloc(4 * SECTOR));
  expect(() => dropPartitions(image, APFS_RECOVERY)).toThrow("no GPT header");
});
