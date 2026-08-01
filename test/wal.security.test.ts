import {
  existsSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWal } from "../src/index.js";
import { cleanupTempDirs, tempDir } from "./helpers.js";

afterEach(cleanupTempDirs);

/**
 * Creating a symlink needs elevation or Developer Mode on Windows. Where that
 * is unavailable the attack cannot be staged either, so skipping is honest
 * rather than convenient — but it must be visible, not silent.
 */
function plantSymlink(target: string, at: string): boolean {
  try {
    symlinkSync(target, at, "file");
    return true;
  } catch {
    return false;
  }
}

const UNTOUCHED = "outside the wal directory";

describe("a planted directory entry cannot redirect a write", () => {
  it("does not follow a symlink at the checkpoint temporary", () => {
    const dir = tempDir();
    const outside = join(tempDir(), "victim.txt");
    writeFileSync(outside, UNTOUCHED);

    const wal = createWal<string>({ dir });
    wal.append("one");

    // The pre-1.3.1 temporary name. Planting it used to hand the attacker the
    // write, because the temporary was opened with "w" and followed the link.
    if (!plantSymlink(outside, join(dir, "wal.checkpoint.tmp"))) {
      wal.close();
      return;
    }

    wal.checkpoint(1);

    expect(readFileSync(outside, "utf8")).toBe(UNTOUCHED);
    // The checkpoint still landed where it belongs.
    expect(readFileSync(join(dir, "wal.checkpoint"), "utf8").trim()).toBe("1");
    wal.close();
  });

  it("does not follow a symlink at the compaction temporary", () => {
    const dir = tempDir();
    const outside = join(tempDir(), "victim.txt");
    writeFileSync(outside, UNTOUCHED);

    const wal = createWal<string>({ dir });
    wal.append("one");
    wal.append("two");
    wal.checkpoint(1);

    if (!plantSymlink(outside, join(dir, "wal.jsonl.tmp"))) {
      wal.close();
      return;
    }

    wal.compact();

    expect(readFileSync(outside, "utf8")).toBe(UNTOUCHED);
    expect(wal.replay().map((entry) => entry.value)).toEqual(["two"]);
    wal.close();
  });

  it("refuses to reuse an existing entry as its temporary", () => {
    const dir = tempDir();
    const wal = createWal<string>({ dir });
    wal.append("one");

    // Not a symlink this time — a plain file where a temporary might go. An
    // exclusive create must not overwrite it either.
    const squatted = join(dir, "wal.checkpoint.tmp");
    writeFileSync(squatted, "squatter");

    wal.checkpoint(1);

    expect(readFileSync(squatted, "utf8")).toBe("squatter");
    expect(readFileSync(join(dir, "wal.checkpoint"), "utf8").trim()).toBe("1");
    wal.close();
  });
});

describe("temporaries left by an interrupted write", () => {
  it("are swept on open, and only the ones this library creates", () => {
    const dir = tempDir();
    const wal = createWal<string>({ dir });
    wal.append("one");
    wal.close();

    const orphans = [
      `wal.jsonl.${"a".repeat(16)}.tmp`,
      `wal.checkpoint.${"b".repeat(16)}.tmp`,
    ];
    for (const name of orphans) writeFileSync(join(dir, name), "leftover");
    // Files that merely look similar belong to someone else.
    const foreign = ["wal.jsonl.tmp", "notes.tmp", "wal.jsonl.zzz.tmp"];
    for (const name of foreign) writeFileSync(join(dir, name), "not ours");

    const reopened = createWal<string>({ dir });

    for (const name of orphans) {
      expect(existsSync(join(dir, name))).toBe(false);
    }
    for (const name of foreign) {
      expect(readFileSync(join(dir, name), "utf8")).toBe("not ours");
    }
    expect(reopened.replay().map((entry) => entry.value)).toEqual(["one"]);
    reopened.close();
  });

  it("does not accumulate temporaries across repeated writes", () => {
    const dir = tempDir();
    const wal = createWal<number>({ dir, fsync: true });
    for (let i = 1; i <= 20; i += 1) {
      wal.append(i);
      wal.checkpoint(i);
      wal.compact();
    }

    const leftovers = readdirSync(dir).filter((name) => name.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
    wal.close();
  });
});
