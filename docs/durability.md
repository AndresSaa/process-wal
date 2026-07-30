# Durability and recovery

This document is the complete contract. The [README](../README.md) carries the short version.

## What a successful `append` promises

A successful `append` means the complete record reached the selected durability boundary before its sequence number was returned. Which boundary that is depends on `fsync`:

| Mode                     | Boundary          | Process crash, `SIGKILL`, deploy, container restart | Host or power loss      |
| ------------------------ | ----------------- | --------------------------------------------------- | ----------------------- |
| `fsync: false` (default) | Kernel page cache | Recoverable                                         | Not guaranteed          |
| `fsync: true`            | OS storage flush  | Recoverable                                         | Requested before return |

With `fsync: true`, the flush path covers appends, checkpoint replacement, compaction, and `close()`. Filesystem, storage-controller, and hardware guarantees still apply underneath; no userspace library can strengthen them. A drive that lies about its write cache will lie to `process-wal` too.

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

## What is tested

Real-filesystem tests are the executable specification, not mocks. The suite exercises torn writes, corrupt checkpoints, deferred compaction on Windows, `SIGKILL` recovery in a spawned child process, and bounded RSS for both cursors and compaction, on Node 22 and 24 across Linux, macOS, and Windows.
