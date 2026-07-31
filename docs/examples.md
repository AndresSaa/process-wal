# Examples

Every method, in the situation it exists for. If you only read one section, read
the first — the rest are variations on it.

- [The core loop](#the-core-loop)
- [`createWal` options](#createwal-options)
- [`append`](#append)
- [`checkpoint`](#checkpoint)
- [`replay`](#replay)
- [`cursor`](#cursor)
- [`compact`](#compact)
- [`close`](#close)
- [`createNoopWal`](#createnoopwal)
- [Errors](#errors)
- [A complete service](#a-complete-service)

## The core loop

Three rules produce the guarantee. Append before you acknowledge, do the side
effect, checkpoint after it succeeds.

```ts
import { createWal } from "process-wal";

type Job = { jobId: string; payload: string };

const wal = createWal<Job>({ dir: "./data" });

// 1. Recover first. Anything appended but never checkpointed is unfinished
//    work from a previous life of this process.
for (const { seq, value } of wal.replay()) {
  await handle(value);
  wal.checkpoint(seq);
}

// 2. Only now start accepting new work.
function accept(job: Job): number {
  const seq = wal.append(job); // on disk before this returns
  return seq; // safe to tell the producer "got it"
}

// 3. Checkpoint after the side effect, never before.
async function process(seq: number, job: Job): Promise<void> {
  await handle(job);
  wal.checkpoint(seq);
}
```

The order is the whole design. Acknowledging before the append means a restart
loses work you promised to do. Checkpointing before the side effect means a
restart skips work you promised to do.

## `createWal` options

```ts
const wal = createWal<Job>({
  dir: "./data", // default "./data"
  fsync: false, // default false
  compactInterval: null, // default null (no timer)
  maxEntryBytes: 1024 * 1024, // default 1 MiB
});
```

`dir` is created if missing and holds `wal.jsonl` and `wal.checkpoint`. The
library does not touch other files there.

`fsync: true` asks the OS to flush to storage before every mutation returns —
appends, checkpoints, compaction, and close. It is the difference between
surviving a process crash and surviving a power cut, and it costs roughly two
orders of magnitude in append latency. See
[durability.md](durability.md).

`compactInterval` runs `compact()` on a timer, in milliseconds. The timer is
`unref()`'d, so it never keeps a process alive.

```ts
const wal = createWal<Job>({ compactInterval: 60_000 });

// Nothing awaits that timer, so a failure inside it surfaces as a warning
// rather than an unhandled rejection. Listen if you care.
process.on("warning", (warning) => {
  if (warning.name === "ProcessWalWarning") logger.error(warning);
});
```

Invalid options throw `RangeError` immediately, at construction:

```ts
createWal({ dir: "" }); // RangeError
createWal({ maxEntryBytes: 0 }); // RangeError
createWal({ compactInterval: -1 }); // RangeError — use null to disable
```

## `append`

Serializes the value, writes the complete record, and only then returns its
sequence number.

```ts
const seq = wal.append({ jobId: "job-42", payload: "…" });
// seq === 1 on a fresh log
```

Sequence numbers are monotonic within an instance, but **not a gap-free
identity**. An append interrupted by a crash never returned its number, so that
number can be issued again after restart. Deduplicate on something from your own
payload:

```ts
// Wrong — seq is not stable across a crash.
await db.insert({ id: seq, ...value });

// Right — the identity comes from the work itself.
await db.upsert("payments", { id: value.paymentId }, value);
```

What it rejects:

```ts
wal.append(undefined); // ERR_ENTRY_NOT_SERIALIZABLE
wal.append(() => {}); // ERR_ENTRY_NOT_SERIALIZABLE
wal.append({ n: 1n }); // ERR_ENTRY_NOT_SERIALIZABLE — BigInt
const cyclic: Record<string, unknown> = {};
cyclic.self = cyclic;
wal.append(cyclic); // ERR_ENTRY_NOT_SERIALIZABLE

wal.append({ blob: "x".repeat(2 ** 21) }); // ERR_ENTRY_TOO_LARGE
```

Values round-trip through `JSON.parse`, so what comes back out of `replay()` is
JSON, not your class. `Date` becomes a string; `undefined` properties disappear;
`Map` and `Set` become `{}`. Serialize deliberately if it matters:

```ts
wal.append({ jobId: "job-42", queuedAt: new Date().toISOString() });
```

## `checkpoint`

Marks everything through `seq` as processed. It is a high-water mark, not a
delete.

```ts
wal.checkpoint(10); // entries 1..10 will not replay
wal.checkpoint(4); // no-op — checkpoints never move backwards
wal.checkpoint(10); // no-op — same position
```

You do not have to checkpoint every entry. Batching is the normal case for
throughput, and it is safe as long as you only checkpoint what genuinely
finished:

```ts
const batch = wal.replay().slice(0, 500);

await db.insertMany(batch.map((entry) => entry.value));

// One checkpoint for the whole batch — the last seq that really landed.
wal.checkpoint(batch[batch.length - 1].seq);
```

A checkpoint beyond the last append is valid and moves the next sequence number
up with it, so a future append can never be hidden underneath it.

## `replay`

Returns everything newer than the checkpoint, in append order, as an array.

```ts
const pending = wal.replay();
console.log(`${pending.length} entries to redo`);

for (const { seq, value } of pending) {
  await handle(value);
  wal.checkpoint(seq);
}
```

`replay()` is the only operation that materializes the log in memory. That is
fine for bounded queues and wrong for a backlog that has been growing unattended
— use `cursor()` there.

## `cursor`

Streams instead of materializing, and freezes its view when created: it takes
its own file descriptor and its own end offset, so appends that happen while you
iterate are not included.

```ts
for await (const { seq, value } of wal.cursor()) {
  await handle(value);
  wal.checkpoint(seq);
}
```

`fromSeq` is exclusive, which makes resuming natural:

```ts
let last = 0;

for await (const { seq, value } of wal.cursor({ fromSeq: last })) {
  await handle(value);
  last = seq;
}
```

**A cursor owns a file descriptor until it finishes.** Draining it, `break`ing
out, or calling `return()` all release it. Abandoning one without any of those
leaks the descriptor for the life of the process, keeps the file locked on
Windows, and defers `compact()` forever.

```ts
// Fine — break releases the descriptor.
for await (const entry of wal.cursor()) {
  if (entry.value.jobId === target) break;
}

// Fine — explicit release when you are not using for-await.
const cursor = wal.cursor();
try {
  const first = await cursor.next();
  // …
} finally {
  await cursor.return?.();
}
```

## `compact`

Rewrites the log without the records already checkpointed, atomically.

```ts
wal.checkpoint(lastProcessed);
wal.compact(); // checkpointed records are gone; the rest is untouched
```

Compaction streams, so it works on logs too large to load. It writes a temporary
file and `rename`s it over the live one, so a crash mid-compaction leaves either
the old log or the new one — never half of either.

It is deferred, not failed, while any cursor is open:

```ts
const cursor = wal.cursor();
await cursor.next();

wal.compact(); // returns without doing anything — a cursor is reading

await cursor.return?.();
wal.compact(); // now it runs
```

Set `NODE_DEBUG=process-wal` to see when a compaction was deferred.

## `close`

Flushes when `fsync` is enabled, clears the compaction timer, and releases the
descriptor.

```ts
wal.close();
```

**`close()` is not idempotent.** A second call throws `ERR_WAL_CLOSED`, as does
every other method. If your shutdown path can run twice — a signal handler plus
a `finally`, say — guard it:

```ts
let closed = false;

function shutdown(): void {
  if (closed) return;
  closed = true;
  wal.close();
}

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
```

`close()` releases the writer. It does not release cursors other code is holding.

## `createNoopWal`

Same shape, same sequence numbers, no disk. It is a dependency-injection seam
for code where persistence is a deployment decision, and it keeps tests from
touching the filesystem.

```ts
import { createNoopWal, createWal, type Wal } from "process-wal";

function makeWal(): Wal<Job> {
  return process.env.WAL_DIR
    ? createWal<Job>({ dir: process.env.WAL_DIR })
    : createNoopWal<Job>();
}
```

It still hands out increasing sequence numbers and still throws
`ERR_WAL_CLOSED` after `close()`, so code written against it behaves the same.
What it does not do is survive a restart — `replay()` is always empty.

## Errors

Every error carries a stable `code`. The codes are the contract; the classes are
not exported, so match on `code` rather than `instanceof`.

| `code`                       | Thrown by                     | Meaning                                      |
| ---------------------------- | ----------------------------- | -------------------------------------------- |
| `ERR_WAL_CLOSED`             | every method, after `close()` | The instance is done. Make a new one.        |
| `ERR_ENTRY_NOT_SERIALIZABLE` | `append`                      | `JSON.stringify` cannot represent the value. |
| `ERR_ENTRY_TOO_LARGE`        | `append`                      | The record exceeds `maxEntryBytes`.          |
| —                            | `createWal`                   | `RangeError` for invalid options.            |
| —                            | `createWal`                   | `SyntaxError` for a corrupt log. See below.  |

```ts
function isWalError(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === code
  );
}

try {
  wal.append(value);
} catch (error) {
  if (isWalError(error, "ERR_ENTRY_TOO_LARGE")) {
    logger.warn("payload too large, storing a reference instead");
    wal.append({ ref: await blobStore.put(value) });
  } else {
    throw error;
  }
}
```

`createWal` throwing `SyntaxError` means the log holds a record that is
complete — newline-terminated — but unparseable. That is deliberate rather than
survivable: a torn final record is truncated silently because nobody was ever
promised it, but a _complete_ damaged record was fully written and then
corrupted, and skipping it would drop acknowledged work. The repair procedure is
in [durability.md](durability.md#repairing-a-log-that-refuses-to-open).

## A complete service

A webhook receiver that never loses an accepted delivery across a deploy.

```ts
import { createWal } from "process-wal";
import express from "express";

type Delivery = { deliveryId: string; body: unknown };

const wal = createWal<Delivery>({
  dir: process.env.WAL_DIR ?? "./data",
  // A webhook receiver on a cloud VM: the disk survives a restart, the
  // machine might not. Pay the flush.
  fsync: true,
  compactInterval: 5 * 60_000,
});

async function forward(delivery: Delivery): Promise<void> {
  // Must be idempotent: a crash between here and the checkpoint replays it.
  await fetch("https://internal.example/ingest", {
    method: "POST",
    headers: { "idempotency-key": delivery.deliveryId },
    body: JSON.stringify(delivery.body),
  });
}

// Finish the previous life's work before accepting anything new.
for await (const { seq, value } of wal.cursor()) {
  await forward(value);
  wal.checkpoint(seq);
}

const app = express();

app.post("/hook", express.json(), async (request, response) => {
  const delivery: Delivery = {
    deliveryId: request.header("x-delivery-id") ?? crypto.randomUUID(),
    body: request.body,
  };

  let seq: number;
  try {
    seq = wal.append(delivery);
  } catch {
    // Not durable, so do not claim it is. The sender will retry.
    return response.status(503).send();
  }

  // Durable. Acknowledge now and forward independently — the WAL is what
  // makes it safe to answer before the work is done.
  response.status(202).send();

  try {
    await forward(delivery);
    wal.checkpoint(seq);
  } catch {
    // Leave it un-checkpointed. It replays on the next start.
  }
});

const server = app.listen(3000);

let closed = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    if (closed) return;
    closed = true;
    server.close();
    wal.close();
  });
}
```

The failure this prevents: the process is killed between the 202 and the
forward. Without the log, that delivery is gone and the sender already saw
success. With it, the entry is on disk, un-checkpointed, and the next start
replays it.
