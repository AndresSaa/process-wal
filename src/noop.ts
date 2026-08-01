import type { Wal, WalCursor, WalEntry, WalStats } from "./types.js";
import { checkSeq, walClosed } from "./validate.js";

export function createNoopWal<T = unknown>(): Wal<T> {
  let seq = 0;
  let checkpointSeq = 0;
  let closed = false;
  const check = (): void => {
    if (closed) throw walClosed();
  };
  // The seam is only useful if it fails where the real WAL fails, so the
  // sequence space is exhausted here too rather than silently going unsafe.
  const exhausted = (): void => {
    if (seq === Number.MAX_SAFE_INTEGER) {
      throw new RangeError("WAL sequence number space is exhausted");
    }
  };

  // Mirrors createWal: close is the one method safe to call twice.
  const close = (): void => {
    closed = true;
  };

  return {
    append() {
      check();
      exhausted();
      return ++seq;
    },
    appendMany(values: T[]) {
      check();
      if (values.length > Number.MAX_SAFE_INTEGER - seq) {
        throw new RangeError("WAL sequence number space is exhausted");
      }
      return values.map(() => ++seq);
    },
    checkpoint(nextCheckpoint: number) {
      check();
      checkSeq(nextCheckpoint, "checkpoint");
      if (nextCheckpoint > checkpointSeq) {
        checkpointSeq = nextCheckpoint;
        seq = Math.max(seq, nextCheckpoint);
      }
    },
    replay() {
      check();
      return [];
    },
    cursor(): WalCursor<T> {
      check();
      const iterator = (async function* (): AsyncGenerator<WalEntry<T>> {})();
      return Object.assign(iterator, {
        async [Symbol.asyncDispose]() {
          await iterator.return(undefined);
        },
      });
    },
    compact() {
      check();
    },
    stats(): WalStats {
      check();
      // Nothing is stored, so nothing is pending and nothing is reclaimable.
      // Only the sequence bookkeeping is real, and it mirrors createWal.
      return {
        lastSeq: seq,
        checkpoint: checkpointSeq,
        pendingEntries: 0,
        bytes: 0,
        reclaimableBytes: 0,
      };
    },
    close,
    [Symbol.dispose]: close,
  };
}
