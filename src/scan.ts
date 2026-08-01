import * as fs from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { decode, guardRecordSize } from "./record.js";
import type { WalEntry } from "./types.js";
import { isMissing } from "./validate.js";

/**
 * Walk a file one complete line at a time, holding one line plus one chunk
 * rather than the file. The startup scan and compaction both need exactly
 * this, and both run against the largest logs by definition — which is the
 * case they exist for.
 *
 * The trailing remainder is delivered only if it is non-empty: a log left by
 * healTail ends in a newline, so an empty tail is the absence of a record
 * rather than a blank one.
 */
export function forEachLine(
  fd: number,
  maxReadEntryBytes: number | null,
  onLine: (line: string) => void,
): void {
  const chunk = Buffer.allocUnsafe(64 * 1024);
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let bytesRead: number;
  do {
    bytesRead = fs.readSync(fd, chunk);
    pending += decoder.write(chunk.subarray(0, bytesRead));
    guardRecordSize(pending.length, maxReadEntryBytes);
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) onLine(line);
  } while (bytesRead > 0);
  pending += decoder.end();
  if (pending) onLine(pending);
}

export function readEntries<T>(path: string): Array<WalEntry<T>> {
  let raw: string;
  try {
    raw = fs.readFileSync(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const lines = raw.split("\n").filter(Boolean);
  return lines.map((line) => decode<T>(line));
}

export interface WalAccounting {
  lastSeq: number;
  bytes: number;
  reclaimableBytes: number;
  /**
   * Sequence number and byte length of each record above the checkpoint, in
   * order. Parallel arrays rather than objects: two numbers per pending record
   * instead of an object header each, on the one structure here that grows.
   */
  pendingSeqs: number[];
  pendingSizes: number[];
}

/**
 * One pass over the log that both validates it and measures it. Startup already
 * had to read every record to check the sequence is increasing, so the byte
 * accounting stats() needs is free here — a second pass would not be.
 */
export function scanAccounting<T>(
  path: string,
  checkpointSeq: number,
  maxReadEntryBytes: number | null = null,
): WalAccounting {
  const empty: WalAccounting = {
    lastSeq: 0,
    bytes: 0,
    reclaimableBytes: 0,
    pendingSeqs: [],
    pendingSizes: [],
  };
  let fd: number;
  try {
    fd = fs.openSync(path, "r");
  } catch (error) {
    if (isMissing(error)) return empty;
    throw error;
  }

  let highest = 0;
  let bytes = 0;
  let reclaimableBytes = 0;
  const pendingSeqs: number[] = [];
  const pendingSizes: number[] = [];
  const accept = (line: string): void => {
    const entry = decode<T>(line);
    if (entry.seq <= highest) {
      throw new SyntaxError("WAL sequence numbers must increase");
    }
    highest = entry.seq;
    // healTail has already truncated any record not ending in a newline, so
    // every line counted here is one byte shorter than the record on disk.
    const size = Buffer.byteLength(line) + 1;
    bytes += size;
    if (entry.seq <= checkpointSeq) {
      reclaimableBytes += size;
    } else {
      pendingSeqs.push(entry.seq);
      pendingSizes.push(size);
    }
  };
  try {
    forEachLine(fd, maxReadEntryBytes, accept);
    return {
      lastSeq: highest,
      bytes,
      reclaimableBytes,
      pendingSeqs,
      pendingSizes,
    };
  } finally {
    fs.closeSync(fd);
  }
}
