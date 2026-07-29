import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, bench, describe } from "vitest";
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
const options = {
  iterations: 10_000,
  time: 0,
  warmupIterations: 100,
  warmupTime: 0,
};

describe("append latency", () => {
  bench(
    "fsync: false",
    () => {
      pageCacheWal.append({ value: 42 });
    },
    options,
  );
  bench(
    "fsync: true",
    () => {
      fsyncWal.append({ value: 42 });
    },
    options,
  );
});

afterAll(() => {
  pageCacheWal.close();
  fsyncWal.close();
  for (const dir of directories) rmSync(dir, { recursive: true, force: true });
});
