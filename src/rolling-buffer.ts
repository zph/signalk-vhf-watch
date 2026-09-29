import { pcmToWav, rmsLevel } from './wav'
import { discriminatorThreshold } from './squelch'

interface ReplayQualitySpan {
  bytes: number
  discriminatorNoise?: number
}

export interface ReplaySegment {
  id: number
  channel: string
  startedAt: string
  endedAt: string
  durationSeconds: number
  level: number
  wav: Buffer
  qualitySpans: ReplayQualitySpan[]
}

export type ReplaySegmentSummary = Omit<ReplaySegment, 'wav' | 'qualitySpans'> & {
  bytes: number
  minimumDiscriminatorNoise?: number
}

export class RollingReplay {
  readonly #sampleRate: number
  readonly #segmentBytes: number
  readonly #maxSegments: number
  #channel: string
  #pending = Buffer.alloc(0)
  #pendingQuality: ReplayQualitySpan[] = []
  #pendingStartedAt = Date.now()
  #sequence = 0
  #segments: ReplaySegment[] = []

  constructor(
    sampleRate: number,
    segmentSeconds: number,
    replayMinutes: number,
    channel: string,
    maxBytes = Number.POSITIVE_INFINITY
  ) {
    this.#sampleRate = sampleRate
    this.#segmentBytes = sampleRate * 2 * segmentSeconds
    const timeSegments = Math.ceil((replayMinutes * 60) / segmentSeconds)
    const memorySegments = Math.floor(maxBytes / (this.#segmentBytes + 44))
    this.#maxSegments = Math.max(1, Math.min(timeSegments, memorySegments))
    this.#channel = channel
  }

  setChannel(channel: string): void {
    this.flush()
    this.#channel = channel
    this.#pendingStartedAt = Date.now()
  }

  append(chunk: Buffer, receivedAt = Date.now(), discriminatorNoise?: number): ReplaySegment[] {
    if (chunk.length === 0) return []
    if (this.#pending.length === 0) this.#pendingStartedAt = receivedAt
    this.#pending = Buffer.concat([this.#pending, chunk])
    this.#pendingQuality.push({ bytes: chunk.length, ...(discriminatorNoise === undefined ? {} : { discriminatorNoise }) })
    const created: ReplaySegment[] = []
    while (this.#pending.length >= this.#segmentBytes) {
      const pcm = this.#pending.subarray(0, this.#segmentBytes)
      this.#pending = Buffer.from(this.#pending.subarray(this.#segmentBytes))
      created.push(this.#store(pcm, this.#pendingStartedAt, this.#takeQuality(pcm.length)))
      this.#pendingStartedAt += (pcm.length / 2 / this.#sampleRate) * 1000
    }
    return created
  }

  flush(): ReplaySegment | undefined {
    if (this.#pending.length < 2) return undefined
    const segment = this.#store(this.#pending, this.#pendingStartedAt, this.#takeQuality(this.#pending.length))
    this.#pending = Buffer.alloc(0)
    this.#pendingStartedAt = Date.now()
    return segment
  }

  list(): ReplaySegmentSummary[] {
    return this.#segments.slice().reverse().map(({ wav, qualitySpans, ...segment }) => {
      const measured = qualitySpans.flatMap((span) => span.discriminatorNoise === undefined ? [] : [span.discriminatorNoise])
      return {
        ...segment,
        bytes: wav.length,
        ...(measured.length === 0 ? {} : { minimumDiscriminatorNoise: Math.min(...measured) })
      }
    })
  }

  get(id: number): ReplaySegment | undefined {
    return this.#segments.find((segment) => segment.id === id)
  }

  wavFor(id: number, squelch: number): Buffer | undefined {
    const segment = this.get(id)
    if (!segment) return undefined
    if (squelch <= 0 || segment.qualitySpans.length === 0) return segment.wav
    const wav = Buffer.from(segment.wav)
    const threshold = discriminatorThreshold(squelch)
    let offset = 44
    for (const span of segment.qualitySpans) {
      if (span.discriminatorNoise !== undefined && span.discriminatorNoise >= threshold) {
        wav.fill(0, offset, offset + span.bytes)
      }
      offset += span.bytes
    }
    return wav
  }

  clear(): void {
    this.#segments = []
    this.#pending = Buffer.alloc(0)
    this.#pendingQuality = []
  }

  #takeQuality(byteLength: number): ReplayQualitySpan[] {
    const taken: ReplayQualitySpan[] = []
    let remaining = byteLength
    while (remaining > 0 && this.#pendingQuality.length > 0) {
      const span = this.#pendingQuality[0]!
      const bytes = Math.min(remaining, span.bytes)
      taken.push({ bytes, ...(span.discriminatorNoise === undefined ? {} : { discriminatorNoise: span.discriminatorNoise }) })
      span.bytes -= bytes
      remaining -= bytes
      if (span.bytes === 0) this.#pendingQuality.shift()
    }
    return taken
  }

  #store(pcm: Buffer, startedAtMs: number, qualitySpans: ReplayQualitySpan[]): ReplaySegment {
    const durationSeconds = pcm.length / 2 / this.#sampleRate
    const segment: ReplaySegment = {
      id: ++this.#sequence,
      channel: this.#channel,
      startedAt: new Date(startedAtMs).toISOString(),
      endedAt: new Date(startedAtMs + durationSeconds * 1000).toISOString(),
      durationSeconds,
      level: rmsLevel(pcm),
      wav: pcmToWav(pcm, this.#sampleRate),
      qualitySpans
    }
    this.#segments.push(segment)
    if (this.#segments.length > this.#maxSegments) this.#segments.splice(0, this.#segments.length - this.#maxSegments)
    return segment
  }
}
