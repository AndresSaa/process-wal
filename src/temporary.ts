import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { join } from "node:path";

// A temporary is created exclusively, under a name nobody can predict. Opening
// a fixed path with "w" follows whatever is already there, so an entry planted
// in the directory — a symlink to a file outside it — would be written through.
// "wx" refuses an existing entry, and the random suffix means there is nothing
// to plant at.
export function temporaryFor(target: string): string {
  return `${target}.${randomBytes(8).toString("hex")}.tmp`;
}

export function discardTemporary(path: string): void {
  try {
    fs.rmSync(path, { force: true });
  } catch {
    // Cleanup is best-effort: the operation already failed, and sweepTemporaries
    // collects whatever is left on the next open.
  }
}

/**
 * Remove temporaries abandoned by an interrupted checkpoint or compaction.
 * Safe at open because the WAL is single-writer: nothing else owns them, and a
 * compaction temporary can be as large as the log itself.
 */
export function sweepTemporaries(dir: string): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (/^wal\.(jsonl|checkpoint)\.[0-9a-f]{16}\.tmp$/.test(entry)) {
      discardTemporary(join(dir, entry));
    }
  }
}

/**
 * A single write can be short. Every caller that hands a whole buffer to the
 * kernel has to loop, so it lives here once rather than at each call site.
 */
