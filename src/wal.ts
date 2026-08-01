import * as fs from "node:fs";
import { join } from "node:path";
import { debuglog } from "node:util";
import { createAccounting } from "./accounting.js";
import { createFrozenCursor } from "./cursor.js";
import { encode } from "./record.js";
import { readEntries, scanAccounting } from "./scan.js";
import {
  compactLog,
  healTail,
  readCheckpoint,
  replaceFile,
  sweepTemporaries,
} from "./storage.js";
import type {
  CursorOptions,
  Wal,
  WalCursor,
  WalEntry,
  WalOptions,
  WalStats,
} from "./types.js";
import { checkSeq, resolveOptions, walClosed } from "./validate.js";

const debug = debuglog("process-wal");

export function createWal<T = unknown>(options: WalOptions = {}): Wal<T> {
  const { dir, fsync, compactInterval, maxEntryBytes } =
    resolveOptions(options);

  fs.mkdirSync(dir, { recursive: true });
  const walPath = join(dir, "wal.jsonl");
  const checkpointPath = join(dir, "wal.checkpoint");
  // Recovery must finish before the append descriptor is opened.
  sweepTemporaries(dir);
  healTail(walPath, fsync);

  let checkpointSeq = readCheckpoint(checkpointPath);
  // The same pass that validates the log measures it, so stats() never reads
  // the filesystem: the accounting is maintained from here on.
  const opened = scanAccounting<T>(walPath, checkpointSeq);
  const measured = createAccounting(opened);
  let lastSeq = Math.max(checkpointSeq, opened.lastSeq);
  let fd = fs.openSync(walPath, "a");
  let closed = false;
  let activeCursors = 0;
  let compactPending = false;
  let timer: NodeJS.Timeout | undefined;

  const assertOpen = (): void => {
    if (closed) throw walClosed();
  };

  const writeAll = (data: Buffer): void => {
    let offset = 0;
    while (offset < data.length)
      offset += fs.writeSync(fd, data, offset, data.length - offset);
    if (fsync) fs.fsyncSync(fd);
  };

  const append = (value: T): number => {
    assertOpen();
    if (lastSeq === Number.MAX_SAFE_INTEGER) {
      throw new RangeError("WAL sequence number space is exhausted");
    }
    const data = encode(lastSeq + 1, value, maxEntryBytes);
    writeAll(data);
    // Publish the seq only after the full record reaches the selected
    // durability boundary (page cache, or storage when fsync is enabled).
    lastSeq += 1;
    measured.record(lastSeq, data.length);
    return lastSeq;
  };

  const appendMany = (values: T[]): number[] => {
    assertOpen();
    if (values.length === 0) return [];
    if (values.length > Number.MAX_SAFE_INTEGER - lastSeq) {
      throw new RangeError("WAL sequence number space is exhausted");
    }
    // Encode the whole batch before writing any of it, so a value that cannot
    // be serialised fails the call instead of leaving part of a batch behind.
    const records = values.map((value, index) =>
      encode(lastSeq + 1 + index, value, maxEntryBytes),
    );
    // One write and one flush for the batch. The flush is what costs, so this
    // is the difference between paying it per record and paying it per call.
    writeAll(Buffer.concat(records));
    return records.map((record) => {
      lastSeq += 1;
      measured.record(lastSeq, record.length);
      return lastSeq;
    });
  };

  const checkpoint = (nextCheckpoint: number): void => {
    assertOpen();
    checkSeq(nextCheckpoint, "checkpoint");
    if (nextCheckpoint <= checkpointSeq) return;
    replaceFile(checkpointPath, String(nextCheckpoint), fsync, dir);
    // Memory advances only after the atomic replacement succeeds.
    measured.advance(nextCheckpoint);
    checkpointSeq = nextCheckpoint;
    lastSeq = Math.max(lastSeq, nextCheckpoint);
  };

  const replay = (): Array<WalEntry<T>> => {
    assertOpen();
    return readEntries<T>(walPath).filter((entry) => entry.seq > checkpointSeq);
  };

  const compactNow = (): void => {
    fd = compactLog(walPath, fd, checkpointSeq, fsync, dir);
    // Compaction keeps exactly the records above the checkpoint, so what the
    // file lost is precisely what was reclaimable.
    measured.compacted();
    compactPending = false;
  };

  const releaseCursor = (): void => {
    activeCursors -= 1;
    if (!closed && activeCursors === 0 && compactPending) compactNow();
  };

  const cursor = ({ fromSeq = 0 }: CursorOptions = {}): WalCursor<T> => {
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

  const stats = (): WalStats => {
    assertOpen();
    return {
      lastSeq,
      checkpoint: checkpointSeq,
      pendingEntries: measured.pendingEntries,
      bytes: measured.bytes,
      reclaimableBytes: measured.reclaimableBytes,
    };
  };

  // Idempotent, unlike every other method. Releasing a resource twice is what
  // correct shutdown code does — a `finally` and a signal handler both fire —
  // so throwing there would punish the careful caller. An append after close
  // still throws: accepting one would silently drop work.
  const close = (): void => {
    if (closed) return;
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

  return {
    append,
    appendMany,
    checkpoint,
    replay,
    cursor,
    compact,
    stats,
    close,
    [Symbol.dispose]: close,
  };
}
