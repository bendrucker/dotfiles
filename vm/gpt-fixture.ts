import { writeFileSync } from "node:fs";
import { crc32 } from "node:zlib";

const SECTOR = 512;
const ENTRIES = 128;
const ENTRY_SIZE = 128;
const TABLE_SECTORS = (ENTRIES * ENTRY_SIZE) / SECTOR;

/** Write a small raw disk image whose GPT holds one partition per type, in order. */
export function writeGptImage(path: string, types: Buffer[], sectors = 256): void {
  const image = Buffer.alloc(sectors * SECTOR);
  const table = Buffer.alloc(ENTRIES * ENTRY_SIZE);
  types.forEach((type, i) => {
    type.copy(table, i * ENTRY_SIZE);
    table.fill(i + 1, i * ENTRY_SIZE + 16, i * ENTRY_SIZE + 32);
    table.writeBigUInt64LE(BigInt(40 + i * 10), i * ENTRY_SIZE + 32);
    table.writeBigUInt64LE(BigInt(49 + i * 10), i * ENTRY_SIZE + 40);
  });

  const last = sectors - 1;
  const header = (current: number, backup: number, tableLba: number): Buffer => {
    const h = Buffer.alloc(SECTOR);
    h.write("EFI PART", 0, "latin1");
    h.writeUInt32LE(0x00010000, 8);
    h.writeUInt32LE(92, 12);
    h.writeBigUInt64LE(BigInt(current), 24);
    h.writeBigUInt64LE(BigInt(backup), 32);
    h.writeBigUInt64LE(BigInt(2 + TABLE_SECTORS), 40);
    h.writeBigUInt64LE(BigInt(last - TABLE_SECTORS - 1), 48);
    h.writeBigUInt64LE(BigInt(tableLba), 72);
    h.writeUInt32LE(ENTRIES, 80);
    h.writeUInt32LE(ENTRY_SIZE, 84);
    h.writeUInt32LE(crc32(table), 88);
    h.writeUInt32LE(crc32(h.subarray(0, 92)), 16);
    return h;
  };

  header(1, last, 2).copy(image, SECTOR);
  table.copy(image, 2 * SECTOR);
  table.copy(image, (last - TABLE_SECTORS) * SECTOR);
  header(last, 1, last - TABLE_SECTORS).copy(image, last * SECTOR);
  writeFileSync(path, image);
}
