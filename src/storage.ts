import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { debuglog } from "node:util";
import { decode } from "./record.js";
import { join } from "node:path";
import { isMissing } from "./validate.js";

const debug = debuglog("process-wal");

// Everything here exists so that a crash leaves the previous state or the next
// one, never half of either.

// A temporary is created exclusively, under a name nobody can predict. Opening
// a fixed path with "w" follows whatever is already there, so an entry planted
// in the directory — a symlink to a file outside it — would be written through.
// "wx" refuses an existing entry, and the random suffix means there is nothing
// to plant at.
function temporaryFor(target: string): string {
  return `${target}.${randomBytes(8).toString("hex")}.tmp`;
}

export function discardTemporary(path: string): void {
  try {
    fs.rmSync(path, { force: true });
  } catch {
    // Cleanup is best-effort: the operation already failed, and sweepTemporaries
    // collects whatever is left on the next open.
  }
}

/**
 * Remove temporaries abandoned by an interrupted checkpoint or compaction.
 * Safe at open because the WAL is single-writer: nothing else owns them, and a
 * compaction temporary can be as large as the log itself.
 */
export function sweepTemporaries(dir: string): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (/^wal\.(jsonl|checkpoint)\.[0-9a-f]{16}\.tmp$/.test(entry)) {
      discardTemporary(join(dir, entry));
    }
  }
}

export function writeSurvivors(
  source: string,
  target: string,
  keepAbove: number,
  durable: boolean,
): void {
  const input = fs.openSync(source, "r");
  const output = fs.openSync(target, "wx");

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
): string {
  const tmp = temporaryFor(walPath);
  try {
    writeSurvivors(walPath, tmp, keepAbove, durable);
  } catch (error) {
    discardTemporary(tmp);
    throw error;
  }
  return tmp;
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
