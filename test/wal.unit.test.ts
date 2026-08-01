import { readFileSync, statSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createNoopWal, createWal } from "../src/index.js";
import { cleanupTempDirs, tempDir } from "./helpers.js";

afterEach(cleanupTempDirs);

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}

describe("createWal", () => {
  it("appends and replays values in sequence", () => {
    const wal = createWal<{ id: number }>({ dir: tempDir() });

    expect(wal.append({ id: 1 })).toBe(1);
    expect(wal.append({ id: 2 })).toBe(2);
    expect(wal.replay()).toEqual([
      { seq: 1, value: { id: 1 } },
      { seq: 2, value: { id: 2 } },
    ]);
    wal.close();
  });

  it("checkpoints monotonically and keeps future appends visible", () => {
    const wal = createWal<string>({ dir: tempDir() });
    wal.append("one");

    wal.checkpoint(10);
    wal.checkpoint(5);
    expect(wal.append("eleven")).toBe(11);
    expect(wal.replay()).toEqual([{ seq: 11, value: "eleven" }]);
    wal.close();
  });

  it("compacts committed bytes without changing replay", () => {
    const dir = tempDir();
    const wal = createWal<string>({ dir });
    const value = "x".repeat(1_000);
    wal.append(value);
    wal.append(value);
    wal.append("keep");
    wal.checkpoint(2);
    const before = statSync(`${dir}/wal.jsonl`).size;

    wal.compact();

    expect(statSync(`${dir}/wal.jsonl`).size).toBeLessThan(before);
    expect(wal.replay()).toEqual([{ seq: 3, value: "keep" }]);
    wal.close();
  });

  it("rejects oversized and non-serializable entries without consuming a seq", () => {
    const wal = createWal<unknown>({ dir: tempDir(), maxEntryBytes: 50 });
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    for (const value of ["x".repeat(100), circular, undefined, 1n]) {
      const code =
        typeof value === "string"
          ? "ERR_ENTRY_TOO_LARGE"
          : "ERR_ENTRY_NOT_SERIALIZABLE";
      expect(() => wal.append(value)).toThrow(
        expect.objectContaining({ code }),
      );
    }
    expect(wal.append("ok")).toBe(1);
    wal.close();
  });

  it("throws ERR_WAL_CLOSED from every method except close", () => {
    const wal = createWal({ dir: tempDir() });
    wal.close();

    const calls = [
      () => wal.append("value"),
      () => wal.checkpoint(1),
      () => wal.replay(),
      () => wal.cursor(),
      () => wal.compact(),
    ];
    for (const call of calls) {
      expect(call).toThrow(expect.objectContaining({ code: "ERR_WAL_CLOSED" }));
    }
  });

  it("closes idempotently, because shutdown paths run twice", () => {
    // A `finally` and a SIGTERM handler both firing is correct code, not a
    // bug, so it must not be punished with a throw.
    const wal = createWal({ dir: tempDir(), fsync: true, compactInterval: 50 });
    wal.append("one");

    expect(() => {
      wal.close();
      wal.close();
      wal.close();
    }).not.toThrow();

    // Still closed for everything else — accepting an append here would
    // silently drop work.
    expect(() => wal.append("after")).toThrow(
      expect.objectContaining({ code: "ERR_WAL_CLOSED" }),
    );
  });

  it("disposes through Symbol.dispose and stays idempotent", () => {
    const dir = tempDir();
    const wal = createWal({ dir });
    wal.append("one");

    wal[Symbol.dispose]();
    expect(() => wal.append("after")).toThrow(
      expect.objectContaining({ code: "ERR_WAL_CLOSED" }),
    );
    // Disposal after an explicit close, and vice versa, are both no-ops.
    expect(() => {
      wal[Symbol.dispose]();
      wal.close();
    }).not.toThrow();
  });

  it("releases the writer at the end of a `using` block", () => {
    const dir = tempDir();
    {
      using wal = createWal<string>({ dir });
      wal.append("one");
    }
    // If the descriptor had leaked, reopening and appending would still work,
    // so prove the close ran by observing the durable state instead.
    const reopened = createWal<string>({ dir });
    expect(reopened.replay().map((entry) => entry.value)).toEqual(["one"]);
    reopened.close();
  });

  it("appends a batch in one write and returns contiguous seqs", () => {
    const dir = tempDir();
    const wal = createWal<string>({ dir });

    expect(wal.appendMany(["a", "b", "c"])).toEqual([1, 2, 3]);
    expect(wal.append("d")).toBe(4);
    expect(wal.appendMany(["e", "f"])).toEqual([5, 6]);

    expect(wal.replay().map((entry) => entry.value)).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
    ]);
    expect(wal.stats()).toMatchObject({ lastSeq: 6, pendingEntries: 6 });
    expect(wal.stats().bytes).toBe(statSync(`${dir}/wal.jsonl`).size);
    wal.close();
  });

  it("treats an empty batch as a no-op", () => {
    const dir = tempDir();
    const wal = createWal<string>({ dir });
    wal.append("one");
    const before = wal.stats();

    expect(wal.appendMany([])).toEqual([]);

    // No seq burned, no bytes written, no flush.
    expect(wal.stats()).toEqual(before);
    expect(wal.stats().bytes).toBe(statSync(`${dir}/wal.jsonl`).size);
    wal.close();
  });

  it("writes nothing when any value in the batch is rejected", () => {
    const dir = tempDir();
    const wal = createWal({ dir });
    wal.append("first");
    const before = wal.stats();

    // The failure is in the middle: the records before it must not reach disk,
    // or the caller would have half a batch it was never told about.
    expect(() => wal.appendMany(["ok", () => {}, "ok"])).toThrow(
      expect.objectContaining({ code: "ERR_ENTRY_NOT_SERIALIZABLE" }),
    );
    expect(() =>
      wal.appendMany(["ok", { blob: "x".repeat(2 ** 21) }, "ok"]),
    ).toThrow(expect.objectContaining({ code: "ERR_ENTRY_TOO_LARGE" }));

    expect(wal.stats()).toEqual(before);
    expect(statSync(`${dir}/wal.jsonl`).size).toBe(before.bytes);
    // The sequence is untouched, so the next append continues where it left off.
    expect(wal.append("second")).toBe(2);
    wal.close();
  });

  it("keeps a batch across a restart", () => {
    const dir = tempDir();
    const first = createWal<number>({ dir, fsync: true });
    first.appendMany([1, 2, 3, 4, 5]);
    first.close();

    const second = createWal<number>({ dir });
    expect(second.replay().map((entry) => entry.value)).toEqual([
      1, 2, 3, 4, 5,
    ]);
    expect(second.stats().lastSeq).toBe(5);
    second.close();
  });

  it("throws ERR_WAL_CLOSED from appendMany after close", () => {
    const wal = createWal({ dir: tempDir() });
    wal.close();
    expect(() => wal.appendMany(["a"])).toThrow(
      expect.objectContaining({ code: "ERR_WAL_CLOSED" }),
    );
  });

  it("reports position and size without touching disk", () => {
    const dir = tempDir();
    const wal = createWal<string>({ dir });

    expect(wal.stats()).toEqual({
      lastSeq: 0,
      checkpoint: 0,
      pendingEntries: 0,
      bytes: 0,
      reclaimableBytes: 0,
    });

    wal.append("x".repeat(500));
    wal.append("small");
    const full = wal.stats();
    expect(full.lastSeq).toBe(2);
    expect(full.pendingEntries).toBe(2);
    expect(full.bytes).toBe(statSync(`${dir}/wal.jsonl`).size);
    // Nothing is checkpointed, so compact() would free nothing.
    expect(full.reclaimableBytes).toBe(0);

    wal.checkpoint(1);
    const half = wal.stats();
    expect(half.checkpoint).toBe(1);
    expect(half.pendingEntries).toBe(1);
    // The large record is the one that became reclaimable, which is why this
    // cannot be derived from counts alone.
    expect(half.reclaimableBytes).toBeGreaterThan(500);
    expect(half.reclaimableBytes).toBeLessThan(half.bytes);

    wal.compact();
    expect(wal.stats()).toMatchObject({
      reclaimableBytes: 0,
      pendingEntries: 1,
    });
    expect(wal.stats().bytes).toBe(statSync(`${dir}/wal.jsonl`).size);
    wal.close();
  });

  it("counts a checkpoint beyond the last append as covering everything", () => {
    const wal = createWal<string>({ dir: tempDir() });
    wal.append("one");
    wal.append("two");
    const { bytes } = wal.stats();

    wal.checkpoint(10);

    expect(wal.stats()).toMatchObject({
      lastSeq: 10,
      checkpoint: 10,
      pendingEntries: 0,
      reclaimableBytes: bytes,
    });
    wal.close();
  });

  it("throws ERR_WAL_CLOSED from stats after close", () => {
    const wal = createWal({ dir: tempDir() });
    wal.close();
    expect(() => wal.stats()).toThrow(
      expect.objectContaining({ code: "ERR_WAL_CLOSED" }),
    );
  });

  it("validates numeric options and sequence inputs", () => {
    expect(() => createWal({ dir: tempDir(), maxEntryBytes: 0 })).toThrow(
      RangeError,
    );
    expect(() => createWal({ dir: tempDir(), compactInterval: 0 })).toThrow(
      RangeError,
    );

    const wal = createWal({ dir: tempDir() });
    expect(() => wal.checkpoint(Number.NaN)).toThrow(RangeError);
    expect(() => wal.cursor({ fromSeq: -1 })).toThrow(RangeError);
    wal.close();
  });

  it("does not create an unsafe sequence after an extreme checkpoint", () => {
    const wal = createWal({ dir: tempDir() });
    wal.checkpoint(Number.MAX_SAFE_INTEGER);

    expect(() => wal.append("overflow")).toThrow(RangeError);
    wal.close();
  });

  it("writes a plain JSONL envelope", () => {
    const dir = tempDir();
    const wal = createWal({ dir });
    wal.append({ ok: true });
    wal.close();

    expect(readFileSync(`${dir}/wal.jsonl`, "utf8")).toBe(
      '{"seq":1,"value":{"ok":true}}\n',
    );
  });
});

