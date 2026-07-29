# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and releases follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
