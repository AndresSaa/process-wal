# Durability and recovery

This document is the complete contract. The [README](../README.md) carries the short version.

## What a successful `append` promises

A successful `append` means the complete record reached the selected durability boundary before its sequence number was returned. Which boundary that is depends on `fsync`:

| Mode                     | Boundary          | Process crash, `SIGKILL`, deploy, container restart | Host or power loss      |
| ------------------------ | ----------------- | --------------------------------------------------- | ----------------------- |
| `fsync: false` (default) | Kernel page cache | Recoverable                                         | Not guaranteed          |
| `fsync: true`            | OS storage flush  | Recoverable                                         | Requested before return |

With `fsync: true`, the flush path covers appends, checkpoint replacement, compaction, and `close()`. Filesystem, storage-controller, and hardware guarantees still apply underneath; no userspace library can strengthen them. A drive that lies about its write cache will lie to `process-wal` too.

### And what `appendMany` promises

The same, extended to the batch: if the call returns, every record in it reached
the boundary above. One write and one flush cover the whole batch.

It is **not** atomic against a crash. A single `write` is not guaranteed atomic
for a regular file, so a process killed mid-call can leave a prefix of the batch
on disk. Those records are complete and newline-terminated, so they replay like
any other work that was never acknowledged, and a torn final record is truncated
on open exactly as usual. Nothing is lost that was promised, and nothing is
promised that was not returned.

Serialisation is the one failure that _is_ all-or-nothing: the batch is encoded
before any of it is written, so a value that cannot be serialised fails the call
with the log and the sequence untouched.

## Atomicity of state files

Checkpoint and compaction write a temporary file and replace the live file with `rename`. A crash can leave a `.tmp` file behind, but it cannot leave a half-written live checkpoint.

The library creates `wal.jsonl`, `wal.checkpoint`, and temporary replacement files inside `dir`. It does not take ownership of other files there.

## Recovery on open

Three failure shapes can exist on disk. They are treated differently on purpose.

### 1. A torn final record — healed silently

A final record without a trailing `\n` is an interrupted append. Nobody was ever handed its sequence number, so nobody was promised anything. It is truncated before another append can weld valid JSON onto it.

### 2. A corrupt checkpoint — falls back to zero

A `wal.checkpoint` that does not parse falls back to zero and the whole log replays. That repeats already-finished work, which is safe for the idempotent consumers this library already requires, and never skips work.

### 3. A complete but damaged record — refuses to open

`createWal` throws a `SyntaxError` when the log contains a record that is complete (newline-terminated) but unparseable, or whose sequence number does not increase.

This is deliberate. A complete record was fully written and then corrupted by something else. Skipping it would drop work the library had already acknowledged — the exact failure this package exists to prevent. Recovery may repeat extra work, but it never silently skips it.

## Sequence numbering

Sequence numbers are monotonic within an instance. An interrupted append that never returned may have its sequence number reused after restart; the API does not promise gap-free numbering.

This is why the [at-least-once guidance](../README.md#at-least-once-not-exactly-once) says to deduplicate on an identity from your payload, never on `seq`.

A checkpoint beyond the last append is valid and advances the next sequence number, which prevents a future append from being hidden below the checkpoint.

## Repairing a log that refuses to open

Repair is a manual, one-time operation because deleting a record is a data-loss decision no library should take on its own.

```sh
# 1. Stop the writer, then keep a copy before touching anything.
cp data/wal.jsonl data/wal.jsonl.broken

# 2. Every line is independent JSON. Find the ones that do not parse.
node -e 'require("node:fs").readFileSync("data/wal.jsonl","utf8").split("\n")
  .forEach((l,i)=>{ if(!l) return;
    try { JSON.parse(l) } catch { console.log("line", i+1, JSON.stringify(l.slice(0,120))) } })'

# 3. Remove or repair those lines, keeping sequence numbers increasing, then
#    reopen. Whatever was in a deleted record is gone — replay cannot restore it.
```

If the checkpoint file is the damaged one, no repair is needed: see case 2 above.

## Observing recovery

Set `NODE_DEBUG=process-wal` to inspect heal-on-open, deferred compaction, and checkpoint-fallback branches.

The optional `compactInterval` timer is unref'ed, so it cannot keep a process alive. Nothing awaits that timer, so a failure inside it is reported with `process.emitWarning` — visible on stderr by default and catchable via `process.on("warning", …)` — rather than silently leaving the log to grow.

## Operating it

Things the contract implies but never said out loud.

**Single writer means one live instance per directory** — in one process, not
one process per machine. Two `createWal({ dir })` calls against the same
directory, in the same process or across worker threads, are two writers. The
package does not lock and cannot detect it; the result is interleaved sequence
numbers and a log that refuses to open.

**The log is plaintext.** Values are stored as the JSON you passed, readable by
anyone who can read the directory. The library creates files with whatever your
umask gives and never changes their mode, so the directory's permissions are the
only thing protecting them. Do not append secrets you would not write to a log
file, and keep the directory private to the account running the process — which
[SECURITY.md](../SECURITY.md) also requires for a different reason.

**Compaction needs headroom.** It writes the surviving records to a second file
before replacing the original, so it briefly needs free space for both. A
compaction that runs out of disk fails and leaves the original untouched.

**There are no checksums.** A record is accepted if it is valid JSON with an
increasing sequence number. Bytes altered in a way that stays valid — a digit
changed inside a value — replay as though nothing happened. The log detects
truncation and structural damage, not silent corruption.

**`maxEntryBytes` bounds writes, not reads.** It rejects an oversized record at
`append`; it does not cap what open, `replay()`, `cursor()` or compaction will
read back. A record already on disk is read whatever its size.

**Back up by copying the directory with the writer stopped.** There is no
online-backup mechanism, and copying `wal.jsonl` while appends are in flight can
capture a torn tail — which heals on open, but only for the copy that also
carries the matching `wal.checkpoint`.

**The on-disk format is part of the contract.** One JSON object per line, with
`seq` and `value`, terminated by a newline. Changing it is a major version, so a
log written by any 1.x can be opened by any later 1.x.

## What is tested

Real-filesystem tests are the executable specification, not mocks. The suite exercises torn writes, corrupt checkpoints, deferred compaction on Windows, `SIGKILL` recovery in a spawned child process, and bounded RSS for both cursors and compaction, on Node 22 and 24 across Linux, macOS, and Windows.
