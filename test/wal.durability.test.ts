import { appendFileSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createWal } from "../src/index.js";
import { cleanupTempDirs, tempDir } from "./helpers.js";

afterEach(cleanupTempDirs);

describe("restart and corruption recovery", () => {
  it("replays uncommitted entries after reopening", () => {
    const dir = tempDir();
    const first = createWal<string>({ dir });
    first.append("committed");
    first.append("pending");
    first.checkpoint(1);
    first.close();

    const second = createWal<string>({ dir });
    expect(second.replay()).toEqual([{ seq: 2, value: "pending" }]);
    expect(second.append("next")).toBe(3);
    second.close();
  });

  it("heals a torn tail before accepting another append", () => {
    const dir = tempDir();
    const first = createWal<string>({ dir });
    first.append("safe");
    first.close();
    appendFileSync(`${dir}/wal.jsonl`, '{"seq":2,"value":"torn');

    const second = createWal<string>({ dir });
    expect(second.append("fresh")).toBe(2);
    second.close();

    const third = createWal<string>({ dir });
    expect(third.replay()).toEqual([
      { seq: 1, value: "safe" },
      { seq: 2, value: "fresh" },
    ]);
    third.close();
  });

  it("may reissue the seq of an append that never returned", () => {
    const dir = tempDir();
    const first = createWal({ dir });
    first.append("safe");
    first.close();
    appendFileSync(`${dir}/wal.jsonl`, '{"seq":2');

    const second = createWal({ dir });
    expect(second.append("replacement")).toBe(2);
    second.close();
  });

  it("falls back to checkpoint zero when the checkpoint is corrupt", () => {
    const dir = tempDir();
    const first = createWal<string>({ dir });
    first.append("one");
    first.append("two");
    first.checkpoint(2);
    first.close();
    writeFileSync(`${dir}/wal.checkpoint`, "2garbage");

    const second = createWal<string>({ dir });
    expect(second.replay()).toEqual([
      { seq: 1, value: "one" },
      { seq: 2, value: "two" },
    ]);
    second.close();
  });

  it("ignores leftover temp files and overwrites them on the next operation", () => {
    const dir = tempDir();
    const first = createWal<string>({ dir });
    first.append("one");
    first.close();
    writeFileSync(`${dir}/wal.checkpoint.tmp`, "garbage");
    writeFileSync(`${dir}/wal.jsonl.tmp`, "garbage");

    const second = createWal<string>({ dir });
    expect(second.replay()).toEqual([{ seq: 1, value: "one" }]);
    second.checkpoint(1);
    second.compact();
    second.close();

    expect(readFileSync(`${dir}/wal.checkpoint`, "utf8")).toBe("1");
    expect(statSync(`${dir}/wal.jsonl`).size).toBe(0);
  });

  it("executes append, checkpoint, compaction and close in fsync mode", () => {
    const dir = tempDir();
    const first = createWal<string>({ dir, fsync: true });
    first.append("one");
    first.append("two");
    first.checkpoint(1);
    first.compact();
    first.close();

    const second = createWal<string>({ dir, fsync: true });
    expect(second.replay()).toEqual([{ seq: 2, value: "two" }]);
    second.close();
  });

  it("does not silently skip corruption in the middle of the log", () => {
    const dir = tempDir();
    writeFileSync(
      `${dir}/wal.jsonl`,
      '{"seq":1,"value":"one"}\nnot-json\n{"seq":2,"value":"two"}\n',
    );

    expect(() => createWal({ dir })).toThrow(SyntaxError);
  });

  it("does not mistake a complete corrupt final record for a torn write", () => {
    const dir = tempDir();
    writeFileSync(`${dir}/wal.jsonl`, '{"seq":1,"value":"one"}\nnot-json\n');

    expect(() => createWal({ dir })).toThrow(SyntaxError);
  });

  it("validates UTF-8 entries that cross startup scan chunks", () => {
    const dir = tempDir();
    const first = createWal<string>({ dir });
    const value = "€".repeat(30_000);
    first.append(value);
    first.close();

    const second = createWal<string>({ dir });
    expect(second.replay()).toEqual([{ seq: 1, value }]);
    second.close();
  });

  it("rejects non-monotonic sequence numbers on disk", () => {
    const dir = tempDir();
    writeFileSync(
      `${dir}/wal.jsonl`,
      '{"seq":2,"value":"two"}\n{"seq":1,"value":"one"}\n',
    );

    expect(() => createWal({ dir })).toThrow(SyntaxError);
  });

  it("surfaces an automatic compaction failure instead of swallowing it", async () => {
    const dir = tempDir();
    const wal = createWal<string>({ dir, compactInterval: 10 });
    wal.append("one");
    // Corrupting after open is the only way to reach a compaction that fails:
    // createWal itself would have refused to open this file.
    appendFileSync(`${dir}/wal.jsonl`, "not-json\n");

    const warning = await new Promise<Error>((resolve) => {
      process.once("warning", resolve);
    });

    expect(warning.name).toBe("ProcessWalWarning");
    expect(warning.message).toContain("automatic compaction failed");
    wal.close();
  });

  it("rejects complete records with an invalid envelope", () => {
    const dir = tempDir();
    writeFileSync(`${dir}/wal.jsonl`, '{"seq":0,"value":"invalid"}\n');

    expect(() => createWal({ dir })).toThrow(SyntaxError);
  });
});
