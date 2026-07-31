# Contributing

Thanks for looking. Before you write code, please read the next section — it
will save you time if what you have in mind is out of scope.

## Scope is a constraint, not a starting point

`process-wal` does one thing: durability across process restarts for a single
local writer. The small size **is** the product. That means some perfectly
reasonable ideas will be declined, and it is not personal:

- **Zero runtime dependencies.** Only Node built-ins. A pull request that adds a
  runtime dependency is out of scope whatever it fixes.
- **The API is closed.** `createWal`, `createNoopWal`, and the methods `append`,
  `appendMany`, `checkpoint`, `replay`, `cursor`, `compact`, `stats`, `close`.
  New surface needs agreement in an issue first.
- **`append`, `appendMany`, `checkpoint`, `compact` and `close` are
  synchronous.** That is the
  durability contract, not an oversight: the record reaches the kernel before
  the call returns. Only `cursor` is async.
- **Multi-process, networked, replicated, transactional, or queue-like
  features** belong in the tools listed in
  [docs/alternatives.md](docs/alternatives.md), not here.

Bug reports, durability edge cases, portability fixes, documentation, and tests
are welcome without reservation.

## Getting set up

Node.js 22 or newer.

```sh
npm ci
npm test          # build, then unit + durability + integration
npm run lint      # tsc --noEmit, eslint, prettier --check
npm run coverage
npm run lint:package
npm run bench     # only when the append path changed
```

## Tests

Tests use **real file I/O** in throwaway directories. There is no filesystem
mocking, because the filesystem behaviour is the thing under test. If you change
behaviour, the test goes in the same pull request:

- Behaviour changes need focused unit tests.
- Recovery and durability changes need real-filesystem failure tests.
- Process-lifecycle claims need child-process tests that `SIGKILL` for real, and
  they must be deterministic — explicit sync points, never sleeps.
- Cursor changes must cover both snapshot consistency and descriptor release.

**Windows is a first-class target.** The maintainer develops on it and CI runs
the full Node 22/24 × Linux/macOS/Windows matrix. No POSIX-only assumptions
about paths, signals, or rename semantics — renaming over an open file fails on
Windows, and the cursor and compaction design already accounts for that.

Never weaken or delete a test to make a change pass.

## Documentation

- Update `README.md` when installation, API, options, guarantees, limitations,
  or examples change.
- Add an entry to `CHANGELOG.md` under `[Unreleased]` for anything a user would
  notice. It is written by hand, in
  [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) order, for the person
  reading the release — not a summary of your commits. Internal refactors, tests
  and CI work do not need one.
- **A durability claim may only be documented if a test demonstrates it.**
- Benchmark numbers come from `npm run bench` output, never from an estimate.
- The readme diagram is generated. Edit `.github/diagrams/readme-flow.mmd`, run
  `npm run docs:diagram`, and commit source and image together — CI checks that
  the two agree.

## Pull requests

- Branch from an up-to-date `main`. Prefixes: `feat/`, `fix/`, `test/`,
  `chore/`, `docs/`, `refactor/`, kebab-case after the slash.
- **Every pull request targets `main`, and never another pull request.**
- **The title must be a valid [Conventional Commit](https://www.conventionalcommits.org/en/v1.0.0/)**
  — `type(scope): subject`, imperative, lower case, no trailing period. Pull
  requests are squash-merged, so the title becomes the commit message on `main`
  and CI checks that it parses.
- Keep diffs reviewable, roughly under 400 lines. Split if the work outgrows it.
- Describe what changed and why, how you tested it — paste real output for
  durability claims — and any effect on the documented contract.
- Merging needs a green matrix. Do not skip hooks or CI to get a change through.

`AGENTS.md` holds the longer version of all of this, including the reasoning
behind each rule.

## Reporting things

- **Bugs:** open an issue — the form asks for the filesystem and durability mode,
  which is usually where the answer is.
- **Questions and ideas:** use
  [Discussions](https://github.com/AndresSaa/process-wal/discussions). Questions
  stay findable there as answers instead of closing as "not a bug".
- **Security vulnerabilities:** do not open a public issue. Follow
  [SECURITY.md](SECURITY.md).

## License

By contributing you agree that your contributions are licensed under the
[MIT License](LICENSE) that covers this project.
