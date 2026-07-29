# process-wal

Durability across Node.js process restarts — without SQLite, Redis, a broker, or
native binaries. Pure TypeScript, zero runtime dependencies, one clear job.

The public contract lives in `src/types.ts`; the implementation lands over the
milestones in the build brief. Full documentation ships with the `docs/readme`
milestone.

## Development

```sh
npm ci
npm run lint
npm test
npm run coverage
npm run lint:package
```

Requires Node.js 22 or newer. CI runs lint, coverage, and package validation on
Node 22 and 24 across Linux, macOS, and Windows.

## License

MIT
