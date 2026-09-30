import { spawn } from 'node:child_process'
import { pcmToWav, rmsLevel } from './wav'
import { discriminatorThreshold } from './squelch'

export interface ReplayQualitySpan {
  bytes: number
  discriminatorNoise?: number
}

interface ReplayGateSpan {
  bytes: number
  open: boolean
}

export interface ReplayTranscription {
  status: 'queued' | 'transcribing' | 'complete' | 'skipped' | 'error'
  text: string
  error?: string
}

export interface ReplaySegment {
  id: number
  slot: 'A' | 'B'
  channel: string
  startedAt: string
  endedAt: string
  durationSeconds: number
  level: number
  wav: Buffer
  qualitySpans: ReplayQualitySpan[]
  opus?: Buffer
  transcription?: ReplayTranscription
}

export type ReplaySegmentSummary = Omit<ReplaySegment, 'wav' | 'qualitySpans'> & {
  bytes: number
  minimumDiscriminatorNoise?: number
  activity?: number[]
}

export class RollingReplay {
  readonly #sampleRate: number
  readonly #segmentBytes: number
  readonly #retentionMs: number
  readonly #maxBytes: number
  #channel: string
  #pending = Buffer.alloc(0)
  #pendingQuality: ReplayQualitySpan[] = []
  #pendingStartedAt = Date.now()
  #sequence = 0
  readonly #slot: 'A' | 'B'
  readonly #sequenceStep: number
  readonly #breakSquelch?: number
  readonly #breakQuietBytes: number
  readonly #opusCommand?: string
  #pendingHasSignal = false
  #pendingQuietBytes = 0
  #segments: ReplaySegment[] = []

  constructor(
    sampleRate: number,
    segmentSeconds: number,
    replayMinutes: number,
    channel: string,
    maxBytes = Number.POSITIVE_INFINITY,
    slot: 'A' | 'B' = 'A',
    sequenceStart = 0,
    sequenceStep = 1,
    breakSquelch?: number,
    opusCommand?: string
  ) {
    this.#sampleRate = sampleRate
    this.#segmentBytes = sampleRate * 2 * segmentSeconds
    this.#retentionMs = replayMinutes * 60 * 1_000
    this.#maxBytes = maxBytes
    this.#channel = channel
    this.#slot = slot
    this.#sequence = sequenceStart
    this.#sequenceStep = sequenceStep
    this.#breakSquelch = breakSquelch
    this.#opusCommand = opusCommand
    this.#breakQuietBytes = sampleRate * 2 * 6
  }

  setChannel(channel: string): void {
    this.flush()
    this.#channel = channel
    this.#pendingStartedAt = Date.now()
  }

