import * as fs from "node:fs";
import { createInterface } from "node:readline";
import { decode, guardRecordSize } from "./record.js";
import type { WalCursor, WalEntry } from "./types.js";

interface FrozenCursorOptions {
  walPath: string;
  checkpointSeq: number;
  fromSeq: number;
  maxReadEntryBytes: number | null;
  onRelease(): void;
}

export function createFrozenCursor<T>({
  walPath,
  checkpointSeq,
  fromSeq,
  maxReadEntryBytes,
  onRelease,
}: FrozenCursorOptions): WalCursor<T> {
  const fd = fs.openSync(walPath, "r");
  let size: number;
  try {
    size = fs.fstatSync(fd).size;
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    fs.closeSync(fd);
    onRelease();
  };

  async function* iterate(): AsyncGenerator<WalEntry<T>> {
    try {
      if (size === 0) return;
      const input = fs.createReadStream(walPath, {
        fd,
        autoClose: false,
        encoding: "utf8",
        start: 0,
        end: size - 1,
      });
      const lines = createInterface({ input, crlfDelay: Infinity });
      for await (const line of lines) {
        if (!line) continue;
        // readline has already buffered the whole line, so this rejects an
        // oversized record rather than preventing it being held. The bound
        // that matters is applied at open, which every cursor is downstream
        // of: a record too large to read never gets past createWal.
        guardRecordSize(line.length, maxReadEntryBytes);
        const entry = decode<T>(line);
        if (entry.seq > checkpointSeq && entry.seq > fromSeq) yield entry;
      }
    } finally {
      release();
    }
  }

  // Async generators do not enter their finally block when return() or throw()
  // happens before the first next(), so the wrapper owns early release.
  const iterator = iterate();
  let started = false;
  return {
    next: (value) => {
      started = true;
      return iterator.next(value);
    },
    return: async (value) => {
      if (!started) release();
      return iterator.return(value);
    },
    throw: async (error) => {
      if (!started) release();
      return iterator.throw(error);
    },
    // `await using` calls this exactly once on scope exit, including on an
    // early return or a throw. It is the only way to release the descriptor
    // that does not depend on the caller remembering to.
    async [Symbol.asyncDispose]() {
      if (!started) release();
      await iterator.return(undefined);
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}
