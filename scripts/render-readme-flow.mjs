import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const diagramsDir = path.join(root, ".github", "diagrams");
const source = path.join(diagramsDir, "readme-flow.mmd");
const config = path.join(diagramsDir, "mermaid-theme.json");
const fingerprintFile = path.join(diagramsDir, "rendered.sha256");

const assetsDir = path.join(root, ".github", "assets");
const temporaryPng = path.join(assetsDir, ".readme-flow.tmp.png");
const outputWebp = path.join(assetsDir, "readme-flow.webp");

const relative = (file) => path.relative(root, file).split(path.sep).join("/");

// Rendering is not reproducible across machines: Mermaid lays the diagram out
// with whatever font the host actually has, and the theme asks for three that
// Linux runners do not ship. Comparing the rendered bytes in CI would therefore
// fail on every run. Fingerprinting the *inputs* catches the failure that
// actually happens — editing the .mmd and forgetting to regenerate — and does
// it identically on every OS, with no browser involved. .gitattributes forces
// LF in every working tree, so these hashes are stable across platforms.
const fingerprint = async () => {
  const entries = [];

  for (const file of [source, config]) {
    const digest = createHash("sha256")
      .update(await readFile(file))
      .digest("hex");

    entries.push(`${digest}  ${relative(file)}`);
  }

  return `${entries.join("\n")}\n`;
};

const expected = await fingerprint();

if (process.argv.includes("--check")) {
  const actual = await readFile(fingerprintFile, "utf8").catch(() => null);

  if (actual !== expected) {
    console.error(
      actual === null
        ? `Missing ${relative(fingerprintFile)}.`
        : `${relative(outputWebp)} is stale: ${relative(source)} or ${relative(config)} changed after it was last rendered.`,
    );
    console.error("Run `npm run docs:diagram` and commit the result.");
    process.exit(1);
  }

  console.log(`${relative(outputWebp)} is up to date with its source.`);
} else {
  // Imported here rather than at the top so that --check stays usable without
  // Puppeteer's Chromium, which CI deliberately does not download.
  const { run } = await import("@mermaid-js/mermaid-cli");
  const { default: sharp } = await import("sharp");

  await mkdir(assetsDir, { recursive: true });

  const mermaidConfig = JSON.parse(await readFile(config, "utf8"));

  try {
    // mermaid-cli's `mmdc` entry point is a .cmd shim on Windows, and Node
    // refuses to spawn one without a shell: ".bat and .cmd files are not
    // executable on their own without a terminal, and therefore cannot be
    // launched using child_process.execFile()". Calling the package's own
    // run() sidesteps the shim, so this behaves the same on a Windows box as
    // on a Linux runner.
    await run(source, temporaryPng, {
      quiet: true,
      outputFormat: "png",
      // Chromium's sandbox cannot start under the unprivileged containers CI
      // runs in. The input is a trusted file from this repository, so dropping
      // the sandbox costs nothing here and keeps one render path everywhere.
      puppeteerConfig: { args: ["--no-sandbox", "--disable-setuid-sandbox"] },
      parseMMDOptions: {
        mermaidConfig,
        backgroundColor: "#090B10",
        // Mirrors `mmdc --width 1600 --scale 2`: the viewport is what the page
        // is captured at, and the device pixel ratio is what makes it sharp.
        viewport: { width: 1600, height: 600, deviceScaleFactor: 2 },
      },
    });

    await sharp(temporaryPng)
      .webp({ quality: 92, effort: 6, smartSubsample: true })
      .toFile(outputWebp);
  } finally {
    await rm(temporaryPng, { force: true });
  }

  await writeFile(fingerprintFile, expected);

  console.log(`Generated ${relative(outputWebp)}`);
}
