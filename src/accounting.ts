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
  record(seq: number, size: number): void;
  /** Absorb every pending record the checkpoint now covers. */
  advance(checkpointSeq: number): void;
  /** Compaction removed exactly the records that were reclaimable. */
  compacted(): void;
}

// Consumed entries are left in place and skipped with an index, then dropped in
// one pass once they outnumber the live ones. Splicing the prefix on every
// checkpoint made checkpointing a replayed backlog one entry at a time — the
// pattern the readme shows — quadratic in the size of that backlog.
const MIN_COMPACTION = 64;

export function createAccounting(opened: WalAccounting): Accounting {
  let seqs = opened.pendingSeqs;
  let sizes = opened.pendingSizes;
  let head = 0;
  let total = opened.bytes;
  let reclaimable = opened.reclaimableBytes;

  return {
    get bytes() {
      return total;
    },
    get reclaimableBytes() {
      return reclaimable;
    },
    // Counts records actually in the file, which is what a caller means by
    // backlog — not lastSeq - checkpoint, which assumes they are contiguous.
    get pendingEntries() {
      return seqs.length - head;
    },
    record(seq, size) {
      total += size;
      seqs.push(seq);
      sizes.push(size);
    },
    advance(checkpointSeq) {
      // Compare sequence numbers rather than counting forward from the previous
      // checkpoint. Pending records are only guaranteed to increase, not to be
      // contiguous: a checkpoint that falls back to 0 after corruption leaves a
      // log whose first surviving record can be any sequence number at all.
      while (head < seqs.length && seqs[head] <= checkpointSeq) {
        reclaimable += sizes[head];
        head += 1;
      }
      if (head >= MIN_COMPACTION && head * 2 >= seqs.length) {
        seqs = seqs.slice(head);
        sizes = sizes.slice(head);
        head = 0;
      }
    },
    compacted() {
      total -= reclaimable;
      reclaimable = 0;
    },
  };
}
