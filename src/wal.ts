import * as fs from "node:fs";
import { join } from "node:path";
import { debuglog } from "node:util";
import { createFrozenCursor } from "./cursor.js";
import {
  healTail,
  readCheckpoint,
  readEntries,
  replaceFile,
  scanLastSeq,
  syncDirectory,
  writeSurvivors,
} from "./storage.js";
import type { CursorOptions, Wal, WalEntry, WalOptions } from "./types.js";

const debug = debuglog("process-wal");
const DEFAULT_MAX_ENTRY_BYTES = 1 << 20;

type CodedError = Error & { code: string };

function fail(code: string, message: string): CodedError {
  return Object.assign(new Error(message), { code });
}

function checkSeq(seq: number, label: string): void {
  if (!Number.isSafeInteger(seq) || seq < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
}

export function createWal<T = unknown>(options: WalOptions = {}): Wal<T> {
  const {
    dir = "./data",
    fsync = false,
    compactInterval = null,
    maxEntryBytes = DEFAULT_MAX_ENTRY_BYTES,
  } = options;
  if (!dir || !Number.isSafeInteger(maxEntryBytes) || maxEntryBytes < 1) {
    throw new RangeError("dir and maxEntryBytes must be valid");
  }
  if (
    compactInterval !== null &&
    (!Number.isSafeInteger(compactInterval) || compactInterval < 1)
  ) {
    throw new RangeError("compactInterval must be a positive integer or null");
  }

  fs.mkdirSync(dir, { recursive: true });
  const walPath = join(dir, "wal.jsonl");
  const checkpointPath = join(dir, "wal.checkpoint");
  // Recovery must finish before the append descriptor is opened.
  healTail(walPath, fsync);

  let checkpointSeq = readCheckpoint(checkpointPath);
  let lastSeq = Math.max(checkpointSeq, scanLastSeq<T>(walPath));
  let fd = fs.openSync(walPath, "a");
  let closed = false;
  let activeCursors = 0;
  let compactPending = false;
  let timer: NodeJS.Timeout | undefined;

  const assertOpen = (): void => {
    if (closed) throw fail("ERR_WAL_CLOSED", "WAL is closed");
  };

  const append = (value: T): number => {
    assertOpen();
    if (lastSeq === Number.MAX_SAFE_INTEGER) {
      throw new RangeError("WAL sequence number space is exhausted");
    }
    const next = lastSeq + 1;
    let payload: string | undefined;
    try {
      payload = JSON.stringify(value);
    } catch {
      throw fail(
        "ERR_ENTRY_NOT_SERIALIZABLE",
        "entry is not JSON-serializable",
      );
    }
    if (payload === undefined) {
      throw fail(
        "ERR_ENTRY_NOT_SERIALIZABLE",
        "entry is not JSON-serializable",
      );
    }
    const line = `{"seq":${next},"value":${payload}}\n`;
    if (Buffer.byteLength(line) > maxEntryBytes) {
      throw fail("ERR_ENTRY_TOO_LARGE", `entry exceeds ${maxEntryBytes} bytes`);
    }
    const data = Buffer.from(line);
    let offset = 0;
    while (offset < data.length)
      offset += fs.writeSync(fd, data, offset, data.length - offset);
    if (fsync) fs.fsyncSync(fd);
    // Publish the seq only after the full record reaches the selected
    // durability boundary (page cache, or storage when fsync is enabled).
    lastSeq = next;
    return lastSeq;
  };

  const checkpoint = (nextCheckpoint: number): void => {
    assertOpen();
    checkSeq(nextCheckpoint, "checkpoint");
    if (nextCheckpoint <= checkpointSeq) return;
    replaceFile(checkpointPath, String(nextCheckpoint), fsync, dir);
    // Memory advances only after the atomic replacement succeeds.
    checkpointSeq = nextCheckpoint;
    lastSeq = Math.max(lastSeq, nextCheckpoint);
  };

  const replay = (): Array<WalEntry<T>> => {
    assertOpen();
    return readEntries<T>(walPath).filter((entry) => entry.seq > checkpointSeq);
  };

  const compactNow = (): void => {
    const tmp = `${walPath}.tmp`;
    writeSurvivors(walPath, tmp, checkpointSeq, fsync);
    // Closing the writer is required before replacing its file on Windows.
    fs.closeSync(fd);
    try {
      fs.renameSync(tmp, walPath);
    } finally {
      fd = fs.openSync(walPath, "a");
    }
    if (fsync) syncDirectory(dir);
    compactPending = false;
  };

  const releaseCursor = (): void => {
    activeCursors -= 1;
    if (!closed && activeCursors === 0 && compactPending) compactNow();
  };

  const cursor = ({ fromSeq = 0 }: CursorOptions = {}): AsyncIterableIterator<
    WalEntry<T>
  > => {
    assertOpen();
    checkSeq(fromSeq, "fromSeq");
    // The checkpoint and byte length form an immutable view even as appends
    // continue. The cursor owns its descriptor until iteration finishes.
    const snapshot = createFrozenCursor<T>({
      walPath,
      checkpointSeq,
      fromSeq,
      onRelease: releaseCursor,
    });
    activeCursors += 1;
    return snapshot;
  };

  const compact = (): void => {
    assertOpen();
    if (activeCursors > 0) {
      compactPending = true;
      debug("compaction deferred while %d cursor(s) are open", activeCursors);
      return;
    }
    compactNow();
  };

  const close = (): void => {
    assertOpen();
    if (timer) clearInterval(timer);
    if (fsync) fs.fsyncSync(fd);
    fs.closeSync(fd);
    closed = true;
  };

  if (compactInterval !== null) {
    timer = setInterval(() => {
      try {
        compact();
      } catch (error) {
        // Nobody is waiting on this call, so swallowing it would let the log
        // grow unbounded with no signal. A warning reaches stderr by default
        // without killing a process whose durability is still intact.
        process.emitWarning(
          `automatic compaction failed: ${(error as Error).message}`,
          "ProcessWalWarning",
        );
      }
    }, compactInterval);
    timer.unref();
  }

  return { append, checkpoint, replay, cursor, compact, close };
}
