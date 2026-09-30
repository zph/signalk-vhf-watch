export type PlaybackCleanup = 'raw' | 'voice' | 'strong' | 'rnnoise'

export function parsePlaybackCleanup(value: unknown): PlaybackCleanup {
  return value === 'voice' || value === 'strong' || value === 'rnnoise' ? value : 'raw'
}

export class PlaybackCleaner {
  readonly #sampleRate: number
  readonly #mode: PlaybackCleanup
  readonly #highPassAlpha: number
  readonly #lowPassAlpha: number
  readonly #squelchThreshold: number
  #previousInput = 0
  #highPass = 0
  #previousHighPass = 0
  #highPass2 = 0
  #lowPass = 0
  #lowPass2 = 0
  #noiseFloor = 0
  #gain = 1
  #squelchHoldBlocks = 0

  constructor(sampleRate: number, mode: PlaybackCleanup, squelch = 0) {
    this.#sampleRate = sampleRate
    this.#mode = mode
    const highPassHz = mode === 'strong' ? 350 : 250
    const lowPassHz = mode === 'strong' ? 2_400 : 3_200
    const dt = 1 / sampleRate
    const highPassRc = 1 / (2 * Math.PI * highPassHz)
    const lowPassRc = 1 / (2 * Math.PI * lowPassHz)
    this.#highPassAlpha = highPassRc / (highPassRc + dt)
    this.#lowPassAlpha = dt / (lowPassRc + dt)
    this.#squelchThreshold = Math.max(0, Math.min(100, squelch)) * 0.00075
  }

  process(pcm: Buffer): Buffer {
    if ((this.#mode === 'raw' && this.#squelchThreshold === 0) || pcm.length < 2) return pcm
    const output = Buffer.alloc(pcm.length)
    const blockSamples = Math.max(1, Math.round(this.#sampleRate * 0.01))
    for (let blockStart = 0; blockStart < pcm.length / 2; blockStart += blockSamples) {
      const blockEnd = Math.min(pcm.length / 2, blockStart + blockSamples)
      const filtered: number[] = []
      let sumSquares = 0
      for (let index = blockStart; index < blockEnd; index += 1) {
        const input = pcm.readInt16LE(index * 2) / 32768
        let cleaned = input
        if (this.#mode === 'voice' || this.#mode === 'strong') {
          this.#highPass = this.#highPassAlpha * (this.#highPass + input - this.#previousInput)
          this.#previousInput = input
          this.#highPass2 = this.#highPassAlpha * (this.#highPass2 + this.#highPass - this.#previousHighPass)
          this.#previousHighPass = this.#highPass
          this.#lowPass += this.#lowPassAlpha * (this.#highPass2 - this.#lowPass)
          this.#lowPass2 += this.#lowPassAlpha * (this.#lowPass - this.#lowPass2)
          cleaned = this.#lowPass2
        }
        filtered.push(cleaned)
        sumSquares += cleaned * cleaned
      }
      const rms = Math.sqrt(sumSquares / Math.max(1, filtered.length))
      if (this.#squelchThreshold > 0) {
        if (rms >= this.#squelchThreshold) this.#squelchHoldBlocks = 20
        else this.#squelchHoldBlocks = Math.max(0, this.#squelchHoldBlocks - 1)
      }
      const squelchGain = this.#squelchThreshold === 0 || this.#squelchHoldBlocks > 0 ? 1 : 0
      const cleanupGain = this.#mode === 'strong' ? this.#strongGain(rms) : 1
      const targetGain = squelchGain * cleanupGain
      for (const [offset, sample] of filtered.entries()) {
        this.#gain += (targetGain - this.#gain) * (targetGain > this.#gain ? 0.18 : 0.08)
        const boost = this.#mode === 'strong' ? 1.45 : this.#mode === 'voice' ? 1.2 : 1
        const boosted = sample * this.#gain * boost
        const limited = Math.max(-1, Math.min(1, boosted))
        output.writeInt16LE(Math.round(limited * 32767), (blockStart + offset) * 2)
      }
    }
    return output
  }

  #strongGain(rms: number): number {
    const maximumNoiseFloor = 0.012
    if (this.#noiseFloor === 0) this.#noiseFloor = Math.min(maximumNoiseFloor, Math.max(rms, 1 / 32768))
    else if (rms < this.#noiseFloor) this.#noiseFloor = this.#noiseFloor * 0.8 + rms * 0.2
    else this.#noiseFloor = Math.min(maximumNoiseFloor, this.#noiseFloor * 0.995 + rms * 0.005)
    const ratio = rms / Math.max(this.#noiseFloor, 1 / 32768)
    if (ratio <= 1.25) return 0.16
    if (ratio >= 2.5) return 1
    return 0.16 + (ratio - 1.25) / 1.25 * 0.84
  }
}

export function cleanPlaybackPcm(pcm: Buffer, sampleRate: number, mode: PlaybackCleanup): Buffer {
  return new PlaybackCleaner(sampleRate, mode).process(pcm)
}

export function cleanArchivedPlaybackPcm(pcm: Buffer, sampleRate: number, mode: PlaybackCleanup, squelch: number): Buffer {
  return new PlaybackCleaner(sampleRate, mode, squelch).process(pcm)
}
