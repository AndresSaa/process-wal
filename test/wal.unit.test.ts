import { readFileSync, statSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createWal } from "../src/index.js";
import { cleanupTempDirs, tempDir } from "./helpers.js";

afterEach(cleanupTempDirs);

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
