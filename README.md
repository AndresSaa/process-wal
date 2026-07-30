# ![process-wal](https://raw.githubusercontent.com/AndresSaa/process-wal/main/.github/assets/readme-banner.webp)

[![CI](https://github.com/AndresSaa/process-wal/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/AndresSaa/process-wal/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/process-wal?logo=npm&color=cb3837)](https://www.npmjs.com/package/process-wal)
[![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-339933?logo=nodedotjs&logoColor=white)](https://github.com/AndresSaa/process-wal/blob/main/package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-pure-3178C6?logo=typescript&logoColor=white)](https://github.com/AndresSaa/process-wal/tree/main/src)
[![Runtime dependencies](https://img.shields.io/badge/runtime_dependencies-0-2ea44f)](https://github.com/AndresSaa/process-wal/blob/main/package.json)
[![Modules](https://img.shields.io/badge/modules-ESM%20%2B%20CJS-7c3aed)](https://github.com/AndresSaa/process-wal/blob/main/package.json)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/AndresSaa/process-wal/blob/main/LICENSE)

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
- [Durability model](#durability-model)
- [At-least-once, not exactly-once](#at-least-once-not-exactly-once)
- [How it compares](#how-it-compares)
- [When it fits](#when-it-fits)
- [When not to use it](#when-not-to-use-it)
- [API](#api)
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

`append`, `checkpoint`, `compact`, and `close` are synchronous by design. A successful `append` means the complete record reached the selected durability boundary before its sequence number was returned.

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

Reach for `node:sqlite` or `better-sqlite3` when you need queries, indexes, multiple tables, or transactions across your own data. Reach for `process-wal` when the only thing you want is "do not lose work I already said yes to," and you would rather adopt six methods than own a schema.

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

## API

```ts
const wal = createWal<T>({
  dir: "./data",
  fsync: false,
  compactInterval: null,
  maxEntryBytes: 1_048_576,
});
```

| Method                 | Contract                                                                                |
| ---------------------- | --------------------------------------------------------------------------------------- |
| `append(value)`        | JSON-serializes and persists a value, then returns its monotonic sequence number        |
| `checkpoint(seq)`      | Marks every entry through `seq` processed; lower or equal checkpoints are no-ops        |
| `replay()`             | Materializes entries after the current checkpoint in append order                       |
| `cursor({ fromSeq? })` | Streams an exclusive-`fromSeq`, checkpoint-and-file-size snapshot                       |
| `compact()`            | Atomically removes checkpointed records; defers while any cursor owns a file descriptor |
| `close()`              | Clears the unref'ed compaction timer, optionally flushes, and releases the writer       |

A checkpoint beyond the last append is valid and advances the next sequence number. This prevents a future append from being hidden below the checkpoint.

Every method throws an error with `code: "ERR_WAL_CLOSED"` after `close()`. `append` can throw `ERR_ENTRY_TOO_LARGE` or `ERR_ENTRY_NOT_SERIALIZABLE`. Stable codes, rather than exported error classes, are the public error contract.

> [!IMPORTANT]
> Two lifecycle details worth knowing before they surprise you:
>
> - **`close()` is not idempotent.** A second call throws `ERR_WAL_CLOSED`. Guard it if your shutdown path can run twice.
> - **A cursor owns its descriptor until it finishes.** Draining it, `break`ing out of a `for await`, or calling `return()` all release it. Abandoning one keeps the descriptor open for the life of the process, which locks the file on Windows and defers `compact()` indefinitely.

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

## Further reading

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

CI runs lint, coverage, package validation, and the durability suite on Node 22 and 24 across Linux, macOS, and Windows. A release is a merged version bump followed by a `vX.Y.Z` tag, which publishes to npm over OIDC.

`process-wal` is stable at `1.x`, so the API and the durability contract above are a commitment: breaking either is a major version, not a patch.

## License

MIT
