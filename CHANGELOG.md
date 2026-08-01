# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and releases follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.5.0] - 2026-08-01

### Added

- `maxReadEntryBytes` rejects a record already on disk that exceeds it, instead
  of reading it. Off by default, and deliberately not a mirror of
  `maxEntryBytes`: enforcing the write limit on reads would mean lowering it
  made an existing log unreadable, turning a configuration change into data
  loss. Set it where the WAL directory is somewhere you would rather bound what
  you are willing to read back. An oversized record then fails `createWal` with
  `ERR_ENTRY_TOO_LARGE` — the same code `append` already used for the same
  reason.

  The bound is applied while a record is being read rather than after, which is
  the only version of the check that bounds anything, and at open, which every
  other read is downstream of.

### Fixed

- The checkpoint file is no longer read whole. It holds a single integer, so a
  `wal.checkpoint` of any size was pulled into memory before being parsed and
  then discarded if it did not look like a number. A 200 MiB one cost 693 ms and
  200 MiB of heap to reach the same answer it now reaches in 2 ms and none:
  anything implausibly large is treated as the corruption it is and falls back
  to zero, exactly like an unparseable one.

### Security

- The publish job pins npm to an exact version instead of installing
  `npm@latest`. That job holds the OIDC credential that authorises publishing,
  and `latest` meant reaching for whatever had been released in the meantime.
- A release tag is now rejected unless its commit is an ancestor of `main`.
  Matching the version in `package.json` was never enough on its own: a tag can
  be pushed at any commit, including one that never went through review.
- Release notes are extracted and checked **before** `npm publish` rather than
  after. A missing changelog section used to fail once the version was already
  immutable on the registry — a release half done and impossible to undo.
- The release checkout no longer persists a credential it never uses.

### Documentation

- The documented command list matches the scripts that exist. `check:diagrams`,
  `docs:diagram` and `smoke:package` were missing from it, and `lint:package` is
  now described as what it became: validation that also loads the packed
  tarball rather than only inspecting it.
- Corrected counts and lists that had drifted behind the API: the package is
  described as eight methods rather than six, `appendMany` is named in the
  synchronous-methods sentence, and the error tables assign the serialisation
  and size errors to `appendMany` as well as `append`.
- `docs/durability.md` gains an "Operating it" section for the things the
  contract implied but never stated: that **single writer means one live
  instance per directory**, in one process, and is neither locked nor detected;
  that the log is plaintext under whatever permissions your umask gives; that
  compaction briefly needs room for a second copy; that there are **no
  checksums**, so altered bytes that stay valid JSON replay as though nothing
  happened; that backups mean copying the directory with the writer stopped; and
  that the on-disk format is part of the contract, so any 1.x can open a log
  written by any other.
- `maxEntryBytes` is described as what it is — a limit on writes. It does not
  cap what open, `replay()`, `cursor()` or compaction read back, and
  `SECURITY.md` now draws the memory boundary accordingly: growth out of
  proportion to a record's own size is in scope, a large record you stored
  yourself is not.

## [1.4.1] - 2026-08-01

### Fixed

- Options are validated by type, not by truthiness. `{ fsync: "false" }` was
  accepted and, being a non-empty string, turned flushing **on** — the opposite
  of what it reads like. It now throws `RangeError` at construction, which is
  what the README already promised. `dir` and `maxEntryBytes` are checked the
  same way.
- A record that parses as JSON but is not a record envelope now fails with
  `SyntaxError` like every other damaged record. `null` in particular reached
  the sequence check and threw `TypeError`, which no documentation mentions.
  Numbers, strings, arrays and booleans are covered too.
- A blank line in the log refuses to open instead of being skipped. An append
  never writes one, so it means the log was edited by something else — and
  skipping it left `stats().bytes` disagreeing with the file on disk.
- `createNoopWal()` refuses to issue a sequence number past
  `Number.MAX_SAFE_INTEGER`, and validates `checkpoint` input, as the real WAL
  already did. A dependency-injection seam is only useful if it fails where the
  thing it stands in for fails.

Two of these turn something that used to be accepted into an error. Both are
cases the documentation already described as errors, but a log containing a
blank line — or code passing a string for `fsync` — will notice the change.

## [1.4.0] - 2026-08-01

### Added

- `ERR_WAL_UNUSABLE`. If a write to the log fails partway — a full disk, a
  failing flush — the instance can no longer tell whether the record reached the
  file, so it stops accepting work and every method except `close()` throws this
  code.

  Guessing was the alternative, and both guesses corrupt. Continuing would weld
  the next record onto a partial line; retrying would reissue a sequence number
  that is already in the file. A log with a repeated sequence **refuses to open
  at all**, so a single failed flush cost the entire backlog rather than one
  entry. Close the instance and open a new one — recovery on open truncates the
  incomplete record and carries on.

