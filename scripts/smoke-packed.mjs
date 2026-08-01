import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// publint and attw read the package; they never load it. A broken exports map,
// a file left out of `files`, or a build that emits something Node refuses to
// parse all pass static analysis and fail on the consumer's first import.
//
// So this installs the tarball CI would publish into a throwaway package and
// imports it *by name*, which is what resolves through `exports` — importing
// dist/ by path would prove much less.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspace = mkdtempSync(path.join(tmpdir(), "wal-smoke-"));

// npm is a .cmd shim on Windows, which Node refuses to spawn directly. Going
// through cmd.exe rather than `shell: true` keeps the arguments a real argv:
// concatenating them into a shell string is what DEP0190 warns about.
const windows = process.platform === "win32";
const npm = (args, cwd) =>
  execFileSync(
    windows ? "cmd.exe" : "npm",
    windows ? ["/c", "npm", ...args] : args,
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  ).trim();

try {
  const tarball = npm(
    ["pack", "--silent", "--pack-destination", workspace],
    root,
  )
    .split("\n")
    .pop();

  writeFileSync(
    path.join(workspace, "package.json"),
    JSON.stringify({ name: "wal-smoke", version: "0.0.0", private: true }),
  );
  npm(["install", "--silent", "--no-audit", "--no-fund", tarball], workspace);

  const checks = [
    [
      "ESM",
      "module",
      `const { createNoopWal } = await import("process-wal");
       const wal = createNoopWal();
       if (wal.append("x") !== 1) throw new Error("ESM append misbehaved");
       wal.close();`,
    ],
    [
      "CJS",
      "commonjs",
      `const { createNoopWal } = require("process-wal");
       const wal = createNoopWal();
       if (wal.append("x") !== 1) throw new Error("CJS append misbehaved");
       wal.close();`,
    ],
  ];

  for (const [label, type, source] of checks) {
    execFileSync(process.execPath, ["--input-type", type, "-e", source], {
      cwd: workspace,
      stdio: ["ignore", "ignore", "inherit"],
    });
    console.log(`${label}: resolved by name from the packed tarball and ran`);
  }
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
