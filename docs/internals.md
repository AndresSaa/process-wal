# Internals

## Design decisions

Every row is a requirement, the decision it forced, and the cost that decision imposes. None of the consequences are accidents.

| Requirement                            | Decision                                             | Consequence                                                         |
| -------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------- |
| Recover accepted work after a restart  | Append before returning a sequence number            | The append path is synchronous                                      |
| Keep the common path inexpensive       | Page cache is the default durability boundary        | Host-loss durability is opt-in                                      |
| Support stronger local durability      | `fsync` is explicit and applies to every state write | Latency depends heavily on the filesystem and device                |
| Stay zero-dependency and portable      | JSONL plus Node filesystem primitives                | Values must be JSON-serializable; there is no query layer           |
| Bound replay memory for large backlogs | Frozen async cursor with its own descriptor          | Compaction waits for open cursors, which is also correct on Windows |
| Prefer recovery over hidden loss       | Corrupt checkpoints fall back to zero                | Recovery may repeat extra work but never skips it                   |
| Keep compaction usable on large logs   | Compaction streams survivors instead of loading them | Bounds file growth on the logs that most need it                    |

## Operational profile

| Operation  | Time                    | Memory                                | Disk behavior                                   |
| ---------- | ----------------------- | ------------------------------------- | ----------------------------------------------- |
| Open       | O(log bytes) validation | One entry plus a 64 KiB scan buffer   | Heals an incomplete final record                |
| Append     | O(entry bytes)          | One encoded record                    | Append; optional `fsync`                        |
| AppendMany | O(batch bytes)          | The whole encoded batch               | One append; one optional `fsync`                |
| Checkpoint | O(1)                    | Constant                              | Temp file, flush when enabled, then rename      |
| Replay     | O(log bytes)            | Materializes the log before filtering | Read only                                       |
| Cursor     | O(snapshot bytes)       | Stream buffer plus current entry      | Own read descriptor; frozen end offset          |
| Compact    | O(log bytes)            | One entry plus a 64 KiB scan buffer   | Temporary replacement; briefly needs extra disk |
| Stats      | O(1)                    | Constant                              | None — reads counters, never the filesystem     |

`appendMany()` is the one operation whose memory scales with its argument: the
batch is encoded in full before anything is written, so the encoded bytes are
held at once. That is what buys the single flush, and it is bounded by the
caller's batch size rather than by the log.

`stats()` is the only operation that touches no descriptor at all. Its counters
are set by the open-time scan and maintained by append, checkpoint and
compaction, which is what makes it safe to call on a metrics scrape. The one
counter that is not free is `reclaimableBytes`: it needs the byte length of each
pending record, because two logs with identical sequence numbers and total size
can differ more than tenfold in what compaction would release.

`replay()` is the only operation that materializes the log, which is why `cursor()` exists for backlogs that will not fit in memory comfortably. Open, compaction, and cursors all stream.

Manual compaction makes disk-growth policy explicit and is the simplest default. The optional `compactInterval` timer is available when a policy is genuinely time-based.

## Source layout

The source is split by responsibility:

- `src/wal.ts` — lifecycle, sequencing, and public orchestration.
- `src/record.ts` — the on-disk record format: encode and decode one entry.
- `src/scan.ts` — bounded-memory reads of the log, including the open-time pass that validates and measures it in one go.
- `src/storage.ts` — durability primitives: heal-on-open, atomic replacement, compaction, directory flush.
- `src/accounting.ts` — the byte and entry counters behind `stats()`.
- `src/validate.ts` — option resolution, sequence checks, and the coded errors.
- `src/cursor.ts` — frozen streaming snapshots and descriptor release.
- `src/noop.ts` — the lifecycle without storage.
- `src/types.ts` — the complete public contract.

`types.ts` holds the public contract and nothing else: every type in it is
re-exported by `index.ts`, and every type `index.ts` exports is in it. Types
that only describe how two modules talk to each other — `WalAccounting`,
`Accounting`, `FrozenCursorOptions` — stay with the module that owns them, so
`types.ts` keeps answering "what does a consumer get?" without cross-referencing.

No module owns two jobs. `wal.ts` decides _when_ things happen; the others know
_how_. That boundary is why `wal.ts` can be read start to finish without
following a call into the filesystem.

Comments explain only the non-obvious guarantees.

## The write-acknowledge-checkpoint cycle

The diagram in the README is generated, not drawn. Its source is
`.github/diagrams/readme-flow.mmd`, themed by
`.github/diagrams/mermaid-theme.json`, and the image is rebuilt with:

```sh
npm run docs:diagram
```

Edit the `.mmd`, re-run that, and commit both the source and the regenerated
`.github/assets/readme-flow.webp`. The source is deliberately kept in one place:
a second copy pasted into this page would drift from the image the moment either
one changed.

## Origin

An email marketing project was losing tracking events that had already been acknowledged to the webhook delivering them. A restart between the acknowledgement and the write was enough to drop one, and the sender had no reason to retry something it had been told arrived. This package is that gap closed, and nothing else.

Application-specific batching, retry, backpressure, and transport concerns remain outside the package, and should.

## Debugging

```sh
NODE_DEBUG=process-wal node your-app.js
```

Traces heal-on-open, deferred compaction, and checkpoint fallback.