### Fixed

- A failed compaction no longer risks the writer. The log is closed before the
  rename because Windows will not replace an open file, and the reopened
  descriptor was only handed back on success; a failure left the instance
  holding a closed one. It is now restored on every path out.
- Compaction accounting follows the rename rather than the directory flush that
  comes after it. Those bytes are gone once the rename succeeds, so a failing
  flush no longer leaves `stats()` reporting space that is not there.

## [1.3.2] - 2026-08-01

### Fixed

- `stats()` reported the wrong backlog when the pending records were not
  contiguous. Checkpoint accounting advanced by the numeric distance between
  checkpoints, which assumes the record above a checkpoint is the next sequence
  number. After a corrupt checkpoint falls back to zero — documented, safe
  behaviour — the surviving records can start at any sequence number, and
  `checkpoint(1)` would then mark an unrelated record as covered:
  `pendingEntries` dropped to 0 while `replay()` still returned an entry, and
  `bytes` disagreed with the file after compaction. It now advances by comparing
  sequence numbers, so contract invariant 9 holds whatever the log contains.

- Checkpointing a large replayed backlog one entry at a time no longer does
  quadratic work. Each checkpoint removed the covered prefix by copying the rest
  of the array; it now moves an index. This is invisible below roughly 200,000
  pending records, where the checkpoint's own write and rename dominate, and
  decisive above it — the array work alone measures 47 seconds at 200,000
  against 2 milliseconds.

## [1.3.1] - 2026-08-01

### Security

- Checkpointing and compaction wrote to a predictable temporary name
  (`wal.checkpoint.tmp`, `wal.jsonl.tmp`) opened in a mode that follows an
  existing directory entry. An actor able to create entries inside the WAL
  directory could plant a symlink there and have the write land on a file
  **outside** it, with the privileges of the running process — which
  `SECURITY.md` already listed as in scope.

  Temporaries are now created exclusively, under an unpredictable name, so there
  is nothing to plant at and an existing entry is refused rather than reused.
  Leftovers from an interrupted write are swept when the WAL is opened. Affects
  1.3.0 and earlier; no API change.

  `SECURITY.md` also states the limit of this guarantee honestly: Node offers no
  portable way to open an existing file without following a symlink, so
  replacing `wal.jsonl` itself stays out of scope and the WAL directory must be
  private to the account running the process.

### Fixed

- `package-lock.json` had drifted to `1.1.0` while the package was at `1.3.0`.

## [1.3.0] - 2026-07-31

### Added

- `appendMany(values)` persists a batch in one write and one flush, returning a
  sequence number per value:

  ```ts
  const seqs = wal.appendMany(batch);
  ```

  With `fsync: true` the flush is the entire cost, and paying it once per batch
  rather than once per record moves throughput from 2,163 to 184,642 records per
  second at a batch of 100 — 85× for 17% more time per call. With
  `fsync: false` the saving is a few syscalls and much smaller.

  If the call returns, every record in the batch is durable. It is not
  transactional: a crash _during_ the call can leave a prefix on disk, which
  replays like any other unacknowledged work. What it does guarantee is that a
  value it cannot serialise fails the call before anything is written, because
  the batch is encoded in full first — a bad value in the middle costs you the
  call, never half a batch. An empty batch is a no-op.

## [1.2.0] - 2026-07-31

### Added

- `stats()` returns the log's position and size without reading the
  filesystem — `lastSeq`, `checkpoint`, `pendingEntries`, `bytes` and
  `reclaimableBytes`. It is cheap enough for a metrics scrape or a health
  check, which is what it exists for:

  ```ts
  if (wal.stats().reclaimableBytes > 50_000_000) wal.compact();
  ```

  Until now, deciding when to compact meant calling `fs.statSync` on a filename
  that is an implementation detail, and there was no way at all to see the
  backlog. `pendingEntries` is exactly what `replay()` would return and
  `reclaimableBytes` is exactly what the next `compact()` would free; both are
  verified against the filesystem across randomised operation sequences rather
  than asserted.

  `reclaimableBytes` is the one field that is not a plain counter. It cannot be
  derived from the others — two logs with identical sequence numbers and total
  size differ by more than tenfold depending on which records happen to be
  large — so the WAL keeps one byte length per pending record and releases them
  as checkpoints advance.

- `WalStats` is exported for code that names the return type.

### Security

- Every GitHub Action in the release pipeline is pinned by commit hash rather
  than by tag. A tag can be moved to point at different code without the
  reference changing, which is how a compromised action has previously stolen
  secrets from thousands of repositories. Since `release.yml` is what builds and
  publishes this package, the change is about the integrity of the artifact you
  install, not only the repository.
