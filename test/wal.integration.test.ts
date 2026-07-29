import { fork } from "node:child_process";
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createWal } from "../src/index.js";
import { cleanupTempDirs, tempDir } from "./helpers.js";

const fixture = fileURLToPath(
  new URL("./fixtures/wal-child.mjs", import.meta.url),
);

afterEach(cleanupTempDirs);

function startChild(mode: "append" | "timer", dir: string, count = 0) {
  const child = fork(fixture, [mode, dir, String(count)], {
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  const ready = new Promise<void>((resolve, reject) => {
    child.once("message", () => resolve());
    child.once("error", reject);
  });
  const exited = new Promise<void>((resolve) =>
    child.once("exit", () => resolve()),
  );
  return { child, ready, exited };
}

describe("process integration", () => {
  it("recovers every append acknowledged before SIGKILL", async () => {
    const dir = tempDir();
    const { child, ready, exited } = startChild("append", dir, 100);
    await ready;

    child.kill("SIGKILL");
    await exited;

    const wal = createWal<{ index: number }>({ dir });
    expect(wal.replay()).toHaveLength(100);
    expect(wal.replay()[99]).toEqual({ seq: 100, value: { index: 99 } });
    wal.close();
  });

  it("does not keep a process alive with the compaction timer", async () => {
    const dir = tempDir();
    const { exited } = startChild("timer", dir);

    await expect(
      Promise.race([
        exited.then(() => "exited"),
        new Promise((resolve) => setTimeout(() => resolve("timeout"), 2_000)),
      ]),
    ).resolves.toBe("exited");
  });

  it("compacts a large log without retaining it in RSS", async () => {
    const dir = tempDir();
    const wal = createWal<string>({ dir });
    const value = "x".repeat(2_000);
    const entries = 24_000;
    for (let index = 0; index < entries; index += 1) wal.append(value);
    wal.close();
    const logBytes = statSync(`${dir}/wal.jsonl`).size;

    const child = fork(fixture, ["compact", dir, String(entries / 2)], {
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    });
    const result = await new Promise<{ rssGrowth: number }>(
      (resolve, reject) => {
        child.once("message", (message) =>
          resolve(message as { rssGrowth: number }),
        );
        child.once("error", reject);
      },
    );

    expect(logBytes).toBeGreaterThan(40 * 1024 * 1024);
    expect(result.rssGrowth).toBeLessThan(logBytes / 2);
    // Half the entries were checkpointed away, so the survivors must be a
    // proportional slice of the original file, not the whole thing.
    expect(statSync(`${dir}/wal.jsonl`).size).toBeLessThan(logBytes * 0.6);
    const reopened = createWal<string>({ dir });
    expect(reopened.replay()).toHaveLength(entries / 2);
    reopened.close();
  }, 30_000);

  it("streams a large log without retaining it in RSS", async () => {
    const dir = tempDir();
    const wal = createWal<string>({ dir });
    const value = "x".repeat(2_000);
    const entries = 24_000;
    for (let index = 0; index < entries; index += 1) wal.append(value);
    wal.close();
    const logBytes = statSync(`${dir}/wal.jsonl`).size;

    const child = fork(fixture, ["cursor", dir, "0"], {
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    });
    const result = await new Promise<{
      entries: number;
      rssGrowth: number;
    }>((resolve, reject) => {
      child.once("message", (message) =>
        resolve(message as { entries: number; rssGrowth: number }),
      );
      child.once("error", reject);
    });

    expect(result.entries).toBe(entries);
    expect(logBytes).toBeGreaterThan(40 * 1024 * 1024);
    expect(result.rssGrowth).toBeLessThan(logBytes / 2);
  }, 30_000);
});
