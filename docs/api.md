# API

The complete surface: two factories, eight methods, five options, and the error
codes. The [README](../README.md) carries the shape of the thing; this carries
the contract.

```ts
import { createWal, createNoopWal } from "process-wal";
```

```ts
const wal = createWal<T>({
  dir: "./data", // holds wal.jsonl and wal.checkpoint
  fsync: false, // page cache, or storage — see Durability model
  compactInterval: null, // ms; the timer is unref'ed. null disables it
  maxEntryBytes: 1_048_576, // per record on write, before ERR_ENTRY_TOO_LARGE
  maxReadEntryBytes: null, // null = read back whatever is on disk
});
```

Those are the defaults; every option can be omitted. Invalid values throw `RangeError` at construction.

`maxReadEntryBytes` is off by default on purpose. Enforcing `maxEntryBytes` on reads would mean lowering it made an existing log unreadable — a configuration change turned into data loss. Set it when the WAL directory is somewhere you would rather bound what you are willing to read back; a record on disk larger than it makes `createWal` throw `ERR_ENTRY_TOO_LARGE` instead of loading it.

| Method                 | Contract                                                                                |
| ---------------------- | --------------------------------------------------------------------------------------- |
| `append(value)`        | JSON-serializes and persists a value, then returns its monotonic sequence number        |
| `appendMany(values)`   | Persists a batch in one write and one flush, then returns their sequence numbers        |
| `checkpoint(seq)`      | Marks every entry through `seq` processed; lower or equal checkpoints are no-ops        |
| `replay()`             | Materializes entries after the current checkpoint in append order                       |
| `cursor({ fromSeq? })` | Streams an exclusive-`fromSeq`, checkpoint-and-file-size snapshot                       |
| `compact()`            | Atomically removes checkpointed records; defers while any cursor owns a file descriptor |
| `stats()`              | Returns the log's position and size from memory, without reading the filesystem         |
| `close()`              | Clears the unref'ed compaction timer, optionally flushes, and releases the writer       |

A checkpoint beyond the last append is valid and advances the next sequence number. This prevents a future append from being hidden below the checkpoint.

Every method except `close()` throws an error with `code: "ERR_WAL_CLOSED"` once the WAL is closed. `append` and `appendMany` can throw `ERR_ENTRY_TOO_LARGE` or `ERR_ENTRY_NOT_SERIALIZABLE`. Stable codes, rather than exported error classes, are the public error contract.

If a write to the log fails partway — a full disk, a failing flush — the instance stops accepting work and every method except `close()` throws `ERR_WAL_UNUSABLE`. It cannot tell whether the record reached the file, and guessing wrong would either weld the next record onto a partial line or reissue a sequence number that is already there, which makes the log refuse to open and takes the whole backlog with it. Close it and open a new one: recovery on open truncates the incomplete record and carries on.

## Batching

`fsync: true` costs a flush per `append`. `appendMany` pays it once for the
whole batch, which is the difference between roughly 2,000 and 185,000 records
per second on the machine in [docs/benchmarks.md](benchmarks.md):

```ts
const seqs = wal.appendMany(batch); // one write, one flush
```

If the call returns, every record in the batch is durable. It is **not**
transactional: a crash _during_ the call can leave a prefix of the batch on
disk, which replays like any other unacknowledged work. What it does guarantee
is that a value the batch cannot serialise fails the call before anything is
written — the whole batch is encoded first, so you never get half of one.

## Policy and metrics

`stats()` answers "how far behind am I, and is it worth compacting?" from
in-memory counters, so it is safe to call on a metrics scrape:

```ts
const { lastSeq, checkpoint, pendingEntries, bytes, reclaimableBytes } =
  wal.stats();

if (reclaimableBytes > 50_000_000) wal.compact();
```

`reclaimableBytes` is exactly what the next `compact()` would free, and
`pendingEntries` is exactly what `replay()` would return — both are tested
against the filesystem rather than asserted. Maintaining `reclaimableBytes`
costs one number per pending record, because two logs with the same sequence
numbers and total size can have wildly different reclaimable bytes depending on
which records happen to be large.

## Disposal

`close()` is idempotent. A `finally` and a `SIGTERM` handler both firing is correct shutdown code, so it does not need a guard:

```ts
process.once("SIGTERM", () => wal.close());
try {
  // …
} finally {
  wal.close(); // whichever runs second is a no-op
}
```

Both the WAL and its cursors implement the disposal protocol, so scope can own them instead:

```ts
using wal = createWal<Job>({ dir: "./data" });

for (const { seq, value } of wal.replay()) {
  await handle(value);
  wal.checkpoint(seq);
}
// wal.close() runs on the way out, including on a throw.
```

That matters most for cursors, because a cursor holds a file descriptor and a leaked one defers `compact()` for the life of the process and keeps the file locked on Windows. `await using` releases it on every exit path, early `return` included:

```ts
await using cursor = wal.cursor({ fromSeq: 0 });

for await (const { seq, value } of cursor) {
  if (await handle(value)) return; // descriptor still released
  wal.checkpoint(seq);
}
```

A plain `for await` over `wal.cursor()` already releases the descriptor when it completes, breaks, or throws — `await using` additionally covers manual iteration and early exits from the enclosing scope.

## Large backlogs

`replay()` is convenient for bounded queues and is the only operation that materializes the log. `cursor()` keeps iteration memory bounded and freezes its checkpoint and byte length when created:

```ts
for await (const { seq, value } of wal.cursor({ fromSeq: 0 })) {
  await processJob(value);
  wal.checkpoint(seq);
}
```

## Optional persistence

`createNoopWal<T>()` exposes the same lifecycle and sequence shape without disk I/O — a dependency-injection seam for applications where persistence is configurable:

```ts
const wal = persistenceEnabled ? createWal(options) : createNoopWal();
```

## Recovering after a failed write

If a write to the log fails partway — a full disk, a failing flush — the
instance stops accepting work and every method except `close()` throws
`ERR_WAL_UNUSABLE`. It cannot tell whether the record reached the file, and
either guess corrupts the log. Close it and open a new one: recovery on open
truncates the incomplete record and carries on. The reasoning is in
[durability.md](durability.md).
