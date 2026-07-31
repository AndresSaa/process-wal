import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { createWal } from "../src/index.js";
import { cleanupTempDirs, tempDir } from "./helpers.js";

afterEach(cleanupTempDirs);

// SECURITY.md puts "a crafted wal.jsonl that crashes the process, hangs it, or
// drives unbounded memory growth on open" in scope. Example-based tests cover
// the shapes we thought of; these cover the ones we did not. The invariant is
// the same in all of them: opening either succeeds with a coherent view of the
// log, or fails with a typed error. Never a hang, never a raw crash, never a
// silently reordered or duplicated sequence.

const walPath = (dir: string): string => join(dir, "wal.jsonl");

/** Every failure the contract permits. Anything else is a bug. */
function assertPermittedFailure(error: unknown): void {
  if (error instanceof SyntaxError || error instanceof RangeError) return;
  const code = (error as { code?: unknown } | null)?.code;
  expect([
    "ERR_WAL_CLOSED",
    "ERR_ENTRY_TOO_LARGE",
    "ERR_ENTRY_NOT_SERIALIZABLE",
  ]).toContain(code);
}

function assertCoherent(entries: Array<{ seq: number }>): void {
  for (let i = 1; i < entries.length; i += 1) {
    expect(entries[i].seq).toBeGreaterThan(entries[i - 1].seq);
  }
}

describe("recovery over arbitrary log content", () => {
  it("opens coherently or fails with a typed error, for any bytes on disk", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (log, checkpoint) => {
        const dir = tempDir();
        writeFileSync(walPath(dir), log);
        writeFileSync(join(dir, "wal.checkpoint"), checkpoint);

        try {
          const wal = createWal({ dir });
          assertCoherent(wal.replay());
          // A healed log must still accept work, and that work must be the
          // newest thing in it.
          const seq = wal.append({ ok: true });
          expect(wal.replay().at(-1)).toEqual({ seq, value: { ok: true } });
          wal.close();
        } catch (error) {
          assertPermittedFailure(error);
        }
      }),
      { numRuns: 250 },
    );
  });

  it("never loses a complete record to a torn tail, wherever the tear lands", () => {
    fc.assert(
      fc.property(
        fc.array(fc.jsonValue(), { minLength: 1, maxLength: 12 }),
        fc.nat(),
        (values, cut) => {
          const dir = tempDir();
          const wal = createWal({ dir });
          for (const value of values) wal.append(value);
          wal.close();

          // Truncate anywhere, simulating a crash mid-append. Records that
          // ended in a newline were acknowledged and must survive; the torn
          // one never returned a seq and may vanish.
          const bytes = readFileSync(walPath(dir));
          const truncated = bytes.subarray(0, cut % (bytes.length + 1));
          const complete = truncated.lastIndexOf(0x0a) + 1;
          writeFileSync(walPath(dir), truncated);

          const reopened = createWal({ dir });
          const survivors = reopened.replay();
          assertCoherent(survivors);
          expect(survivors.length).toBe(
            truncated.subarray(0, complete).toString().split("\n").length - 1,
          );
          // The heal must be durable, not just in memory: the torn bytes are
          // gone from the file before any new append can weld onto them.
          expect(readFileSync(walPath(dir)).length).toBe(complete);
          reopened.close();
        },
      ),
      { numRuns: 150 },
    );
  });

  it("round-trips any JSON value through a restart", () => {
    fc.assert(
      fc.property(fc.array(fc.jsonValue(), { maxLength: 15 }), (values) => {
        const dir = tempDir();
        const first = createWal({ dir });
        for (const value of values) first.append(value);
        first.close();

        const second = createWal({ dir });
        // The promise is JSON fidelity, not JavaScript fidelity. This property
        // originally compared against `values` and fast-check immediately
        // produced -0, which JSON.stringify writes as "0". The log is not
        // lossy; JSON is, and the docs say so.
        expect(second.replay().map((entry) => entry.value)).toEqual(
          JSON.parse(JSON.stringify(values)),
        );
        second.close();
      }),
      { numRuns: 150 },
    );
  });
});

describe("stats never drifts from the file", () => {
  type Op =
    | { kind: "append"; value: unknown }
    | { kind: "checkpoint"; ahead: number }
    | { kind: "compact" };

  const ops = fc.array(
    fc.oneof(
      fc.record({
        kind: fc.constant("append" as const),
        value: fc.jsonValue(),
      }),
      fc.record({
        kind: fc.constant("checkpoint" as const),
        // Occasionally overshoots the last append, which is legal and moves
        // the sequence forward.
        ahead: fc.integer({ min: 0, max: 3 }),
      }),
      fc.record({ kind: fc.constant("compact" as const) }),
    ),
    { maxLength: 40 },
  );

  it("agrees with the filesystem after any sequence of operations", () => {
    fc.assert(
      fc.property(ops, (operations) => {
        const dir = tempDir();
        const wal = createWal({ dir });

        for (const op of operations as Op[]) {
          if (op.kind === "append") wal.append(op.value);
          else if (op.kind === "compact") wal.compact();
          else wal.checkpoint(wal.stats().lastSeq + op.ahead);
        }

        const stats = wal.stats();
        expect(stats.bytes).toBe(statSync(walPath(dir)).size);
        expect(stats.pendingEntries).toBe(wal.replay().length);
        expect(stats.checkpoint).toBeLessThanOrEqual(stats.lastSeq);
        expect(stats.reclaimableBytes).toBeLessThanOrEqual(stats.bytes);

        // The headline promise: reclaimableBytes is exactly what compact frees.
        const predicted = stats.reclaimableBytes;
        const before = statSync(walPath(dir)).size;
        wal.compact();
        expect(before - statSync(walPath(dir)).size).toBe(predicted);
        expect(wal.stats().reclaimableBytes).toBe(0);
        wal.close();
      }),
      { numRuns: 200 },
    );
  });

  it("reconstructs the same counters after a restart", () => {
    fc.assert(
      fc.property(ops, (operations) => {
        const dir = tempDir();
        const first = createWal({ dir });
        for (const op of operations as Op[]) {
          if (op.kind === "append") first.append(op.value);
          else if (op.kind === "compact") first.compact();
          else first.checkpoint(first.stats().lastSeq + op.ahead);
        }
        const before = first.stats();
        first.close();

        // Counters maintained in memory must match the ones rebuilt by the
        // open-time scan, or a restart would silently change the policy.
        const second = createWal({ dir });
        expect(second.stats()).toEqual(before);
        second.close();
      }),
      { numRuns: 200 },
    );
  });
});
