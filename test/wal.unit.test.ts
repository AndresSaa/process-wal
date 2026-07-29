import { readFileSync, statSync } from "node:fs";
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

  it("throws ERR_WAL_CLOSED from every method after close", () => {
    const wal = createWal({ dir: tempDir() });
    wal.close();

    const calls = [
      () => wal.append("value"),
      () => wal.checkpoint(1),
      () => wal.replay(),
      () => wal.cursor(),
      () => wal.compact(),
      () => wal.close(),
    ];
    for (const call of calls) {
      expect(call).toThrow(expect.objectContaining({ code: "ERR_WAL_CLOSED" }));
    }
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
    expect(wal.append("two")).toBe(2);
    expect(wal.replay()).toEqual([]);
    expect(await collect(wal.cursor())).toEqual([]);
    wal.checkpoint(2);
    wal.compact();
    wal.close();
    expect(() => wal.append("closed")).toThrow(
      expect.objectContaining({ code: "ERR_WAL_CLOSED" }),
    );
  });
});
