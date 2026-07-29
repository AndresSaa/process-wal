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

export interface Wal<T = unknown> {
  /** Persist a JSON-serializable value before returning its sequence number. */
  append(value: T): number;
  /** Mark every entry through seq as processed. */
  checkpoint(seq: number): void;
  /** Materialize entries newer than the current checkpoint. */
  replay(): Array<WalEntry<T>>;
  /** Atomically remove checkpointed records from the log. */
  compact(): void;
  /** Flush when configured and release the writer. */
  close(): void;
}
