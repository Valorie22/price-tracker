/**
 * Where does the line break?
 *
 * A gap in the price line means "a scrape was attempted here and its result was refused",
 * and the charts must draw it as a hole rather than joining across it. The question is how
 * big a hole has to be before it counts.
 *
 * The obvious answer — the product's configured scrape interval — is wrong in a way that
 * shows up the first time someone changes that interval. Switch a product from two-hourly
 * to half-hourly and every historical reading is suddenly further apart than "expected",
 * so the whole chart shatters into single dots even though nothing was ever missed.
 *
 * So the spacing is derived from the data: the median distance between consecutive
 * readings is what this series actually does, and anything meaningfully longer than that
 * is a hole. The configured interval is only the fallback when there are too few points
 * for a median to mean anything.
 */
export function breakThresholdMs(timestamps: number[], intervalMinutes: number): number {
  const fallback = intervalMinutes * 60_000 * 1.6;
  if (timestamps.length < 4) return fallback;

  const deltas: number[] = [];
  for (let i = 1; i < timestamps.length; i++) {
    const d = (timestamps[i] as number) - (timestamps[i - 1] as number);
    if (d > 0) deltas.push(d);
  }
  if (deltas.length < 3) return fallback;

  deltas.sort((a, b) => a - b);
  const median = deltas[Math.floor(deltas.length / 2)] as number;

  // 1.8x the median: one missed cycle opens a hole, ordinary scheduling jitter does not.
  return Math.max(median * 1.8, 60_000);
}

/** Split a series wherever the spacing exceeds the threshold. */
export function splitOnGaps<T>(items: T[], timeOf: (item: T) => number, thresholdMs: number): T[][] {
  const segments: T[][] = [];
  let current: T[] = [];
  for (const [i, item] of items.entries()) {
    const previous = items[i - 1];
    if (previous !== undefined && timeOf(item) - timeOf(previous) > thresholdMs) {
      if (current.length) segments.push(current);
      current = [];
    }
    current.push(item);
  }
  if (current.length) segments.push(current);
  return segments;
}
