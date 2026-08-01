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

## Documentation

- [**API**](https://github.com/AndresSaa/process-wal/blob/main/docs/api.md) — every method, option and error code
- [Examples](https://github.com/AndresSaa/process-wal/blob/main/docs/examples.md) — each method in the situation it exists for, and a complete service
- [Durability](https://github.com/AndresSaa/process-wal/blob/main/docs/durability.md) — what survives what, recovery on open, and the repair procedure
- [Benchmarks](https://github.com/AndresSaa/process-wal/blob/main/docs/benchmarks.md) — measured on NTFS and ext4, with the methodology
- [Alternatives](https://github.com/AndresSaa/process-wal/blob/main/docs/alternatives.md) — when SQLite, an outbox or a broker is the better boundary
- [Internals](https://github.com/AndresSaa/process-wal/blob/main/docs/internals.md) — design decisions, cost profile, source layout

## Install

Requires Node.js 22 or newer.

```sh
npm install process-wal
```

Published with [provenance](https://docs.npmjs.com/generating-provenance-statements) over OIDC, so the npm artifact is cryptographically linked to the commit and workflow that built it. No publish token exists in this repository.

## How it works

![Sequence diagram: work is appended and only then acknowledged; the side effect runs, and only then is the sequence checkpointed. Anything not checkpointed replays after a restart.](https://raw.githubusercontent.com/AndresSaa/process-wal/main/.github/assets/readme-flow.webp)

`append`, `appendMany`, `checkpoint`, `compact`, and `close` are synchronous by design. A successful `append` means the complete record reached the selected durability boundary before its sequence number was returned.

## Durability model

A normal synchronous write reaches the kernel page cache. The cache outlives a process crash, a deploy, a container restart, or `SIGKILL` while the host stays up. It does not guarantee survival if the host loses power.

| Mode                     | Process restart | Host or power loss                         | Measured mean append |
| ------------------------ | --------------- | ------------------------------------------ | -------------------: |
| `fsync: false` (default) | Recoverable     | Not guaranteed                             |     0.0027–0.0067 ms |
| `fsync: true`            | Recoverable     | Requests an OS storage flush before return |         0.47–1.49 ms |

> The page cache is a receptionist; storage is a fireproof safe. Handing over a note is fast and survives you leaving the building. Waiting for the safe costs more, but is the appropriate boundary if the building itself may fail.

Each range spans NTFS and ext4 on one machine and one device: the `fsync: true` cost triples between them, which is the point — that number is a property of your filesystem, not of this library. Methodology, percentiles and the full recovery contract are in [benchmarks](https://github.com/AndresSaa/process-wal/blob/main/docs/benchmarks.md) and [durability](https://github.com/AndresSaa/process-wal/blob/main/docs/durability.md).

## At-least-once, not exactly-once

Append before acknowledging incoming work, then checkpoint only after its side effect succeeds. A crash between the two replays work that may already have happened, so consumers must be idempotent — deduplicate on an identity from your payload, never on the sequence number. Exactly-once delivery needs transactional coordination with the downstream system and is deliberately outside this library.

## How it compares

|                                  | Survives process restart | Survives host power loss | Dependencies      | What you still have to build                                                       |
| -------------------------------- | :----------------------: | :----------------------: | ----------------- | ---------------------------------------------------------------------------------- |
| **`process-wal`**                |            ✅            |    opt-in via `fsync`    | none              | nothing — append/replay/checkpoint _is_ the API                                    |
| `node:sqlite`                    |            ✅            |    opt-in via pragma     | none (in-runtime) | schema, insert/delete cycle, checkpoint semantics, compaction, torn-write recovery |
| `better-sqlite3`                 |            ✅            |    opt-in via pragma     | native binding    | the same, plus a build toolchain and prebuild matrix                               |
| `lowdb`, `steno`, `node-persist` | ⚠️ last full write only  |            ❌            | 1–3               | append semantics, replay, checkpointing — these rewrite whole documents            |
| BullMQ, RabbitMQ, Kafka          |            ✅            |            ✅            | a running service | operating that service                                                             |

## When it fits

Anywhere a single process accepts work it must not lose across its own restart, on storage that outlives that restart: a webhook receiver surviving deploys, an ingestion buffer flushing downstream, a desktop app holding drafts and pending uploads, a resumable CLI or ETL, an edge agent buffering telemetry through a flaky uplink.

## When not to use it

- Serverless or otherwise ephemeral filesystems.
- Multiple processes writing to the same WAL directory.
- Replicated or distributed durability.
- Work that requires transactions, queries, priorities, leases, or routing.
- A system that already owns the relevant data in a transactional database — use an outbox in that database instead.

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
