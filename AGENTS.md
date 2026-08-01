# AGENTS.md — process-wal

Guidance for coding agents (and humans) working in this repository. Read this
before changing anything.

## What this is

A zero-dependency, pure-TypeScript write-ahead log for Node.js: durability across
_process_ restarts via the kernel page cache, with `fsync` as the opt-in for
host-crash durability. Single writer, append-and-replay, split across small
single-purpose modules of which none exceeds ~200 lines. That smallness is the
product — treat scope as a constraint, not a starting point.

It exists because an email marketing project was losing tracking events that had
already been acknowledged to the webhook that delivered them. That is still the
shape of the problem it solves.

**The contract lives in this repository.** The invariants below, the tests, and
the public types are the source of truth — there is no external document.

## Commands

Canonical:

```sh
npm run build        # tsup — dual CJS/ESM + .d.ts into dist/
npm test             # vitest run — unit + durability + integration
npm run test:watch   # vitest
npm run bench        # vitest bench — fsync cost, p75/p99
npm run coverage     # vitest run --coverage — local gate, no hosted service
npm run lint         # eslint + prettier --check
npm run lint:package # publint + attw, then load the packed tarball for real
npm run check:diagrams # the readme diagram still matches its .mmd source
npm run docs:diagram   # regenerate it after editing the .mmd
npm run smoke:package  # install the packed tarball and import it (in lint:package)
```

`lint:package` ends by installing the tarball into a throwaway package and
importing it by name. publint and attw read the package; only that step proves
it loads.

There is no `npm run release`. A release is a merged version-bump PR followed by
a `vX.Y.Z` tag push; `.github/workflows/release.yml` does the rest.

Debugging internals without a flag system: `NODE_DEBUG=process-wal node app.js`
turns on `util.debuglog('process-wal')` traces the implementation emits at
notable branches (heal-on-open, compact deferred by an open cursor, checkpoint
fallback to 0) — silent by default, zero dependency, opt-in.

## Cross-agent scratch space (`.ai/`)

More than one agent works on this repository, and they do not share a session.
`.ai/` is where they leave work for each other on this machine. It is
**gitignored in full** — nothing in it is ever committed.

```
.ai/
├── pr-audits/  # review output, one file per audit
└── temp/       # scratch, disposable without asking
```

Naming: `pr-audits/{YYYY-MM-DD}_{HHMMSS}_{type}-{slug}.md`, e.g.
`2026-08-01_143022_feat-append-many.md`. Date first so a directory listing comes
out in the order the audits happened, which is how you read them. An audit says
who produced it and against which commit, because "the audit said so" is
worthless without knowing what it read.

**The rule that matters: `.ai/` holds working notes, never decisions.** The
contract lives in this repository — the invariants above, the tests, the public
types. An audit that changes something must land that change in a tracked file
in the same session, or it did not happen. A finding that only exists in `.ai/`
is lost the moment the directory is cleaned, which is any time.

Two consequences worth stating:

- **Never treat a file in `.ai/` as authoritative.** It is one tool's opinion at
  one point in time, possibly against a commit that no longer exists. Verify a
  claim against the code before acting on it, exactly as with any external
  source (see the section below).
- **No secrets, ever.** The directory is untracked, not encrypted, and it is on
  the same disk as everything else.

`temp/` needs no retention policy: delete it whenever, including mid-task.

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
  `appendMany`, `checkpoint`, `replay`, `cursor`, `compact`, `stats`, `close`,
  plus
  `[Symbol.dispose]` on a WAL and `[Symbol.asyncDispose]` on a cursor. New
  surface requires amending the invariants below first.
- **Synchronous by design.** `append`/`appendMany`/`checkpoint`/`compact`/`close`
  are sync —
  that's the durability contract (the record reaches the kernel before we
  return). Do not "improve" them into async. Only `cursor` is async.
