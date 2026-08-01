# ![process-wal](https://raw.githubusercontent.com/AndresSaa/process-wal/main/.github/assets/readme-banner.webp)

[![CI](https://github.com/AndresSaa/process-wal/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/AndresSaa/process-wal/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/process-wal?logo=npm&color=cb3837)](https://www.npmjs.com/package/process-wal)
[![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-339933?logo=nodedotjs&logoColor=white)](https://github.com/AndresSaa/process-wal/blob/main/package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-pure-3178C6?logo=typescript&logoColor=white)](https://github.com/AndresSaa/process-wal/tree/main/src)
[![Runtime dependencies](https://img.shields.io/badge/runtime_dependencies-0-2ea44f)](https://github.com/AndresSaa/process-wal/blob/main/package.json)
[![Modules](https://img.shields.io/badge/modules-ESM%20%2B%20CJS-7c3aed)](https://github.com/AndresSaa/process-wal/blob/main/package.json)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/AndresSaa/process-wal/blob/main/LICENSE)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/AndresSaa/process-wal/badge)](https://scorecard.dev/viewer/?uri=github.com/AndresSaa/process-wal)

**Durability across Node.js process restarts — without SQLite, Redis, a broker, or native binaries.** Pure TypeScript, zero runtime dependencies, one clear job: append accepted work before you acknowledge it, replay whatever was not checkpointed, compact when convenient.

```ts
import { createWal } from "process-wal";

const wal = createWal<{ jobId: string }>({ dir: "./data" });

const seq = wal.append({ jobId: "job-42" }); // persisted before this returns
acknowledgeJob(seq); // now it is safe to say "got it"

for (const entry of wal.replay()) {
  // on startup, redo what was not done
  await processJob(entry.value);
  wal.checkpoint(entry.seq);
}
```

```sh
docker restart my-service   # the process dies; its persistent disk survives
```

If a service acknowledges work before that work is recoverable, a restart can silently drop it. `process-wal` closes exactly that gap, and nothing else. It is intentionally local, synchronous, and single-writer. That smallness is the design boundary, not an incomplete queue.

<details>
<summary><b>Table of contents</b></summary>

- [Install](#install)
- [How it works](#how-it-works)
- [API](#api)
- [Examples](#examples)
- [Durability model](#durability-model)
- [At-least-once, not exactly-once](#at-least-once-not-exactly-once)
- [How it compares](#how-it-compares)
- [When it fits](#when-it-fits)
- [When not to use it](#when-not-to-use-it)
- [Further reading](#further-reading)

</details>

## Install

Requires Node.js 22 or newer.

```sh
npm install process-wal
```

Published with [provenance](https://docs.npmjs.com/generating-provenance-statements) over OIDC, so the npm artifact is cryptographically linked to the commit and workflow that built it. No publish token exists in this repository.

## How it works

![Sequence diagram: a producer sends work to a service, which appends it to process-wal and only acknowledges the producer once the append returns a sequence number; the side effect runs downstream, and only after it succeeds does the service checkpoint that sequence. Anything not checkpointed replays after a restart.](https://raw.githubusercontent.com/AndresSaa/process-wal/main/.github/assets/readme-flow.webp)

`append`, `appendMany`, `checkpoint`, `compact`, and `close` are synchronous by design. A successful `append` means the complete record reached the selected durability boundary before its sequence number was returned.

## API

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

### Batching

`fsync: true` costs a flush per `append`. `appendMany` pays it once for the
whole batch, which is the difference between roughly 2,000 and 185,000 records
per second on the machine in [docs/benchmarks.md](https://github.com/AndresSaa/process-wal/blob/main/docs/benchmarks.md):

```ts
const seqs = wal.appendMany(batch); // one write, one flush
```

If the call returns, every record in the batch is durable. It is **not**
transactional: a crash _during_ the call can leave a prefix of the batch on
disk, which replays like any other unacknowledged work. What it does guarantee
is that a value the batch cannot serialise fails the call before anything is
written — the whole batch is encoded first, so you never get half of one.

### Policy and metrics

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

### Disposal

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

### Large backlogs

`replay()` is convenient for bounded queues and is the only operation that materializes the log. `cursor()` keeps iteration memory bounded and freezes its checkpoint and byte length when created:

```ts
for await (const { seq, value } of wal.cursor({ fromSeq: 0 })) {
  await processJob(value);
  wal.checkpoint(seq);
}
```

### Optional persistence

`createNoopWal<T>()` exposes the same lifecycle and sequence shape without disk I/O — a dependency-injection seam for applications where persistence is configurable:

```ts
const wal = persistenceEnabled ? createWal(options) : createNoopWal();
```

## Examples

Worked scenarios for every method — what each one is for, what it rejects, and the mistakes that cost you data — are in **[docs/examples.md](https://github.com/AndresSaa/process-wal/blob/main/docs/examples.md)**: batching checkpoints, resuming a cursor with `fromSeq`, releasing a cursor with `await using`, disposing the WAL from a scope, swapping in `createNoopWal` for tests, and a complete webhook receiver that survives a deploy mid-request.

## Durability model

A normal synchronous write reaches the kernel page cache. The cache outlives a process crash, a deploy, a container restart, or `SIGKILL` while the host stays up. It does not guarantee survival if the host loses power.

| Mode                     | Process restart | Host or power loss                         | Measured mean append |
| ------------------------ | --------------- | ------------------------------------------ | -------------------: |
| `fsync: false` (default) | Recoverable     | Not guaranteed                             |     0.0027–0.0067 ms |
| `fsync: true`            | Recoverable     | Requests an OS storage flush before return |         0.47–1.49 ms |

> The page cache is a receptionist; storage is a fireproof safe. Handing over a note is fast and survives you leaving the building. Waiting for the safe costs more, but is the appropriate boundary if the building itself may fail.

Each range spans NTFS and ext4 on one machine and one NVMe device. The `fsync: true` cost triples between them, which is the point: that number is a property of your filesystem, not of this library. With `fsync: true` the flush path covers appends, checkpoint replacement, and compaction. Filesystem, storage-controller, and hardware guarantees still apply; no userspace library can strengthen them. Methodology and full percentiles are in [docs/benchmarks.md](https://github.com/AndresSaa/process-wal/blob/main/docs/benchmarks.md).

## At-least-once, not exactly-once

Append before acknowledging incoming work, then checkpoint only after its side effect succeeds. A crash between the side effect and the checkpoint replays work that may already have happened, so consumers must be idempotent.

```ts
for (const { seq, value } of wal.replay()) {
  // Use an identity from the payload, not the WAL seq, as the deduplication key.
  await db.upsert("payments", { id: value.paymentId }, value);
  wal.checkpoint(seq);
}
```

Exactly-once delivery requires transactional coordination with the downstream system and is deliberately outside this library.

## How it compares

|                                  | Survives process restart | Survives host power loss | Dependencies      | What you still have to build                                                       |
| -------------------------------- | :----------------------: | :----------------------: | ----------------- | ---------------------------------------------------------------------------------- |
| **`process-wal`**                |            ✅            |    opt-in via `fsync`    | none              | nothing — append/replay/checkpoint _is_ the API                                    |
| `node:sqlite`                    |            ✅            |    opt-in via pragma     | none (in-runtime) | schema, insert/delete cycle, checkpoint semantics, compaction, torn-write recovery |
| `better-sqlite3`                 |            ✅            |    opt-in via pragma     | native binding    | the same, plus a build toolchain and prebuild matrix                               |
| `lowdb`, `steno`, `node-persist` | ⚠️ last full write only  |            ❌            | 1–3               | append semantics, replay, checkpointing — these rewrite whole documents            |
| BullMQ, RabbitMQ, Kafka          |            ✅            |            ✅            | a running service | operating that service                                                             |

### "Why not just use `node:sqlite`?"

Fair question, and often the right answer. `node:sqlite` has shipped in the runtime without a flag since Node 22.13 and 23.4, and is now a release candidate, so "no native binaries" is no longer a reason on its own.

The difference is not the storage engine, it is the amount of design left over. SQLite gives you a database; a write-ahead log with replay-from-checkpoint semantics is something you then design on top of it: a table, monotonic sequencing, a durable checkpoint marker, a deletion-and-vacuum policy, and a decision about what to do when the process died mid-write. That is a real afternoon of work and a set of subtle choices — most of the bugs in this space are in the recovery path, not the happy path.

Reach for `node:sqlite` or `better-sqlite3` when you need queries, indexes, multiple tables, or transactions across your own data. Reach for `process-wal` when the only thing you want is "do not lose work I already said yes to," and you would rather adopt eight methods than own a schema.

Further alternatives, with the case for each, are in [docs/alternatives.md](https://github.com/AndresSaa/process-wal/blob/main/docs/alternatives.md).

## When it fits

| Scenario                               | Why this WAL fits                                                      |
| -------------------------------------- | ---------------------------------------------------------------------- |
| Small webhook receiver                 | Survive deploys without adding a queue service                         |
| Ingestion buffer on persistent storage | Absorb local work and flush it downstream after restart                |
| Electron or desktop application        | Persist drafts, uploads, or pending operations without native bindings |
| Resumable CLI, scraper, migration, ETL | Continue from a checkpoint; stream a large backlog with `cursor()`     |
| Edge or IoT agent                      | Buffer telemetry through intermittent downstream connectivity          |

## When not to use it

- Serverless or otherwise ephemeral filesystems.
- Multiple processes writing to the same WAL directory.
- Replicated or distributed durability.
- Work that requires transactions, queries, priorities, leases, or routing.
- A system that already owns the relevant data in a transactional database — use an outbox in that database instead.

## Further reading

- **[docs/examples.md](https://github.com/AndresSaa/process-wal/blob/main/docs/examples.md)** — every method in the situation it exists for, plus a complete worked service.
- **[docs/durability.md](https://github.com/AndresSaa/process-wal/blob/main/docs/durability.md)** — the full recovery contract: torn records, corrupt checkpoints, atomic replacement, and the manual repair procedure when the log refuses to open.
- **[docs/internals.md](https://github.com/AndresSaa/process-wal/blob/main/docs/internals.md)** — design-decision table, per-operation cost and memory profile, source layout, and debugging with `NODE_DEBUG=process-wal`.
- **[docs/benchmarks.md](https://github.com/AndresSaa/process-wal/blob/main/docs/benchmarks.md)** — methodology and results for both durability modes.
- **[docs/alternatives.md](https://github.com/AndresSaa/process-wal/blob/main/docs/alternatives.md)** — when SQLite, an outbox, or a broker is the better boundary.
- **[CHANGELOG.md](https://github.com/AndresSaa/process-wal/blob/main/CHANGELOG.md)** — hand-written release notes.

## Development

```sh
npm ci
npm run lint
npm test
npm run coverage
npm run bench
npm run lint:package
```

CI runs lint, coverage, package validation, and the durability suite on Node 22 and 24 across Linux, macOS, and Windows, plus one leg on the current Node release. Package validation installs the packed tarball and imports it, rather than only inspecting it. A release is a merged version bump followed by a `vX.Y.Z` tag, which publishes to npm over OIDC.

`process-wal` is stable at `1.x`, so the API and the durability contract above are a commitment: breaking either is a major version, not a patch.

## License

MIT
