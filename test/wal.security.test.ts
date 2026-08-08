import {
  chmodSync,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
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

  // Five storage flushes per iteration — the append, the checkpoint file and
  // its directory, the compacted file and the directory its rename lands in —
  // so a hundred in all. What that costs is a property of the host filesystem
  // rather than of the code, the same reason the measured append range spans
  // 0.47-1.49 ms between NTFS and ext4, and a loaded Windows runner has already
  // blown the 5 s default once. Neither number below can come down to fit it:
  // accumulation is what repetition exposes, and `fsync` is what puts the
  // temporaries on the path being checked.
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
  }, 30_000);
});

describe("an interrupted mutation leaves a usable instance", () => {
  /** POSIX only, and not as root: a non-writable directory makes rename fail. */
  function freeze(dir: string): boolean {
    try {
      chmodSync(dir, 0o555);
      writeFileSync(join(dir, ".probe"), "x");
      // The write succeeded, so permissions are not enforced here.
      chmodSync(dir, 0o755);
      return false;
    } catch {
      return true;
    }
  }

  it("keeps its writer and its accounting when compaction cannot rename", () => {
    const dir = tempDir();
    const wal = createWal<string>({ dir });
    wal.append("one");
    wal.append("two");
    wal.checkpoint(1);
    const before = wal.stats();

    if (!freeze(dir)) {
      wal.close();
      return;
    }

    expect(() => wal.compact()).toThrow();
    chmodSync(dir, 0o755);

    // The writer was closed before the rename was attempted. Losing it would
    // leave every later append failing on a closed descriptor.
    expect(wal.append("three")).toBe(3);
    // Nothing was reclaimed, so the accounting must not pretend otherwise.
    expect(wal.stats().reclaimableBytes).toBe(before.reclaimableBytes);
    expect(wal.stats().bytes).toBe(statSync(join(dir, "wal.jsonl")).size);
    expect(wal.replay().map((entry) => entry.value)).toEqual(["two", "three"]);
    wal.close();
  });

  it("refuses to reuse a sequence number, because a repeat is unrecoverable", () => {
    // This is the state a failed flush leaves behind: the record reached the
    // file but the sequence was never published, so a naive retry writes it
    // again. The result is not a lost entry — it is a log that will not open.
    const dir = tempDir();
    writeFileSync(
      join(dir, "wal.jsonl"),
      `{"seq":1,"value":"a"}\n{"seq":1,"value":"retry"}\n`,
    );

    expect(() => createWal({ dir })).toThrow(SyntaxError);
    expect(() => createWal({ dir })).toThrow(/sequence numbers must increase/);
  });
});
