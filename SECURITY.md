# Security policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 1.x     | Yes       |

This is a single-maintainer package. Fixes land on the latest release; there are
no backport branches. `process-wal` is `1.x`, so a security fix that has to
break the documented contract would still be a major version — it will be
released as one rather than smuggled into a patch.

## Reporting a vulnerability

Report privately through GitHub — never in a public issue or discussion:

**[Open a private advisory](https://github.com/AndresSaa/process-wal/security/advisories/new)**

That form is only visible to the maintainer. Please include the affected
version, the platform and filesystem, and the smallest reproduction you can
manage — for this package that usually means a WAL directory in a particular
state plus the sequence of calls that mishandles it.

Expect an acknowledgement within a week. If a report is valid, you will get the
fix timeline with it, and credit in the advisory and `CHANGELOG.md` unless you
ask otherwise. If a report is not something this package can fix, you will get a
reason rather than silence.

## What is in scope

The library's job is to write, read back, and replace files inside a directory
you give it. Things that would be genuine vulnerabilities:

- Reading or writing outside the configured `dir`, including through symlinks
  placed in it or filenames that escape it. Temporary files are created
  exclusively under unpredictable names, so an entry planted in the directory
  cannot be written through.
- A crafted `wal.jsonl` or `wal.checkpoint` that crashes the process, hangs it,
  or drives unbounded memory growth on open, `replay()`, `cursor()`, or
  `compact()`.
- Prototype pollution reaching application objects through the `JSON.parse` of a
  log record.
- The temporary-file-then-`rename` sequence used by checkpointing and compaction
  being divertible into replacing a file it should not.
- Acknowledged work being lost in a way the documented contract says it should
  not be — a durability guarantee that does not hold is a real bug, whether or
  not it is reachable by an attacker.

## What is not in scope

These are documented behaviours, not vulnerabilities. Reporting them is welcome
as a normal issue if the documentation is unclear, but they will not be treated
as security reports:

- Data loss after host or power loss with the default `fsync: false`. The
  default durability boundary is the kernel page cache, and
  [docs/durability.md](docs/durability.md) says so.
- Corruption caused by two processes writing the same WAL directory. The package
  is single-writer by design and does not lock.
- A complete but unparseable record refusing to open the log. That is
  deliberate: skipping it would silently drop work the library already
  acknowledged.
- Replacing `wal.jsonl` or `wal.checkpoint` themselves with a symlink. Node
  offers no portable way to open an existing file without following a link —
  `O_NOFOLLOW` does not exist on Windows — so **the WAL directory must be
  private to the account running the process.** Do not place it somewhere other
  users can create entries, such as a shared temporary directory.
- Anything requiring an attacker who can already write freely to your WAL
  directory _and_ whose goal is only to corrupt your own data. If they are
  inside that directory, the log is the least of it. Escaping the directory, or
  reaching the host process, is still in scope.
- Vulnerabilities in development dependencies that cannot reach a consumer of
  the published package. The package ships with **zero runtime dependencies**,
  and the tarball carries only `dist/`, `README.md`, `CHANGELOG.md`, `LICENSE`
  and `package.json` — no scripts, no configuration, no tests.

## Supply chain

Releases publish from GitHub Actions using npm
[trusted publishing](https://docs.npmjs.com/trusted-publishers) over OIDC, with
[provenance](https://docs.npmjs.com/generating-provenance-statements) attested
automatically. No long-lived npm token exists in this repository, so there is no
publish credential here to steal. Every published artifact is cryptographically
linked to the commit and workflow that built it — check it with
`npm audit signatures`.
