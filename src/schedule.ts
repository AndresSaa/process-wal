/**
 * Automatic compaction is the one policy this package has — everything else is
 * mechanism the caller drives. Keeping it here says so, and keeps the two
 * things it has to get right in one place: the timer must never hold a process
 * open, and a failure nobody awaited must still be heard.
 */
export function scheduleCompaction(
  compact: () => void,
  intervalMs: number,
): NodeJS.Timeout {
  const timer = setInterval(() => {
    try {
      compact();
    } catch (error) {
      // Nobody is waiting on this call, so swallowing it would let the log grow
      // unbounded with no signal. A warning reaches stderr by default without
      // killing a process whose durability is still intact.
      process.emitWarning(
        `automatic compaction failed: ${(error as Error).message}`,
        "ProcessWalWarning",
      );
    }
  }, intervalMs);
  timer.unref();
  return timer;
}
