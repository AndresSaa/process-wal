# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and releases follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
