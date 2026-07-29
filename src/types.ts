export interface WalOptions {
  /** Directory that owns wal.jsonl and wal.checkpoint. Default: ./data. */
  dir?: string;
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