describe("cursor", () => {
  it("matches replay and treats fromSeq as an exclusive high-water mark", async () => {
    const wal = createWal<string>({ dir: tempDir() });
    wal.append("one");
    wal.append("two");
    wal.append("three");

    expect(await collect(wal.cursor({ fromSeq: 1 }))).toEqual(
      wal.replay().slice(1),
    );
    wal.close();
  });

  it("freezes checkpoint and file size at creation", async () => {
    const wal = createWal<string>({ dir: tempDir() });
    wal.append("one");
    wal.append("two");
    const cursor = wal.cursor();

    wal.checkpoint(2);
    wal.append("three");

    expect(await collect(cursor)).toEqual([
      { seq: 1, value: "one" },
      { seq: 2, value: "two" },
    ]);
    expect(wal.replay()).toEqual([{ seq: 3, value: "three" }]);
    wal.close();
  });

  it("defers compaction until all cursors release their file descriptors", async () => {
    const dir = tempDir();
    const wal = createWal<string>({ dir });
    wal.append("x".repeat(1_000));
    wal.append("x".repeat(1_000));
    wal.append("keep");
    wal.checkpoint(2);
    const first = wal.cursor();
    const second = wal.cursor();
    const before = statSync(`${dir}/wal.jsonl`).size;

    wal.compact();
    expect(statSync(`${dir}/wal.jsonl`).size).toBe(before);
    await first.return?.();
    expect(statSync(`${dir}/wal.jsonl`).size).toBe(before);
    await collect(second);

    expect(statSync(`${dir}/wal.jsonl`).size).toBeLessThan(before);
    expect(wal.replay()).toEqual([{ seq: 3, value: "keep" }]);
    wal.close();
  });

  it("releases its file descriptor through Symbol.asyncDispose", async () => {
    const dir = tempDir();
    const wal = createWal<string>({ dir });
    wal.append("x".repeat(1_000));
    wal.append("second");
    wal.append("third");
    // Checkpoint only the first, so the cursor still has entries to yield and
    // therefore still owns its descriptor after one next().
    wal.checkpoint(1);
    const before = statSync(`${dir}/wal.jsonl`).size;

    const cursor = wal.cursor();
    expect((await cursor.next()).value).toEqual({ seq: 2, value: "second" });

    wal.compact();
    expect(statSync(`${dir}/wal.jsonl`).size).toBe(before);

    await cursor[Symbol.asyncDispose]();

    expect(statSync(`${dir}/wal.jsonl`).size).toBeLessThan(before);
    expect(wal.replay()).toEqual([
      { seq: 2, value: "second" },
      { seq: 3, value: "third" },
    ]);
    wal.close();
  });

  it("disposes a cursor that was never iterated, and tolerates a second dispose", async () => {
    const dir = tempDir();
    const wal = createWal<string>({ dir });
    wal.append("done");
    wal.checkpoint(1);

    const cursor = wal.cursor();
    await cursor[Symbol.asyncDispose]();
    await cursor[Symbol.asyncDispose]();

    wal.compact();
    expect(statSync(`${dir}/wal.jsonl`).size).toBe(0);
    wal.close();
  });

  it("releases the descriptor at the end of an `await using` block", async () => {
    const dir = tempDir();
    const wal = createWal<string>({ dir });
    wal.append("done");
    wal.checkpoint(1);

    {
      await using cursor = wal.cursor();
      await cursor.next();
      // Leaving the block early is the case that used to leak the descriptor
      // and defer compact() for the life of the process.
    }

    wal.compact();
    expect(statSync(`${dir}/wal.jsonl`).size).toBe(0);
    wal.close();
  });

  it("releases its file descriptor when a consumer aborts with throw", async () => {
    const dir = tempDir();
    const wal = createWal<string>({ dir });
    wal.append("done");
    wal.checkpoint(1);
    const cursor = wal.cursor();

    await expect(cursor.throw?.(new Error("stop"))).rejects.toThrow("stop");
    wal.compact();

    expect(statSync(`${dir}/wal.jsonl`).size).toBe(0);
    wal.close();
  });

  it("releases its file descriptor when iteration stops after a value", async () => {
    const dir = tempDir();
    const wal = createWal<string>({ dir });
    wal.append("done");
    const cursor = wal.cursor({ fromSeq: 0 });
    wal.checkpoint(1);
    await expect(cursor.next()).resolves.toEqual({
      done: false,
      value: { seq: 1, value: "done" },
    });
    await cursor.return?.();

    wal.compact();

    expect(statSync(`${dir}/wal.jsonl`).size).toBe(0);
    wal.close();
  });
});

