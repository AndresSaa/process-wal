import type { WalEntry } from "./types.js";
import { fail } from "./validate.js";

// A record is one line of JSON — `{"seq":N,"value":…}` — terminated by a
// newline. That newline is the durability boundary: a record without one was
// interrupted mid-write, and healTail truncates it before anything else runs.

export function decode<T>(line: string): WalEntry<T> {
  const parsed: unknown = JSON.parse(line);
  // `null` parses successfully and is not an object, so reading .seq off it
  // throws TypeError rather than the SyntaxError the contract promises for a
  // damaged record. Arrays and primitives are rejected here for the same
  // reason: the envelope is an object or the record is not a record.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new SyntaxError("invalid WAL entry");
  }
  const entry = parsed as Partial<WalEntry<T>>;
  if (
    !Number.isSafeInteger(entry.seq) ||
    (entry.seq as number) < 1 ||
    !Object.hasOwn(entry, "value")
  ) {
    throw new SyntaxError("invalid WAL entry");
  }
  return entry as WalEntry<T>;
}

/** The write side: one complete record, size-checked before it can be written. */
export function encode<T>(
  seq: number,
  value: T,
  maxEntryBytes: number,
): Buffer {
  let payload: string | undefined;
  try {
    payload = JSON.stringify(value);
  } catch {
    throw fail("ERR_ENTRY_NOT_SERIALIZABLE", "entry is not JSON-serializable");
  }
  // JSON.stringify returns undefined rather than throwing for undefined,
  // functions and symbols, so the two cases need separate checks.
  if (payload === undefined) {
    throw fail("ERR_ENTRY_NOT_SERIALIZABLE", "entry is not JSON-serializable");
  }
  const line = `{"seq":${seq},"value":${payload}}\n`;
  if (Buffer.byteLength(line) > maxEntryBytes) {
    throw fail("ERR_ENTRY_TOO_LARGE", `entry exceeds ${maxEntryBytes} bytes`);
  }
  return Buffer.from(line);
}
