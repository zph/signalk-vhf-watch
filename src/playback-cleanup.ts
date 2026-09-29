export type PlaybackCleanup = 'raw' | 'voice' | 'strong'

export function parsePlaybackCleanup(value: unknown): PlaybackCleanup {
  return value === 'voice' || value === 'strong' ? value : 'raw'
}

export class PlaybackCleaner {
  readonly #sampleRate: number
  readonly #mode: PlaybackCleanup
  readonly #highPassAlpha: number
  readonly #lowPassAlpha: number
  #previousInput = 0
  #highPass = 0
  #previousHighPass = 0
  #highPass2 = 0
  #lowPass = 0
  #lowPass2 = 0
  #noiseFloor = 0
  #gain = 1

  constructor(sampleRate: number, mode: PlaybackCleanup) {
    this.#sampleRate = sampleRate
    this.#mode = mode
    const highPassHz = mode === 'strong' ? 350 : 250
    const lowPassHz = mode === 'strong' ? 2_400 : 3_200
    const dt = 1 / sampleRate
    const highPassRc = 1 / (2 * Math.PI * highPassHz)
    const lowPassRc = 1 / (2 * Math.PI * lowPassHz)
    this.#highPassAlpha = highPassRc / (highPassRc + dt)
    this.#lowPassAlpha = dt / (lowPassRc + dt)
  }

  process(pcm: Buffer): Buffer {
    if (this.#mode === 'raw' || pcm.length < 2) return pcm
    const output = Buffer.alloc(pcm.length)
    const blockSamples = Math.max(1, Math.round(this.#sampleRate * 0.01))
    for (let blockStart = 0; blockStart < pcm.length / 2; blockStart += blockSamples) {
      const blockEnd = Math.min(pcm.length / 2, blockStart + blockSamples)
      const filtered: number[] = []
      let sumSquares = 0
      for (let index = blockStart; index < blockEnd; index += 1) {
        const input = pcm.readInt16LE(index * 2) / 32768
        this.#highPass = this.#highPassAlpha * (this.#highPass + input - this.#previousInput)
        this.#previousInput = input
        this.#highPass2 = this.#highPassAlpha * (this.#highPass2 + this.#highPass - this.#previousHighPass)
        this.#previousHighPass = this.#highPass
        this.#lowPass += this.#lowPassAlpha * (this.#highPass2 - this.#lowPass)
        this.#lowPass2 += this.#lowPassAlpha * (this.#lowPass - this.#lowPass2)
        filtered.push(this.#lowPass2)
        sumSquares += this.#lowPass2 * this.#lowPass2
      }
      const rms = Math.sqrt(sumSquares / Math.max(1, filtered.length))
      const targetGain = this.#mode === 'strong' ? this.#strongGain(rms) : 1
      for (const [offset, sample] of filtered.entries()) {
        this.#gain += (targetGain - this.#gain) * (targetGain > this.#gain ? 0.18 : 0.08)
        const boosted = sample * this.#gain * (this.#mode === 'strong' ? 1.45 : 1.2)
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
