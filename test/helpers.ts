import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directories = new Set<string>();

export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "wal-test-"));
  directories.add(dir);
  return dir;
}

export function cleanupTempDirs(): void {
  for (const dir of directories) rmSync(dir, { recursive: true, force: true });
  directories.clear();
}
