import type { Wal, WalEntry } from "./types.js";

function closedError(): Error & { code: string } {
  return Object.assign(new Error("WAL is closed"), { code: "ERR_WAL_CLOSED" });
}

export function createNoopWal<T = unknown>(): Wal<T> {
  let seq = 0;
  let closed = false;
  const check = (): void => {
    if (closed) throw closedError();
  };

  return {
    append() {
      check();
      return ++seq;
    },
    checkpoint() {
      check();
    },
    replay() {
      check();
      return [];
    },
    cursor(): AsyncIterableIterator<WalEntry<T>> {
      check();
      return (async function* () {})();
    },
    compact() {
      check();
    },
    close() {
      check();
      closed = true;
    },
  };
}
