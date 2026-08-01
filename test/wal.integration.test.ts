import { type ChildProcess, fork } from "node:child_process";
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createWal } from "../src/index.js";
import { cleanupTempDirs, tempDir } from "./helpers.js";

const fixture = fileURLToPath(
  new URL("./fixtures/wal-child.mjs", import.meta.url),
);

/**
 * Far below the ~46 MiB of log these tests build, and far above what streaming
 * one entry at a time needs. An implementation that materialised the log would
 * exhaust this and die, which is the entire assertion: the claim is that memory
 * does not grow with the log, and a process that survives a ceiling the log
 * cannot fit under has demonstrated exactly that.
 *
 * Verified to have teeth before being relied on — under this ceiling `cursor()`
 * walks all 24,000 entries, while `replay()` over the same log dies with a V8
 * out-of-memory. Raising it much further would let a materialising
 * implementation pass.
 */
const HEAP_CEILING_MB = 80;

afterEach(cleanupTempDirs);

/**
 * Resolves with the child's message, or rejects describing how it died. The
 * previous version listened only for `message`, so a child that crashed left
 * the test waiting for its own timeout and said nothing about why.
 */
function reportOf<T>(child: ChildProcess): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let message: T | undefined;
    let received = false;
    child.once("message", (value) => {
      message = value as T;
      received = true;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (!received) {
        reject(
          new Error(
            `child exited before reporting: code=${code} signal=${signal} —` +
              ` under a ${HEAP_CEILING_MB} MiB heap ceiling that means the log` +
              ` was being held in memory rather than streamed`,
          ),
        );
        return;
      }
      if (code === 0 || code === null) resolve(message as T);
      else reject(new Error(`child reported, then exited with code ${code}`));
    });
  });
}

function buildLargeLog(): { dir: string; entries: number; bytes: number } {
  const dir = tempDir();
  const wal = createWal<string>({ dir });
  const value = "x".repeat(2_000);
  const entries = 24_000;
  for (let index = 0; index < entries; index += 1) wal.append(value);
  wal.close();
  return { dir, entries, bytes: statSync(`${dir}/wal.jsonl`).size };
}

function forkBounded(args: string[]): ChildProcess {
  return fork(fixture, args, {
    stdio: ["ignore", "ignore", "inherit", "ipc"],
    execArgv: [`--max-old-space-size=${HEAP_CEILING_MB}`],
  });
}

describe("process integration", () => {
  it("recovers every append acknowledged before SIGKILL", async () => {
    const dir = tempDir();
    const child = fork(fixture, ["append", dir, "100"], {
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    });
    await new Promise<void>((resolve, reject) => {
      child.once("message", () => resolve());
      child.once("error", reject);
      child.once("exit", (code, signal) =>
        reject(new Error(`child exited early: code=${code} signal=${signal}`)),
      );
    });

    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));

    const wal = createWal<{ index: number }>({ dir });
    expect(wal.replay()).toHaveLength(100);
    expect(wal.replay()[99]).toEqual({ seq: 100, value: { index: 99 } });
    wal.close();
  });

  it("does not keep a process alive with the compaction timer", async () => {
    const dir = tempDir();
    const child = fork(fixture, ["timer", dir, "0"], {
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    });

    const outcome = await Promise.race([
      new Promise<string>((resolve) =>
        child.once("exit", (code, signal) =>
          resolve(`exited ${code}/${signal}`),
        ),
      ),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve("still running"), 2_000),
      ),
    ]);

    // The exit code matters. A child that crashed on startup also stops
    // running, and would prove nothing about the timer being unref'ed.
    expect(outcome).toBe("exited 0/null");
  });

  it("compacts a large log under a heap ceiling it could not fit under", async () => {
    const { dir, entries, bytes } = buildLargeLog();
    expect(bytes).toBeGreaterThan(40 * 1024 * 1024);

    const report = await reportOf<{ pendingEntries: number }>(
      forkBounded(["compact", dir, String(entries / 2)]),
    );

    expect(report.pendingEntries).toBe(entries / 2);
    // Half the entries were checkpointed away, so the survivors must be a
    // proportional slice of the original file, not the whole thing.
    expect(statSync(`${dir}/wal.jsonl`).size).toBeLessThan(bytes * 0.6);
    const reopened = createWal<string>({ dir });
    expect(reopened.replay()).toHaveLength(entries / 2);
    reopened.close();
  }, 60_000);

  it("streams a large log under a heap ceiling it could not fit under", async () => {
    const { dir, entries, bytes } = buildLargeLog();
    expect(bytes).toBeGreaterThan(40 * 1024 * 1024);

    const report = await reportOf<{ entries: number; lastSeq: number }>(
      forkBounded(["cursor", dir, "0"]),
    );

    expect(report.entries).toBe(entries);
    expect(report.lastSeq).toBe(entries);
  }, 60_000);
});
