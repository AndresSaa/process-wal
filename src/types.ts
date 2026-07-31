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

export interface Wal<T = unknown> {
  /** Persist a JSON-serializable value before returning its sequence number. */
  append(value: T): number;
  /** Mark every entry through seq as processed. */
  checkpoint(seq: number): void;
  /** Materialize entries newer than the current checkpoint. */
  replay(): Array<WalEntry<T>>;
  /** Stream a checkpoint and file-size snapshot without loading it all. */
  cursor(options?: CursorOptions): WalCursor<T>;
  /** Atomically remove checkpointed records from the log. */
  compact(): void;
  /** Flush when configured and release the writer. Idempotent. */
  close(): void;
  /** Alias for close(), so `using wal = createWal()` releases it. */
  [Symbol.dispose](): void;
}
