import { createWal } from "../../dist/index.js";
import process from "node:process";
import { setInterval } from "node:timers";

const [mode, dir, count = "0"] = process.argv.slice(2);
// Both memory probes below sample their baseline *after* createWal returns.
// Anchoring at process start would fold in Node's boot cost and whatever the
// open scan left uncollected — neither of which the operation under test
// allocates, and both of which drift between platforms and Node versions.
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
  const before = process.memoryUsage.rss();
  wal.compact();
  const rssGrowth = process.memoryUsage.rss() - before;
  wal.close();
  process.send?.({ rssGrowth });
  process.disconnect?.();
} else if (mode === "cursor") {
  const before = process.memoryUsage.rss();
  let peak = before;
  let entries = 0;
  let lastSeq = 0;
  for await (const entry of wal.cursor()) {
    entries += 1;
    lastSeq = entry.seq;
    peak = Math.max(peak, process.memoryUsage.rss());
  }
  wal.close();
  process.send?.({ entries, lastSeq, rssGrowth: peak - before });
  process.disconnect?.();
} else {
  process.send?.("ready");
  process.disconnect?.();
}
