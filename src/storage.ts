import * as fs from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { debuglog } from "node:util";
import { decode } from "./record.js";
import { isMissing } from "./validate.js";

const debug = debuglog("process-wal");

// Everything here exists so that a crash leaves the previous state or the next
// one, never half of either.

export function writeSurvivors(
  source: string,
  target: string,
  keepAbove: number,
  durable: boolean,
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
    if (durable) fs.fsyncSync(output);
  } finally {
    // The reader must let go before the caller can rename over the live file.
    fs.closeSync(input);
    fs.closeSync(output);
  }
}

/**
 * Replace the log with only the records above the checkpoint. The writer has to
 * be closed before the rename because Windows refuses to replace an open file,
 * so this owns the descriptor swap and returns the reopened one.
 */
export function compactLog(
  walPath: string,
  fd: number,
  keepAbove: number,
  durable: boolean,
  dir: string,
): number {
  const tmp = `${walPath}.tmp`;
  writeSurvivors(walPath, tmp, keepAbove, durable);
  fs.closeSync(fd);
  let reopened: number;
  try {
    fs.renameSync(tmp, walPath);
  } finally {
    reopened = fs.openSync(walPath, "a");
  }
  if (durable) syncDirectory(dir);
  return reopened;
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
  fs.writeFileSync(`${path}.tmp`, contents, {
    encoding: "utf8",
    flush: durable,
  });
  fs.renameSync(`${path}.tmp`, path);
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
