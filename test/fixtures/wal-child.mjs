import { createWal } from "../../dist/index.js";
import process from "node:process";
import { setInterval } from "node:timers";

const [mode, dir, count = "0"] = process.argv.slice(2);
const wal = createWal({
  dir,
  compactInterval: mode === "timer" ? 60_000 : null,
});

// Nothing here measures memory. The parent forks this under a heap ceiling far
// below the size of the log, so an implementation that materialises the log
// dies and one that streams it finishes. That is a fact about the run; a
// sampled RSS figure was a fact about when the collector last happened to run.
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
  const { pendingEntries } = wal.stats();
  wal.close();
  process.send?.({ pendingEntries });
  process.disconnect?.();
} else if (mode === "cursor") {
  let entries = 0;
  let lastSeq = 0;
  for await (const entry of wal.cursor()) {
    entries += 1;
    lastSeq = entry.seq;
  }
  wal.close();
  process.send?.({ entries, lastSeq });
  process.disconnect?.();
} else {
  process.send?.("ready");
  process.disconnect?.();
}
