import { createWal } from "../../dist/index.js";
import process from "node:process";
import { setInterval } from "node:timers";

const [mode, dir, count = "0"] = process.argv.slice(2);
const baseline = mode === "cursor" ? process.memoryUsage.rss() : 0;
const wal = createWal({
  dir,
  compactInterval: mode === "timer" ? 60_000 : null,
});

if (mode === "append") {
  for (let index = 0; index < Number(count); index += 1) {
    wal.append({ index });
  }
  process.send?.("ready");
  process.disconnect?.();
  setInterval(() => {}, 60_000);
} else if (mode === "compact") {
  wal.checkpoint(Number(count));
  // Measured from here rather than from process start, so the figure is what
  // compaction itself allocates. Anchoring at startup would fold in Node's boot
  // and the open scan's uncollected garbage, which vary by platform and were
  // enough to push a passing run over the limit on Linux but not on Windows.
  const before = process.memoryUsage.rss();
  wal.compact();
  const rssGrowth = process.memoryUsage.rss() - before;
  wal.close();
  process.send?.({ rssGrowth });
  process.disconnect?.();
} else if (mode === "cursor") {
  let peak = Math.max(baseline, process.memoryUsage.rss());
  let entries = 0;
  let lastSeq = 0;
  for await (const entry of wal.cursor()) {
    entries += 1;
    lastSeq = entry.seq;
    peak = Math.max(peak, process.memoryUsage.rss());
  }
  wal.close();
  process.send?.({ entries, lastSeq, rssGrowth: peak - baseline });
  process.disconnect?.();
} else {
  process.send?.("ready");
  process.disconnect?.();
}
