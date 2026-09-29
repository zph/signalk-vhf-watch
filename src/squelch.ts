export function discriminatorThreshold(squelch: number): number {
  if (squelch <= 0) return Number.POSITIVE_INFINITY
  return Math.max(0.05, 0.6 - squelch * 0.0125)
}