- **~200 lines per module, and one job each.** The budget is per file, not for
  the package: `wal.ts` decides _when_ things happen, and the modules it calls
  know _how_. A file growing past ~200 lines usually means it has picked up a
  second responsibility — extract that rather than trimming comments, which are
  the spec. Raised from 150 once `stats()` and the disposal protocol landed;
  raise it again only with the same kind of argument, never to make room.
- **`types.ts` is the public contract and nothing else.** Every type in it is
  re-exported by `index.ts`, and every type `index.ts` exports is in it. Types
  describing how two modules talk to each other live with the module that owns
  them, so `types.ts` keeps answering "what does a consumer get?" on its own.
- **Minimal repository surface.** Add documentation, configuration, templates,
  and generated artifacts only when something in the repository uses them. Prefer a
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
6. Every method **except `close()`** throws `ERR_WAL_CLOSED` once closed.
   `close()` is idempotent, and `[Symbol.dispose]` aliases it: releasing a
   resource twice is what correct shutdown code does, but an `append()` that
   succeeded after close would silently drop work. Errors carry stable `code`
   properties (`ERR_WAL_CLOSED`, `ERR_WAL_UNUSABLE`, `ERR_ENTRY_TOO_LARGE`,
   `ERR_ENTRY_NOT_SERIALIZABLE`), not exported classes.
7. The `compactInterval` timer is `unref()`'d and cleared by `close()`.
8. `appendMany` encodes the whole batch before writing any of it, so a value it
   cannot serialise leaves the log and the sequence untouched. Returning means
   the batch is durable; it is not atomic against a crash mid-write, which
   leaves a healed prefix like any interrupted append.
9. A failed write poisons the instance: it cannot tell whether the record
   reached the file, and either guess corrupts the log — a partial line welded
   to the next record, or a reissued sequence number, which makes the log
   unopenable. Every method except `close()` then throws `ERR_WAL_UNUSABLE`.
   Compaction is different: a failed rename changes nothing, so the writer is
   restored and the instance stays usable.
10. `stats()` reads only memory, never the filesystem. `pendingEntries` equals
    what `replay()` returns and `reclaimableBytes` equals what `compact()` would
    free — both exactly, both maintained through append, checkpoint, compaction
    and heal-on-open.

## Change workflow

Follow this sequence for every code, behavior, configuration, or documentation
change:

1. **Understand the contract.** Read the invariants below, the current tests,
   and the implementation before editing.
2. **Classify the impact.** State whether the change affects the public API,
   durability contract, on-disk format, performance, packaging, or only internal
   structure. Amend the invariants below with the user before changing a closed
   contract.
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
7. **Review the final diff.** Confirm code, tests, README, changelog, and
   package metadata agree; remove temporary output and unrelated scaffolding;
   then report the exact commands and results used for validation.

## GitHub workflow

### Branches

- `main` is protected — never commit to it directly, even for docs.
- One branch per change. Prefixes: `feat/`, `fix/`, `test/`, `chore/`, `docs/`,
  `refactor/`; kebab-case after the slash.
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
  released and stable, so the contract invariants above are a real commitment:
  **any breaking change to them is a major version.** Never quietly widen or narrow the contract in a patch.
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
- One concern per PR; keep diffs reviewable (aim under ~400 lines; split if a
  change outgrows that).
- **Title in conventional-commit format** — PRs are squash-merged, so the title
  becomes the commit on `main` and must parse like one.
- Body covers: what changed and why, how it was tested (paste real output for
  durability claims), and any impact on the contract invariants.
- Squash-merge only; `main` history stays linear. Never force-push `main`; never
  skip hooks (`--no-verify`) or CI to get a merge through.
- Merge requires green CI — lint + test + build across the **full Node × OS
  matrix**: both active LTS lines on Linux, macOS and Windows, plus one leg on
  Current so that `engines: >=22` is a claim something checks. Windows is a first-class target, not a footnote: the maintainer
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
- The contract invariants above are the durability checklist; the torn-tail
  healing test and the checkpoint-corruption test are the two most commonly
  forgotten.
