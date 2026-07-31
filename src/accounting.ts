import type { WalAccounting } from "./scan.js";

/**
 * Bookkeeping for stats(), kept out of the WAL because nothing here decides
 * when data is safe — it only measures what is already on disk.
 *
 * reclaimableBytes cannot be derived from lastSeq and checkpoint alone: two
 * logs with identical counters differ by whichever records happen to be large.
 * So the byte length of every pending record is retained until a checkpoint
 * covers it, which is the one place this costs memory rather than a counter.
 */
export interface Accounting {
  readonly bytes: number;
  readonly reclaimableBytes: number;
  readonly pendingEntries: number;
  /** Account for one record that reached the log. */
  record(size: number): void;
  /** Absorb the records a checkpoint advance now covers. */
  advance(coveredSeqs: number): void;
  /** Compaction removed exactly the records that were reclaimable. */
  compacted(): void;
}

export function createAccounting(opened: WalAccounting): Accounting {
  let sizes = opened.pendingSizes;
  let total = opened.bytes;
  let reclaimable = opened.reclaimableBytes;

  return {
    get bytes() {
      return total;
    },
    get reclaimableBytes() {
      return reclaimable;
    },
    // The array length is the ground truth, not lastSeq - checkpoint: it counts
    // records that are actually in the file.
    get pendingEntries() {
      return sizes.length;
    },
    record(size) {
      total += size;
      sizes.push(size);
    },
    advance(coveredSeqs) {
      // A checkpoint beyond the last append covers every pending record, hence
      // the clamp.
      const covered = Math.min(coveredSeqs, sizes.length);
      for (let i = 0; i < covered; i += 1) reclaimable += sizes[i];
      sizes = sizes.slice(covered);
    },
    compacted() {
      total -= reclaimable;
      reclaimable = 0;
    },
  };
}
