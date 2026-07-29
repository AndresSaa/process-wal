import { createWal } from "../../dist/index.js";
import process from "node:process";
import { setInterval } from "node:timers";

const [mode, dir, count = "0"] = process.argv.slice(2);
const measured = mode === "cursor" || mode === "compact";
const baseline = measured ? process.memoryUsage.rss() : 0;
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
  wal.compact();
  // Sampled before anything else allocates, so a materializing compaction would
  // still be visible in RSS here rather than hidden by a later collection.
  const rssGrowth = process.memoryUsage.rss() - baseline;
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