  append(chunk: Buffer, receivedAt = Date.now(), discriminatorNoise?: number): ReplaySegment[] {
    if (chunk.length === 0) return []
    this.#prune(receivedAt)
    if (this.#pending.length === 0) this.#pendingStartedAt = receivedAt
    this.#pending = Buffer.concat([this.#pending, chunk])
    this.#pendingQuality.push({ bytes: chunk.length, ...(discriminatorNoise === undefined ? {} : { discriminatorNoise }) })
    if (this.#breakSquelch !== undefined && discriminatorNoise !== undefined) {
      if (discriminatorNoise < discriminatorThreshold(this.#breakSquelch)) {
        this.#pendingHasSignal = true
        this.#pendingQuietBytes = 0
      } else if (this.#pendingHasSignal) this.#pendingQuietBytes += chunk.length
    }
    const created: ReplaySegment[] = []
    while (this.#pending.length >= this.#segmentBytes) {
      const pcm = this.#pending.subarray(0, this.#segmentBytes)
      this.#pending = Buffer.from(this.#pending.subarray(this.#segmentBytes))
      created.push(this.#store(pcm, this.#pendingStartedAt, this.#takeQuality(pcm.length)))
      this.#pendingStartedAt += (pcm.length / 2 / this.#sampleRate) * 1000
      this.#recomputeBreakState()
    }
    if (this.#pendingHasSignal && this.#pendingQuietBytes >= this.#breakQuietBytes) {
      const segment = this.flush()
      if (segment) created.push(segment)
    }
    return created
  }

  flush(): ReplaySegment | undefined {
    if (this.#pending.length < 2) return undefined
    const segment = this.#store(this.#pending, this.#pendingStartedAt, this.#takeQuality(this.#pending.length))
    this.#pending = Buffer.alloc(0)
    this.#pendingStartedAt = Date.now()
    this.#pendingHasSignal = false
    this.#pendingQuietBytes = 0
    return segment
  }

  list(squelch?: number): ReplaySegmentSummary[] {
    this.#compact()
    const pending = this.#pendingSegment()
    const segments = pending ? [...this.#segments, pending] : this.#segments
    return segments.slice().reverse().map(({ wav, qualitySpans, opus, ...segment }) => {
      const measured = qualitySpans.flatMap((span) => span.discriminatorNoise === undefined ? [] : [span.discriminatorNoise])
      return {
        ...segment,
        bytes: opus?.length ?? wav.length,
        ...(measured.length === 0 ? {} : { minimumDiscriminatorNoise: Math.min(...measured) }),
        ...(squelch === undefined ? {} : {
          activity: this.#activity(qualitySpans, Math.round(segment.durationSeconds * this.#sampleRate * 2), squelch)
        })
      }
    })
  }

  get(id: number): ReplaySegment | undefined {
    return this.#segments.find((segment) => segment.id === id) ??
      (this.#pending.length >= 2 && id === this.#sequence + this.#sequenceStep ? this.#pendingSegment() : undefined)
  }

  async wavFor(id: number, squelch: number): Promise<Buffer | undefined> {
    const segment = this.get(id)
    if (!segment) return undefined
    const pcm = segment.wav.length >= 44
      ? Buffer.from(segment.wav.subarray(44))
      : await this.#decodeOpus(segment)
    if (!pcm) return undefined
    if (squelch <= 0 || segment.qualitySpans.length === 0) return pcmToWav(pcm, this.#sampleRate)
    let offset = 0
    for (const span of this.#gateSpans(segment.qualitySpans, squelch)) {
      if (!span.open) pcm.fill(0, offset, offset + span.bytes)
      offset += span.bytes
    }
    return pcmToWav(pcm, this.#sampleRate)
  }

  async *pcmFrom(id: number, squelch: number): AsyncGenerator<Buffer> {
    const pending = this.#pendingSegment()
    const segments = pending ? [...this.#segments, pending] : this.#segments
    const start = segments.findIndex((segment) => segment.id === id)
    if (start < 0) return
    const channel = segments[start]!.channel
    for (const segment of segments.slice(start)) {
      if (segment.channel !== channel) break
      const wav = await this.wavFor(segment.id, squelch)
      if (wav) yield wav.subarray(44)
    }
  }

  delete(id: number): boolean {
    const index = this.#segments.findIndex((segment) => segment.id === id)
    if (index < 0) {
      if (this.#pending.length < 2 || id !== this.#sequence + this.#sequenceStep) return false
      this.#pending = Buffer.alloc(0)
      this.#pendingQuality = []
      this.#pendingStartedAt = Date.now()
      this.#pendingHasSignal = false
      this.#pendingQuietBytes = 0
      this.#sequence += this.#sequenceStep
      return true
    }
    this.#segments.splice(index, 1)
    return true
  }

  clear(): void {
    this.#segments = []
    this.#pending = Buffer.alloc(0)
    this.#pendingQuality = []
    this.#pendingHasSignal = false
    this.#pendingQuietBytes = 0
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

  #recomputeBreakState(): void {
    this.#pendingHasSignal = false
    this.#pendingQuietBytes = 0
    if (this.#breakSquelch === undefined) return
    for (const span of this.#pendingQuality) {
      const open = span.discriminatorNoise === undefined || span.discriminatorNoise < discriminatorThreshold(this.#breakSquelch)
      if (open) {
        this.#pendingHasSignal = true
        this.#pendingQuietBytes = 0
      } else if (this.#pendingHasSignal) this.#pendingQuietBytes += span.bytes
    }
  }

  #activity(spans: ReplayQualitySpan[], byteLength: number, squelch: number, bins = 48): number[] {
    if (byteLength <= 0 || spans.length === 0) return Array(bins).fill(0)
    const active = Array<number>(bins).fill(0)
    const binBytes = byteLength / bins
    let spanStart = 0
    for (const span of this.#gateSpans(spans, squelch)) {
      const spanEnd = spanStart + span.bytes
      if (span.open) {
        const firstBin = Math.max(0, Math.floor(spanStart / binBytes))
        const lastBin = Math.min(bins - 1, Math.floor(Math.max(spanStart, spanEnd - 1) / binBytes))
        for (let index = firstBin; index <= lastBin; index += 1) {
          const overlap = Math.max(0, Math.min(spanEnd, (index + 1) * binBytes) - Math.max(spanStart, index * binBytes))
          active[index]! += overlap / binBytes
        }
      }
      spanStart = spanEnd
    }
    return active.map((value) => Math.round(Math.min(1, value) * 1_000) / 1_000)
  }

  #gateSpans(spans: ReplayQualitySpan[], squelch: number): ReplayGateSpan[] {
    if (squelch <= 0) return spans.map((span) => ({ bytes: span.bytes, open: true }))
    const threshold = discriminatorThreshold(squelch)
    const runs: ReplayGateSpan[] = []
    for (const span of spans) {
      const open = span.discriminatorNoise === undefined || span.discriminatorNoise < threshold
      const previous = runs[runs.length - 1]
      if (previous?.open === open) previous.bytes += span.bytes
      else runs.push({ bytes: span.bytes, open })
    }
    const minimumOpenBytes = this.#sampleRate * 2 * 0.2
    const hangBytes = this.#sampleRate * 2 * 0.15
    let gateOpen = false
    return runs.map((run, index) => {
      if (run.open) {
        if (!gateOpen) gateOpen = run.bytes >= minimumOpenBytes
        return { bytes: run.bytes, open: gateOpen }
      }
      const bridgesSignal = gateOpen && run.bytes <= hangBytes && runs[index + 1]?.open === true
      if (!bridgesSignal) gateOpen = false
      return { bytes: run.bytes, open: bridgesSignal }
    })
  }

  #store(pcm: Buffer, startedAtMs: number, qualitySpans: ReplayQualitySpan[]): ReplaySegment {
    this.#sequence += this.#sequenceStep
    const segment = this.#createSegment(this.#sequence, pcm, startedAtMs, qualitySpans)
    this.#segments.push(segment)
    this.#encodeOpus(segment)
    this.#prune(Date.parse(segment.endedAt))
    return segment
  }

  #prune(referenceMs: number): void {
    const oldestAllowed = referenceMs - this.#retentionMs
    while (this.#segments.length > 0 && Date.parse(this.#segments[0]!.endedAt) <= oldestAllowed) {
      this.#segments.shift()
    }
    if (!Number.isFinite(this.#maxBytes)) return
    let retainedBytes = this.#segments.reduce((total, segment) => total + (segment.opus?.length ?? segment.wav.length), 0)
    while (this.#segments.length > 1 && retainedBytes > this.#maxBytes) {
      const removed = this.#segments.shift()!
      retainedBytes -= removed.opus?.length ?? removed.wav.length
    }
  }

  #pendingSegment(): ReplaySegment | undefined {
    if (this.#pending.length < 2) return undefined
    return this.#createSegment(
      this.#sequence + this.#sequenceStep,
      this.#pending,
      this.#pendingStartedAt,
      this.#pendingQuality.map((span) => ({ ...span }))
    )
  }

  #createSegment(id: number, pcm: Buffer, startedAtMs: number, qualitySpans: ReplayQualitySpan[]): ReplaySegment {
    const durationSeconds = pcm.length / 2 / this.#sampleRate
    return {
      id,
      slot: this.#slot,
      channel: this.#channel,
      startedAt: new Date(startedAtMs).toISOString(),
      endedAt: new Date(startedAtMs + durationSeconds * 1000).toISOString(),
      durationSeconds,
      level: rmsLevel(pcm),
      wav: pcmToWav(pcm, this.#sampleRate),
      qualitySpans
    }
  }

  #encodeOpus(segment: ReplaySegment): void {
    if (!this.#opusCommand || segment.wav.length < 44) return
    const child = spawn(this.#opusCommand, [
      '-nostdin', '-hide_banner', '-loglevel', 'error',
      '-f', 's16le', '-ac', '1', '-ar', String(this.#sampleRate), '-i', 'pipe:0',
      '-c:a', 'libopus', '-application', 'voip', '-b:a', '24k', '-vbr', 'on',
      '-compression_level', '5', '-f', 'ogg', 'pipe:1'
    ], { stdio: ['pipe', 'pipe', 'ignore'] })
    const output: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => output.push(chunk))
    child.stdin.on('error', () => {})
    child.on('error', () => {})
    child.on('close', (code) => {
      if (code !== 0) return
      const opus = Buffer.concat(output)
      if (opus.length === 0) return
      segment.opus = opus
      this.#compact()
      this.#prune(Date.now())
    })
    child.stdin.end(segment.wav.subarray(44))
  }

  #decodeOpus(segment: ReplaySegment): Promise<Buffer | undefined> {
    if (!this.#opusCommand || !segment.opus) return Promise.resolve(undefined)
    const child = spawn(this.#opusCommand, [
      '-nostdin', '-hide_banner', '-loglevel', 'error',
      '-f', 'ogg', '-i', 'pipe:0',
      '-f', 's16le', '-acodec', 'pcm_s16le', '-ac', '1', '-ar', String(this.#sampleRate), 'pipe:1'
    ], { stdio: ['pipe', 'pipe', 'ignore'] })
    const output: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => output.push(chunk))
    child.stdin.on('error', () => {})
    child.stdin.end(segment.opus)
    return new Promise((resolve) => {
      child.on('error', () => resolve(undefined))
      child.on('close', (code) => resolve(code === 0 ? Buffer.concat(output) : undefined))
    })
  }

  #compact(): void {
    for (const segment of this.#segments) {
      const state = segment.transcription?.status
      if (segment.opus && (!state || state === 'complete' || state === 'skipped' || state === 'error')) {
        segment.wav = Buffer.alloc(0)
      }
    }
  }
}
