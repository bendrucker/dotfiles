import { closeSync, openSync, readSync, writeSync } from "node:fs";
import { crc32 } from "node:zlib";

const SECTOR = 512;
const SIGNATURE = "EFI PART";

// GPT stores a GUID's first three fields little-endian.
function guidBytes(guid: string): Buffer {
  const hex = guid.replaceAll("-", "");
  const bytes = Buffer.from(hex, "hex");
  bytes.subarray(0, 4).reverse();
  bytes.subarray(4, 6).reverse();
  bytes.subarray(6, 8).reverse();
  return bytes;
}

export const APFS_RECOVERY = guidBytes("52637672-7900-11AA-AA11-00306543ECAC");

function readAt(fd: number, offset: number, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  readSync(fd, buffer, 0, length, offset);
  return buffer;
}

// Drops every entry of `type` from the table a header points at, then reseals
// both checksums. Returns how many entries it dropped.
function dropFromTable(fd: number, headerLba: number, type: Buffer): number {
  const header = readAt(fd, headerLba * SECTOR, SECTOR);
  if (header.toString("latin1", 0, 8) !== SIGNATURE) throw new Error(`no GPT header at LBA ${headerLba}`);
  const headerSize = header.readUInt32LE(12);
  const tableOffset = Number(header.readBigUInt64LE(72)) * SECTOR;
  const entrySize = header.readUInt32LE(84);
  const table = readAt(fd, tableOffset, header.readUInt32LE(80) * entrySize);

  let dropped = 0;
  for (let offset = 0; offset < table.length; offset += entrySize) {
    if (table.subarray(offset, offset + 16).equals(type)) {
      table.fill(0, offset, offset + entrySize);
      dropped++;
    }
  }
  if (dropped === 0) return 0;

  header.writeUInt32LE(crc32(table), 88);
  header.writeUInt32LE(0, 16);
  header.writeUInt32LE(crc32(header.subarray(0, headerSize)), 16);
  writeSync(fd, table, 0, table.length, tableOffset);
  writeSync(fd, header, 0, SECTOR, headerLba * SECTOR);
  return dropped;
}

/**
 * Remove the partitions of `type` from a raw disk image's primary and backup
 * GPT, leaving their space free. Returns how many it removed from the primary.
 */
export function dropPartitions(image: string, type: Buffer): number {
  const fd = openSync(image, "r+");
  try {
    const primary = readAt(fd, SECTOR, SECTOR);
    const backupLba = Number(primary.readBigUInt64LE(32));
    const dropped = dropFromTable(fd, 1, type);
    dropFromTable(fd, backupLba, type);
    return dropped;
  } finally {
    closeSync(fd);
  }
}
