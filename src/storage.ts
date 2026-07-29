import * as fs from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { debuglog } from "node:util";
import type { WalEntry } from "./types.js";

const debug = debuglog("process-wal");

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

export function decode<T>(line: string): WalEntry<T> {
  const entry = JSON.parse(line) as Partial<WalEntry<T>>;
  if (
    !Number.isSafeInteger(entry.seq) ||
    (entry.seq as number) < 1 ||
    !Object.hasOwn(entry, "value")
  ) {
    throw new SyntaxError("invalid WAL entry");
  }
  return entry as WalEntry<T>;
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

export function scanLastSeq<T>(path: string): number {
  let fd: number;
  try {
    fd = fs.openSync(path, "r");
  } catch (error) {
    if (isMissing(error)) return 0;
    throw error;
  }

  // Startup validates the full log without loading it. The only unbounded value
  // retained is one entry, already limited by maxEntryBytes on append.
  const chunk = Buffer.allocUnsafe(64 * 1024);
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let highest = 0;
  const accept = (line: string): void => {
    if (!line) return;
    const entry = decode<T>(line);
    if (entry.seq <= highest) {
      throw new SyntaxError("WAL sequence numbers must increase");
    }
    highest = entry.seq;
  };
  try {
    let bytesRead: number;
    do {
      bytesRead = fs.readSync(fd, chunk);
      pending += decoder.write(chunk.subarray(0, bytesRead));
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) accept(line);
    } while (bytesRead > 0);
    pending += decoder.end();
    accept(pending);
    return highest;
  } finally {
    fs.closeSync(fd);
  }
}

export function writeSurvivors(
  source: string,
  target: string,
  keepAbove: number,
): void {
  const input = fs.openSync(source, "r");
  const output = fs.openSync(target, "w");

  // Compaction is what bounds file growth, so it runs against the largest logs
  // by definition — the exact case a whole-file read cannot serve. Streaming
  // keeps its memory at one entry, already capped by maxEntryBytes on append.
  const chunk = Buffer.allocUnsafe(64 * 1024);
  const decoder = new StringDecoder("utf8");
  let pending = "";
  const keep = (line: string): void => {
    if (!line || decode(line).seq <= keepAbove) return;
    const data = Buffer.from(`${line}\n`);
    let offset = 0;
    while (offset < data.length)
      offset += fs.writeSync(output, data, offset, data.length - offset);
  };
  try {
    let bytesRead: number;
    do {
      bytesRead = fs.readSync(input, chunk);
      pending += decoder.write(chunk.subarray(0, bytesRead));
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) keep(line);
    } while (bytesRead > 0);
    keep(pending + decoder.end());
  } finally {
    // The reader must let go before the caller can rename over the live file.
    fs.closeSync(input);
    fs.closeSync(output);
  }
}

export function readCheckpoint(path: string): number {
  let raw: string;
  try {
    raw = fs.readFileSync(path, "utf8").trim();
  } catch (error) {
    if (isMissing(error)) return 0;
    throw error;
  }
  const seq = Number(raw);
  if (/^\d+$/.test(raw) && Number.isSafeInteger(seq)) return seq;
  debug("checkpoint is corrupt; falling back to 0");
  return 0;
}

export function replaceFile(path: string, contents: string): void {
  // A crash may leave the tmp file behind, but never a half-written checkpoint.
  fs.writeFileSync(`${path}.tmp`, contents, "utf8");
  fs.renameSync(`${path}.tmp`, path);
}

export function healTail(path: string): void {
  let fd: number;
  try {
    fd = fs.openSync(path, "r+");
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }

  // Remove a write interrupted mid-record before another append can weld valid
  // JSON onto it. Scanning backwards keeps startup memory independent of log
  // size; complete but corrupt records remain visible and fail loudly.
  let length = 0;
  try {
    const size = fs.fstatSync(fd).size;
    if (size === 0) return;
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, size));
    let position = size;
    while (position > 0) {
      const bytes = Math.min(chunk.length, position);
      position -= bytes;
      fs.readSync(fd, chunk, 0, bytes, position);
      const newline = chunk.subarray(0, bytes).lastIndexOf(0x0a);
      if (newline >= 0) {
        length = position + newline + 1;
        break;
      }
    }
    if (length === size) return;
    fs.ftruncateSync(fd, length);
  } finally {
    fs.closeSync(fd);
  }
  debug("healed torn tail at byte %d", length);
}
