export function discriminatorThreshold(squelch: number): number {
  if (squelch <= 0) return Number.POSITIVE_INFINITY
  // The native 9 kHz FIR channelizer measures idle discriminator noise near 0.31-0.34 and a
  // strong NOAA carrier near 0.05. Keep the default Medium setting comfortably between them.
  return Math.max(0.04, 0.38 - squelch * 0.008)
}