describe("createNoopWal", () => {
  it("keeps the same lifecycle shape without touching disk", async () => {
    const wal = createNoopWal<string>();

    expect(wal.append("one")).toBe(1);
    expect(wal.appendMany(["two", "three"])).toEqual([2, 3]);
    expect(wal.append("four")).toBe(4);
    expect(wal.replay()).toEqual([]);
    expect(await collect(wal.cursor())).toEqual([]);
    wal.checkpoint(4);
    wal.compact();
    expect(wal.stats()).toEqual({
      lastSeq: 4,
      checkpoint: 4,
      pendingEntries: 0,
      bytes: 0,
      reclaimableBytes: 0,
    });
    wal.close();
    expect(() => wal.append("closed")).toThrow(
      expect.objectContaining({ code: "ERR_WAL_CLOSED" }),
    );
  });

  it("mirrors the disposable lifecycle of the real WAL", async () => {
    const wal = createNoopWal<string>();

    await using cursor = wal.cursor();
    expect(await cursor.next()).toEqual({ done: true, value: undefined });

    expect(() => {
      wal.close();
      wal.close();
      wal[Symbol.dispose]();
    }).not.toThrow();
    expect(() => wal.append("closed")).toThrow(
      expect.objectContaining({ code: "ERR_WAL_CLOSED" }),
    );
  });
});

describe("accounting with gapped sequences", () => {
  it("stays exact when the pending records are not contiguous", () => {
    const dir = tempDir();
    const first = createWal<number>({ dir });
    for (let i = 1; i <= 101; i += 1) first.append(i);
    first.checkpoint(100);
    first.compact();
    first.close();

    // A corrupt checkpoint falls back to 0, which is documented and safe. What
    // it leaves behind is a log whose only record is seq 101 — pending records
    // that do not start at 1. Counting by numeric distance from the checkpoint
    // silently maps checkpoint(1) onto that record.
    writeFileSync(`${dir}/wal.checkpoint`, "not-json");
    const wal = createWal<number>({ dir });
    expect(wal.stats().pendingEntries).toBe(1);

    wal.checkpoint(1);

    // Nothing was covered: the only record is seq 101, far above checkpoint 1.
    expect(wal.replay()).toHaveLength(1);
    expect(wal.stats().pendingEntries).toBe(1);
    expect(wal.stats().reclaimableBytes).toBe(0);

    wal.compact();
    expect(wal.stats().bytes).toBe(statSync(`${dir}/wal.jsonl`).size);
    expect(wal.replay().map((entry) => entry.value)).toEqual([101]);
    wal.close();
  });
});
