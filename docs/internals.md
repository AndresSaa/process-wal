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
| Checkpoint | O(1)                    | Constant                              | Temp file, flush when enabled, then rename      |
| Replay     | O(log bytes)            | Materializes the log before filtering | Read only                                       |
| Cursor     | O(snapshot bytes)       | Stream buffer plus current entry      | Own read descriptor; frozen end offset          |
| Compact    | O(log bytes)            | One entry plus a 64 KiB scan buffer   | Temporary replacement; briefly needs extra disk |

`replay()` is the only operation that materializes the log, which is why `cursor()` exists for backlogs that will not fit in memory comfortably. Open, compaction, and cursors all stream.

Manual compaction makes disk-growth policy explicit and is the simplest default. The optional `compactInterval` timer is available when a policy is genuinely time-based.

## Source layout

The source is split by responsibility:

- `src/wal.ts` — lifecycle, sequencing, compaction, and public orchestration.
- `src/cursor.ts` — frozen streaming snapshots and descriptor release.
- `src/storage.ts` — bounded-memory validation, recovery, flushing, and atomic replacement primitives.
- `src/noop.ts` — the lifecycle without storage.
- `src/types.ts` — the complete public contract.

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

This is an extraction from a production ingestion writer, not a speculative abstraction. The original boundary was concrete: append before acknowledging an incoming measurement, batch downstream writes, then checkpoint only the last successfully persisted sequence.

Application-specific batching, retry, backpressure, and transport concerns remain outside the package, and should.

## Debugging

```sh
NODE_DEBUG=process-wal node your-app.js
```

Traces heal-on-open, deferred compaction, and checkpoint fallback.
