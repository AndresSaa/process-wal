import type { Wal, WalCursor, WalEntry, WalStats } from "./types.js";

function closedError(): Error & { code: string } {
  return Object.assign(new Error("WAL is closed"), { code: "ERR_WAL_CLOSED" });
}

export function createNoopWal<T = unknown>(): Wal<T> {
  let seq = 0;
  let checkpointSeq = 0;
  let closed = false;
  const check = (): void => {
    if (closed) throw closedError();
  };
  // Mirrors createWal: close is the one method safe to call twice.
  const close = (): void => {
    closed = true;
  };

  return {
    append() {
      check();
      return ++seq;
    },
    checkpoint(nextCheckpoint: number) {
      check();
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
