# AGENTS.md — process-wal

Guidance for coding agents (and humans) working in this repository. Read this
before changing anything.

## What this is

A zero-dependency, pure-TypeScript write-ahead log for Node.js: durability across
_process_ restarts via the kernel page cache, with `fsync` as the opt-in for
host-crash durability. Single writer, append-and-replay, ~150 lines of core code.
That smallness is the product — treat scope as a constraint, not a starting point.

**Source of truth:** `../process-wal-definition.md` (one directory above the repo
root — the build brief: motivation, API contract, edge semantics, test plan,
milestones). Read it before touching the API surface. If a change contradicts the
brief, update the brief first (with the user), then the code.

**Reference implementation** (on this machine):
`C:\Users\andre\Projects\marfeel\ta-weather-station\server\ingestor\wal.js` — the
production original this library is extracted from — and `writer.js` next to it,
the real consumer that shows how the API is used in anger. The brief's §13
(origin note) explains why they matter.

## Commands

Canonical once the relevant tooling milestone lands:

```sh
npm run build        # tsup — dual CJS/ESM + .d.ts into dist/
npm test             # vitest run — unit + durability + integration
npm run test:watch   # vitest
npm run bench        # vitest bench — fsync cost, p75/p99
npm run coverage     # vitest run --coverage — local gate, no hosted service
npm run lint         # eslint + prettier --check
npm run lint:package # validate the built package with publint + attw
```

There is no `npm run release`. A release is a merged version-bump PR followed by
a `vX.Y.Z` tag push; `.github/workflows/release.yml` does the rest.

Debugging internals without a flag system: `NODE_DEBUG=process-wal node app.js`
turns on `util.debuglog('process-wal')` traces the implementation emits at
notable branches (heal-on-open, compact deferred by an open cursor, checkpoint
fallback to 0) — silent by default, zero dependency, opt-in.

## Verifying external information

Before writing code, docs, or advice that depends on the behaviour of a
third-party package, library, API, or platform, confirm current behaviour
against an authoritative external source — official docs, the package's own
README/CHANGELOG, or its source — rather than relying on training-data recall,
which goes stale as new versions ship. This applies to Node.js built-ins too
when behaviour is version- or platform-sensitive (e.g. `fs.rename` semantics
differ Windows vs POSIX — see contract invariant 5 below, and `fs` options like
`flush` that only exist from a given Node version). Since this repo is
zero-runtime-dependency, this mostly governs the dev toolchain actually
installed (`vitest`, `tsup`, `eslint`, `prettier`, `publint`, Node itself) —
check the installed version's docs before assuming a flag, API, or default
hasn't changed. If no reliable source is reachable, say so explicitly instead of
guessing.

## Non-negotiable constraints

- **Zero runtime dependencies.** Only Node built-ins (`fs`, `path`). A PR that
  adds a runtime dependency is wrong by definition, whatever it fixes.
- **Closed API surface:** `createWal`, `createNoopWal`; methods `append`,
  `checkpoint`, `replay`, `cursor`, `compact`, `close`. New surface requires a
  brief amendment first.
- **Synchronous by design.** `append`/`checkpoint`/`compact`/`close` are sync —
  that's the durability contract (the record reaches the kernel before we
  return). Do not "improve" them into async. Only `cursor` is async.
- **~150 lines of core.** If `src/wal.ts` grows well past that, something is
  being gold-plated.
- **Minimal repository surface.** Add documentation, configuration, templates,
  and generated artifacts only when a current milestone uses them. Prefer a
  readable package script over a one-option config file, and remove obsolete
  scaffolding instead of preserving it for hypothetical future needs.
- **The comments are the spec.** Comments explain _why_ (durable-before-ack,
  page-cache trade-off, heal-on-open), never _what_ the next line does. Preserve
  that register when editing.
- **No durability claim without a test.** Anything the README asserts about
  crash-survival must have a test in `test/` that demonstrates it.

## Contract invariants (breaking any of these is a bug, not a refactor)

1. Append is durable-before-return: `fs.writeSync` completes before `append`
   returns its seq.
2. On open, a torn tail (file not ending in `\n`) is truncated away **before**
   any new append is accepted — otherwise the next good entry welds onto the
   garbage and is lost.
3. Checkpoint and compaction both write tmp-then-`rename` (atomic). With
   `fsync: true`, the flush covers appends, the checkpoint file, and compaction —
   not just log lines.
4. Seqs are monotonic per instance; after a crash the seq of a torn
   (never-returned) entry may be re-issued. Never persist a "next seq" that
   promises gap-freedom.
5. A cursor freezes its view at creation (checkpoint snapshot, own fd);
   `compact()` is deferred while any cursor is open (also a Windows correctness
   requirement — rename over an open file fails there).
6. Every method throws `ERR_WAL_CLOSED` after `close()`. Errors carry stable
   `code` properties (`ERR_WAL_CLOSED`, `ERR_ENTRY_TOO_LARGE`,
   `ERR_ENTRY_NOT_SERIALIZABLE`), not exported classes.
7. The `compactInterval` timer is `unref()`'d and cleared by `close()`.

## Change workflow

Follow this sequence for every code, behavior, configuration, or documentation
change:

1. **Understand the contract.** Read the relevant brief section, current tests,
   and implementation before editing. Check the production reference when the
   change touches append-before-ack, checkpointing, recovery, or batching
   semantics.
2. **Classify the impact.** State whether the change affects the public API,
   durability contract, on-disk format, performance, packaging, or only internal
   structure. Amend the brief with the user before changing a closed contract.
3. **Implement the smallest coherent change.** Preserve zero runtime
   dependencies, synchronous durability methods, stable error codes, and clear
   responsibility boundaries. Remove superseded code or configuration in the
   same change.
