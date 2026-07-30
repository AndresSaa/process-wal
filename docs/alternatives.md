# Alternatives

`process-wal` occupies a narrow gap: one process, one local writer, one append-and-replay responsibility, and no new runtime or service dependency. Outside that gap, something else is better. This page makes the case for each one honestly.

## `node:sqlite`

**Choose it when:** you need queries, indexes, more than one kind of record, or transactions across your own application state.

SQLite has shipped inside the Node runtime without a flag since v22.13 and v23.4, and is now a release candidate. It has no install step, no native binding to build, and a storage engine with decades more scrutiny than this package will ever have.

What it does not give you is the WAL _pattern_. A durable append-and-replay-from-checkpoint cycle on top of `node:sqlite` means designing: a table with monotonic sequencing, a durable checkpoint marker updated in the same transaction as nothing else, a delete-and-`VACUUM` policy so the file does not grow forever, a `synchronous` pragma decision, and an answer for what happens when the process dies mid-transaction.

That is a real afternoon, and most of the bugs in this space live in the recovery path rather than the happy path. If you are going to write that code anyway because you also need queries, write it on SQLite. If append-and-replay is genuinely all you want, six methods is a smaller commitment than a schema.

## `better-sqlite3`

**Choose it when:** you need SQLite and you are on a Node version or workload where the in-runtime module is not enough — mature API surface, extensions, or performance characteristics you have already measured.

The tradeoff is a native binding: a prebuild matrix, a compiler fallback, and friction in Electron packaging, Alpine images, and Lambda layers. That friction is the single most common reason people arrive at `process-wal`.

## Transactional outbox

**Choose it when:** your business state already lives in a transactional database and the state change and the emitted work must commit together.

If you write a row and enqueue a job, and those two things can diverge, no local WAL fixes it — you need both in one transaction. The [outbox pattern](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html) is the correct boundary, and `process-wal` is the wrong tool. This is listed in the README's "when not to use it" for a reason.

## `lowdb`, `steno`, `node-persist`, `write-file-atomic`

**Choose them when:** you want a small document persisted atomically — settings, a cache, a state blob.

They solve a different problem. These rewrite a whole document; `process-wal` appends records and replays the ones you have not finished. There is no checkpoint, no replay-from-position, and no bounded-memory iteration in that family. Projects often start there and discover they have been reimplementing half of a WAL badly.

## BullMQ, RabbitMQ, Kafka

**Choose them when:** work crosses process or machine boundaries, or you need retries, priorities, delays, routing, fan-out, or replication.

[BullMQ](https://docs.bullmq.io/) needs Redis. [RabbitMQ](https://www.rabbitmq.com/docs/queues) and [Kafka](https://kafka.apache.org/documentation/) need a broker to operate. All three are the right answer at a certain scale, and all three are a service to run, monitor, secure, and pay for. If the honest requirement is "do not lose work across a `docker restart` on a box with a persistent volume," that is a lot of infrastructure for one guarantee.

## Doing nothing

**Choose it when:** the work is genuinely reproducible from upstream, or the producer retries on your behalf, or losing it is acceptable.

This is a real option and it is often correct. `process-wal` is worth adding only if you currently acknowledge work before it is recoverable — that is the specific failure it exists to prevent.
