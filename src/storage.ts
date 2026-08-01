import * as fs from "node:fs";
import { debuglog } from "node:util";
import { decode } from "./record.js";
import { forEachLine } from "./scan.js";
import { discardTemporary, temporaryFor } from "./temporary.js";
import { isMissing } from "./validate.js";

const debug = debuglog("process-wal");

// Everything here exists so that a crash leaves the previous state or the next
// one, never half of either.

export function writeFully(fd: number, data: Buffer): void {
  let offset = 0;
  while (offset < data.length)
    offset += fs.writeSync(fd, data, offset, data.length - offset);
}

export function writeSurvivors(
  source: string,
  target: string,
  keepAbove: number,
  durable: boolean,
  maxReadEntryBytes: number | null = null,
): void {
  const input = fs.openSync(source, "r");
  const output = fs.openSync(target, "wx");

  // Compaction is what bounds file growth, so it runs against the largest logs
  // by definition — the exact case a whole-file read cannot serve. Streaming
  // keeps its memory at one entry, already capped by maxEntryBytes on append.
  const keep = (line: string): void => {
    if (decode(line).seq <= keepAbove) return;
    writeFully(
      output,
      Buffer.from(`${line}
`),
    );
  };
  try {
    forEachLine(input, maxReadEntryBytes, keep);
    if (durable) fs.fsyncSync(output);
  } finally {
    // The reader must let go before the caller can rename over the live file.
    fs.closeSync(input);
    fs.closeSync(output);
  }
}

/**
 * Write the records above the checkpoint to a fresh temporary and return its
 * path. Renaming it over the log is the caller's job, because the caller owns
 * the writer that has to be closed first and restored afterwards — and losing
 * that writer is worse than a failed compaction.
 */
export function writeCompacted(
  walPath: string,
  keepAbove: number,
  durable: boolean,
  maxReadEntryBytes: number | null = null,
): string {
  const tmp = temporaryFor(walPath);
  try {
    writeSurvivors(walPath, tmp, keepAbove, durable, maxReadEntryBytes);
  } catch (error) {
    discardTemporary(tmp);
    throw error;
  }
  return tmp;
}

// The checkpoint file holds one integer — about sixteen bytes. Reading it whole
// meant a directory entry of any size was pulled into memory before being
// parsed, and a corrupt one is discarded anyway. Nothing legitimate is near
// this, so anything past it is treated as the corruption it is.
const MAX_CHECKPOINT_BYTES = 64;

export function readCheckpoint(path: string): number {
  let fd: number;
  try {
    fd = fs.openSync(path, "r");
  } catch (error) {
    if (isMissing(error)) return 0;
    throw error;
  }
  let raw: string;
  try {
    if (fs.fstatSync(fd).size > MAX_CHECKPOINT_BYTES) {
      debug("checkpoint is implausibly large; falling back to 0");
      return 0;
    }
    const buffer = Buffer.allocUnsafe(MAX_CHECKPOINT_BYTES);
    const read = fs.readSync(fd, buffer, 0, MAX_CHECKPOINT_BYTES, 0);
    raw = buffer.subarray(0, read).toString("utf8").trim();
  } finally {
    fs.closeSync(fd);
  }
  const seq = Number(raw);
  if (/^\d+$/.test(raw) && Number.isSafeInteger(seq)) return seq;
  debug("checkpoint is corrupt; falling back to 0");
  return 0;
}

export function syncDirectory(dir: string): void {
  // POSIX needs the directory entry flushed after rename; Node does not expose
  // a portable directory fsync on Windows.
  if (process.platform === "win32") return;
  const fd = fs.openSync(dir, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function replaceFile(
  path: string,
  contents: string,
  durable: boolean,
  dir: string,
): void {
  // A crash may leave the tmp file behind, but never a half-written checkpoint.
  const tmp = temporaryFor(path);
  try {
    fs.writeFileSync(tmp, contents, {
      encoding: "utf8",
      flush: durable,
      flag: "wx",
    });
    fs.renameSync(tmp, path);
  } catch (error) {
    discardTemporary(tmp);
    throw error;
  }
  if (durable) syncDirectory(dir);
}

export function healTail(path: string, durable: boolean): void {
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
    if (durable) fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  debug("healed torn tail at byte %d", length);
}
