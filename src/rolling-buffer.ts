import { pcmToWav, rmsLevel } from './wav'

export interface ReplaySegment {
  id: number
  channel: string
  startedAt: string
  endedAt: string
  durationSeconds: number
  level: number
  wav: Buffer
}

export type ReplaySegmentSummary = Omit<ReplaySegment, 'wav'> & { bytes: number }

export class RollingReplay {
  readonly #sampleRate: number
  readonly #segmentBytes: number
  readonly #maxSegments: number
  #channel: string
  #pending = Buffer.alloc(0)
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

  append(chunk: Buffer, receivedAt = Date.now()): ReplaySegment[] {
    if (chunk.length === 0) return []
    if (this.#pending.length === 0) this.#pendingStartedAt = receivedAt
    this.#pending = Buffer.concat([this.#pending, chunk])
    const created: ReplaySegment[] = []
    while (this.#pending.length >= this.#segmentBytes) {
      const pcm = this.#pending.subarray(0, this.#segmentBytes)
      this.#pending = Buffer.from(this.#pending.subarray(this.#segmentBytes))
      created.push(this.#store(pcm, this.#pendingStartedAt))
      this.#pendingStartedAt += (pcm.length / 2 / this.#sampleRate) * 1000
    }
    return created
  }

  flush(): ReplaySegment | undefined {
    if (this.#pending.length < 2) return undefined
    const segment = this.#store(this.#pending, this.#pendingStartedAt)
    this.#pending = Buffer.alloc(0)
    this.#pendingStartedAt = Date.now()
    return segment
  }

  list(): ReplaySegmentSummary[] {
    return this.#segments.slice().reverse().map(({ wav, ...segment }) => ({ ...segment, bytes: wav.length }))
  }

  get(id: number): ReplaySegment | undefined {
    return this.#segments.find((segment) => segment.id === id)
  }

  clear(): void {
    this.#segments = []
    this.#pending = Buffer.alloc(0)
  }

  #store(pcm: Buffer, startedAtMs: number): ReplaySegment {
    const durationSeconds = pcm.length / 2 / this.#sampleRate
    const segment: ReplaySegment = {
      id: ++this.#sequence,
      channel: this.#channel,
      startedAt: new Date(startedAtMs).toISOString(),
      endedAt: new Date(startedAtMs + durationSeconds * 1000).toISOString(),
      durationSeconds,
      level: rmsLevel(pcm),
      wav: pcmToWav(pcm, this.#sampleRate)
    }
    this.#segments.push(segment)
    if (this.#segments.length > this.#maxSegments) this.#segments.splice(0, this.#segments.length - this.#maxSegments)
    return segment
  }
}
