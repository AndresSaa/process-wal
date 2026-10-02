import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "vitest";
import { createWal } from "../src/index.js";

const directories: string[] = [];

function benchmarkWal(fsync: boolean) {
  const dir = mkdtempSync(
    join(tmpdir(), `wal-bench-${fsync ? "sync" : "cache"}-`),
  );
  directories.push(dir);
  return createWal({ dir, fsync });
}

const pageCacheWal = benchmarkWal(false);
const fsyncWal = benchmarkWal(true);
const batchWal = benchmarkWal(true);
// vitest reports per call, so divide by the batch size to compare against the
// single-append numbers above.
const batch = Array.from({ length: 100 }, () => ({ value: 42 }));
// A positive `time` is a floor on top of `iterations`, so the run would
// continue past the 10_000 measured appends the methodology publishes.
const options = {
  iterations: 10_000,
  time: 0,
  warmupIterations: 100,
  warmupTime: 0,
};

// The iteration count is the bound. An fsync of 10_000 records exceeds the
// default 5s test timeout, and a timeout abort would publish a partial sample.
const timeout = { timeout: 0 };

test("append latency", timeout, async ({ bench }) => {
  await bench("fsync: false", () => {
    pageCacheWal.append({ value: 42 });
  }).run(options);
  await bench("fsync: true", () => {
    fsyncWal.append({ value: 42 });
  }).run(options);
});

test(
  "batched append latency, per call of 100 records",
  timeout,
  async ({ bench }) => {
    await bench("fsync: true, appendMany of 100", () => {
      batchWal.appendMany(batch);
    }).run({ ...options, iterations: 200 });
  },
);

afterAll(() => {
  pageCacheWal.close();
  fsyncWal.close();
  batchWal.close();
  for (const dir of directories) rmSync(dir, { recursive: true, force: true });
});