4. **Add or update tests with the implementation.**
   - Behavior changes need focused unit tests.
   - Recovery or durability changes need real-filesystem failure tests.
   - Process-lifecycle claims need deterministic child-process integration
     tests.
   - Cursor changes must cover snapshot consistency and descriptor release.
   - Packaging changes must pass both ESM/CJS and declaration validation.
     Never weaken or delete a test merely to make a change pass.
5. **Run proportional validation.** At minimum run `npm run lint` and
   `npm test`. Before handoff or PR, run `npm run coverage` and
   `npm run lint:package`. Re-run `npm run bench` whenever the append path
   changes, and copy only measured results into the README.
6. **Update user-facing documentation in the same change.**
   - Update `README.md` when installation, API, options, guarantees,
     limitations, operational behavior, examples, positioning, or benchmark
     numbers change.
   - Update `CHANGELOG.md` for user-visible additions, changes, fixes, removals,
     deprecations, or security work. Write outcomes for library consumers, not
     implementation notes or commit summaries.
   - Internal refactors, tests, and CI-only work need no changelog entry unless
     they alter observable behavior or supported environments.
   - A durability statement may be documented only when a test demonstrates it.
7. **Review the final diff.** Confirm code, tests, README, changelog, brief, and
   package metadata agree; remove temporary output and unrelated scaffolding;
   then report the exact commands and results used for validation.

## GitHub workflow

### Branches

- `main` is protected — never commit to it directly, even for docs.
- One branch per milestone, in the brief's §11 order (`chore/scaffold` →
  `feat/core-wal` → … → `chore/release`). Prefixes: `feat/`, `fix/`, `test/`,
  `chore/`, `docs/`, `refactor/`; kebab-case after the slash.
- Branch from an up-to-date `main`; rebase onto `main` to update (no merge
  commits from `main` into feature branches).

### Commits — Conventional Commits 1.0.0

- Format: `type(scope)?: subject` — imperative mood, lower-case, no trailing
  period, subject ≤ 72 chars. Body explains _why_ when the subject can't.
- Types in use: `feat`, `fix`, `test`, `chore`, `docs`, `refactor`, `perf`, `ci`.
- Breaking changes: `!` after the type **and** a `BREAKING CHANGE:` footer
  describing the migration.
- Every commit must build and pass tests on its own — history stays bisectable.

### Authorship — no AI attribution, ever

Commits, PR titles/bodies, `CHANGELOG.md`, code comments, and release notes carry
**only the maintainer's authorship** (the repo's configured git user). Never add
`Co-Authored-By: Claude …` trailers, "Generated with Claude Code" footers, or any
other AI/agent attribution — including tool defaults that inject them. This
applies to every agent and tool working in this repository, with no exceptions.

### Versioning & changelog — semver, by hand, released by tag

- `CHANGELOG.md` is written by hand in [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
  order. There is no changeset tooling: this is one module with one maintainer,
  and a generated changelog reads worse than a written one.
- Accumulate user-visible changes under `[Unreleased]` as they land. Write for
  the changelog reader — what the release does for them — not for the reviewer.
- Mapping: `fix` → patch, `feat` → minor, breaking → major. The package is
  `1.0.0`, so the §4 contract is a real commitment: **any breaking change to it
  is a major version.** Never quietly widen or narrow the contract in a patch.
- Release flow: move `[Unreleased]` to `[X.Y.Z] - YYYY-MM-DD`, bump `version` in
  `package.json`, merge that PR, then push the matching `vX.Y.Z` tag. The tag
  triggers `release.yml`, which republishes only if the tag and `package.json`
  agree, then creates the GitHub Release from the changelog entry.
- Publishing uses npm **Trusted Publishing** over GitHub OIDC — no `NPM_TOKEN`
  lives in this repository, and provenance is attested automatically. Never
  reintroduce a long-lived publish token.

### Pull requests

- **Every PR targets `main`. Never stack PRs on one another.** A stack merged in
  order lands each PR on its stale sibling rather than `main` — GitHub only
  re-targets a stacked PR when its base branch is deleted on merge — so the work
  reports as merged while `main` never receives it. This has already cost this
  repository one full recovery.
- One milestone per PR; keep diffs reviewable (aim under ~400 lines; split if a
  milestone outgrows that).
- **Title in conventional-commit format** — PRs are squash-merged, so the title
  becomes the commit on `main` and must parse like one.
- Body covers: what changed and why, how it was tested (paste real output for
  durability claims), and any impact on the §4 contract/edge semantics.
- Squash-merge only; `main` history stays linear. Never force-push `main`; never
  skip hooks (`--no-verify`) or CI to get a merge through.
- Merge requires green CI — lint + test + build across the **full Node × OS
  matrix**. Windows is a first-class target, not a footnote: the maintainer
  develops on Windows, so no POSIX-only assumptions in tests (paths, signals,
  rename semantics).

### Quality gates

- Benchmark numbers in the README come from `npm run bench` output only — never
  hand-written, and re-run when the append path changes.
- A README durability claim added in a PR requires the test that backs it in the
  same PR.
- A user-visible code change is incomplete until its README impact is assessed
  and its changelog source (`CHANGELOG.md` now, a changeset after release tooling
  lands) is updated.

## Testing notes

- Tests exercise **real file I/O** in throwaway dirs
  (`fs.mkdtempSync(path.join(os.tmpdir(), 'wal-test-'))`) — the file behaviour
  _is_ the unit under test. No fs mocking.
- Integration tests spawn child processes and `SIGKILL` them mid-work; keep them
  deterministic (explicit sync points, not sleeps).
- The durability test list in the brief's §7 is the checklist; the torn-tail
  healing test and the checkpoint-corruption test are the two most commonly
  forgotten.