- The default branch now enforces what the docs already claimed: no direct
  pushes, no force pushes, pull requests only, and a green Node 22/24 ×
  Linux/macOS/Windows matrix before anything can merge. Nothing can reach a
  release without passing the durability suite.
- Added CodeQL analysis and property-based tests over the recovery path, so the
  security policy's claim about crafted log files is tested rather than asserted.

### Documentation

- Noted that `-0` replays as `0`, alongside the existing `Date`, `Map` and
  `undefined` round-trip caveats. JSON, not the log, is what loses the sign.

## [1.1.0] - 2026-07-31

Removes the library's two documented footguns instead of continuing to warn
about them. Nothing that worked before behaves differently.

### Added

- A WAL implements `[Symbol.dispose]` and a cursor implements
  `[Symbol.asyncDispose]`, so scope can own them:

  ```ts
  using wal = createWal({ dir: "./data" });
  await using cursor = wal.cursor();
  ```

  This matters most for cursors. A cursor holds a file descriptor, and leaking
  one defers `compact()` for the life of the process and keeps the log locked on
  Windows. `await using` releases it on every exit path, including an early
  `return` from the enclosing function, which no previous form covered.

- The cursor type is exported as `WalCursor<T>` for code that needs to name it.

### Changed

- **`close()` is now idempotent.** A second call is a no-op instead of throwing
  `ERR_WAL_CLOSED`. Calling it from both a `finally` and a `SIGTERM` handler is
  what correct shutdown code looks like, and the old behaviour punished it — the
  README had to carry a warning telling you to guard the call. You can delete
  those guards.

  Every _other_ method still throws `ERR_WAL_CLOSED` after close. The asymmetry
  is deliberate: releasing a resource twice is harmless, but an `append()` that
  quietly succeeded after close would drop work you had been told was durable.

This release only widens what is accepted. The single behaviour change affects
code that currently raises an exception, so no working program can observe it
unless it depended on `close()` throwing.

## [1.0.1] - 2026-07-31

Documentation only. The library, its API, and its durability contract are
unchanged from 1.0.0; this release exists so the rewritten documentation reaches
the npm package page, which only refreshes when a version is published.

### Changed

- The README now answers "is this for me?" first and links out for the rest.
  Recovery semantics, the manual repair procedure, cost and memory profiles,
  design-decision rationale, and the survey of alternatives moved into a `docs/`
  directory, each linked from the README. Nothing was dropped, and no documented
  guarantee changed — only where it is written down.
- Added a comparison against `node:sqlite`, `better-sqlite3`, the
  document-rewriting file stores, and the broker-backed queues, so the tradeoff
  is visible before you install rather than after.
- Benchmarks are now reported for NTFS and ext4 on the same machine and the same
  NVMe device. The `fsync: true` cost triples between the two filesystems while
  the `fsync: false` cost more than halves, which makes it clearer than a single
  figure could that append latency is a property of your filesystem. Both modes
  are quoted in the README as ranges and documented in full in
  `docs/benchmarks.md`.

### Fixed

- README images and links now use absolute URLs. Relative paths render as broken
  images and dead links on npmjs.com and every other site that mirrors the
  README, because those sites do not resolve paths against the repository.
- Expanded the sequence-diagram alt text, which was previously a filename.

## [1.0.0] - 2026-07-29

First stable release. The API in the README is closed and the durability
contract is a commitment: any change to it from here is a major version.

### Added

- Zero-runtime-dependency TypeScript WAL with synchronous `append`,
  `checkpoint`, `compact`, and `close`, plus `replay` and a streaming `cursor`.
- Configurable page-cache or `fsync` durability for appends, atomic checkpoints,
  compaction, and close.
- Recovery for torn trailing records, corrupt checkpoints, interrupted temporary
  replacements, and monotonic on-disk sequence validation. A complete but
  unparseable record stops startup instead of being skipped, so acknowledged
  work is never dropped silently; the README documents the repair procedure.
- Frozen, bounded-memory cursors with deferred compaction for Windows
  compatibility.
- Compaction streams the log instead of loading it, so it keeps working on the
  large logs that need it most, and a failure on the `compactInterval` timer is
  reported through `process.emitWarning` rather than silently ignored.
- `createNoopWal` as a disk-free dependency-injection seam.
- Dual ESM/CJS builds with declarations, Node 22+ support, package validation,
  real-filesystem durability tests, process-kill integration tests, coverage,
  and a reproducible append benchmark.
- README guidance covering the durability model, at-least-once processing,
  architectural decisions, operational costs, use cases, and alternatives.
