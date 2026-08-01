import type { WalOptions } from "./types.js";

const DEFAULT_MAX_ENTRY_BYTES = 1 << 20;

export type CodedError = Error & { code: string };

export function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

export function fail(code: string, message: string): CodedError {
  return Object.assign(new Error(message), { code });
}

export function walClosed(): CodedError {
  return fail("ERR_WAL_CLOSED", "WAL is closed");
}

export function checkSeq(seq: number, label: string): void {
  if (!Number.isSafeInteger(seq) || seq < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
}

export interface ResolvedOptions {
  dir: string;
  fsync: boolean;
  compactInterval: number | null;
  maxEntryBytes: number;
  maxReadEntryBytes: number | null;
}

/**
 * Every option is rejected here rather than at first use, so a misconfigured
 * WAL fails at construction instead of halfway through a workload.
 */
export function resolveOptions(options: WalOptions): ResolvedOptions {
  const {
    dir = "./data",
    fsync = false,
    compactInterval = null,
    maxEntryBytes = DEFAULT_MAX_ENTRY_BYTES,
    maxReadEntryBytes = null,
  } = options;
  if (typeof dir !== "string" || !dir) {
    throw new RangeError("dir must be a non-empty string");
  }
  // Checked by type, not by truthiness: `fsync: "false"` is a string, and a
  // truthiness test would silently turn the safest-looking value into the
  // slowest one.
  if (typeof fsync !== "boolean") {
    throw new RangeError("fsync must be a boolean");
  }
  if (!Number.isSafeInteger(maxEntryBytes) || maxEntryBytes < 1) {
    throw new RangeError("maxEntryBytes must be a positive safe integer");
  }
  if (
    compactInterval !== null &&
    (!Number.isSafeInteger(compactInterval) || compactInterval < 1)
  ) {
    throw new RangeError("compactInterval must be a positive integer or null");
  }
  if (
    maxReadEntryBytes !== null &&
    (!Number.isSafeInteger(maxReadEntryBytes) || maxReadEntryBytes < 1)
  ) {
    throw new RangeError(
      "maxReadEntryBytes must be a positive safe integer or null",
    );
  }
  return {
    dir,
    fsync,
    compactInterval,
    maxEntryBytes,
    maxReadEntryBytes,
  };
}
