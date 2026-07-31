// The public contract, and nothing else. Every type here is re-exported from
// index.ts, and every type index.ts exports is here — so this file answers
// "what does a consumer get?" on its own.
//
// Types that describe how a module talks to another module stay with that
// module: WalAccounting in scan.ts, Accounting in accounting.ts,
// FrozenCursorOptions in cursor.ts. Centralising those would cost this file its
// one useful property.

export interface WalOptions {
  /** Directory that owns wal.jsonl and wal.checkpoint. Default: ./data. */
  dir?: string;
  /** Flush each mutation to storage instead of stopping at the page cache. */
  fsync?: boolean;
  /** Run compaction on an unref'ed timer, or disable it with null. */
  compactInterval?: number | null;
  /** Maximum UTF-8 bytes for one complete JSONL record. Default: 1 MiB. */
  maxEntryBytes?: number;
}

/** A persisted value and its instance-monotonic sequence number. */
export interface WalEntry<T = unknown> {
  seq: number;
  value: T;
}

export interface CursorOptions {
  /** Exclude entries at or below this sequence number. */
  fromSeq?: number;
}

/**
 * A frozen snapshot stream that owns a file descriptor. Disposing it releases
 * that descriptor, which is what lets a deferred compact() finally run.
 */
export interface WalCursor<T = unknown> extends AsyncIterableIterator<
  WalEntry<T>
> {
  [Symbol.asyncDispose](): Promise<void>;
}

/** A snapshot of the log's size and position, for policy and metrics. */
export interface WalStats {
  /** Highest sequence number issued by this instance. */
  lastSeq: number;
  /** Highest sequence number marked processed. */
  checkpoint: number;
  /** Records above the checkpoint — what replay() would return. */
  pendingEntries: number;
  /** Current size of the log in bytes. */
  bytes: number;
  /** Bytes that compact() would release right now. */
  reclaimableBytes: number;
}

export interface Wal<T = unknown> {
  /** Persist a JSON-serializable value before returning its sequence number. */
  append(value: T): number;
  /**
   * Persist many values in one write and one flush, returning their sequence
   * numbers. Returning means all of them are durable.
   */
  appendMany(values: T[]): number[];
  /** Mark every entry through seq as processed. */
  checkpoint(seq: number): void;
  /** Materialize entries newer than the current checkpoint. */
  replay(): Array<WalEntry<T>>;
  /** Stream a checkpoint and file-size snapshot without loading it all. */
  cursor(options?: CursorOptions): WalCursor<T>;
  /** Atomically remove checkpointed records from the log. */
  compact(): void;
  /** Read the log's size and position without touching disk. */
  stats(): WalStats;
  /** Flush when configured and release the writer. Idempotent. */
  close(): void;
  /** Alias for close(), so `using wal = createWal()` releases it. */
  [Symbol.dispose](): void;
}
