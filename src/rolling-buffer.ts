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

export interface ReplayPlaybackCursor {
  id: number
  slot: 'A' | 'B'
  channel: string
  startedAt: string
  consumedBytes: number
}

export interface ReplayPlaybackPayload {
  id: number
  slot: 'A' | 'B'
  channel: string
  startedAt: string
  pcm: Buffer
  qualitySpans: ReplayQualitySpan[]
}

export type ReplayPlaybackRead =
  | { kind: 'chunk'; cursor: ReplayPlaybackCursor; payload: ReplayPlaybackPayload; pcm: Buffer; qualitySpans?: ReplayQualitySpan[]; after?: { kind: 'advance'; cursor: ReplayPlaybackCursor } | { kind: 'edge' } | { kind: 'channel-change' } }
  | { kind: 'edge'; cursor: ReplayPlaybackCursor }
  | { kind: 'advance'; cursor: ReplayPlaybackCursor }
  | { kind: 'end'; reason: 'retired' | 'channel-change' | 'decode-failed' }

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
  #pendingLength = 0
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

  append(chunk: Buffer, receivedAt = Date.now(), discriminatorNoise?: number, qualitySpans?: ReplayQualitySpan[]): ReplaySegment[] {
    if (chunk.length === 0) return []
    this.#prune(receivedAt)
    const appendedQuality = qualitySpans?.length
      ? this.#sliceQuality(qualitySpans, 0, chunk.length)
      : [{ bytes: chunk.length, ...(discriminatorNoise === undefined ? {} : { discriminatorNoise }) }]
    if (appendedQuality.reduce((sum, span) => sum + span.bytes, 0) !== chunk.length) {
      throw new Error('Replay quality spans must cover the supplied PCM exactly')
    }
    if (this.#pendingLength === 0) this.#pendingStartedAt = receivedAt
    const created: ReplaySegment[] = []
    this.#copyPending(chunk, appendedQuality, created)
    if (this.#pendingHasSignal && this.#pendingQuietBytes >= this.#breakQuietBytes) {
      const segment = this.flush()
      if (segment) created.push(segment)
    }
    return created
  }

  insert(chunk: Buffer, startedAt: number, discriminatorNoise?: number): ReplaySegment | undefined {
    if (chunk.length < 2) return undefined
    // Materialize any newer live audio first so its public id remains stable when
    // the retrospectively demodulated segment is inserted ahead of it.
    this.flush()
    this.#sequence += this.#sequenceStep
    const quality = [{ bytes: chunk.length, ...(discriminatorNoise === undefined ? {} : { discriminatorNoise }) }]
    const segment = this.#createSegment(this.#sequence, chunk, startedAt, quality)
    this.#segments.push(segment)
    this.#segments.sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt))
    this.#encodeOpus(segment)
    this.#prune(Math.max(Date.now(), Date.parse(segment.endedAt)))
    return segment
  }

  prepend(chunk: Buffer, startedAt: number, discriminatorNoise?: number, qualitySpans?: ReplayQualitySpan[]): ReplaySegment[] {
    if (chunk.length < 2) return []
    if (this.#pendingLength === 0) {
      return this.append(chunk, startedAt, discriminatorNoise, qualitySpans)
    }
    // Keep the live samples at the handoff and trim any duplicated recovered
    // samples. The pending segment keeps its existing public playback id.
    const prefixBytes = Math.min(chunk.length, Math.max(0,
      Math.floor((this.#pendingStartedAt - startedAt) * this.#sampleRate / 1000) * 2))
    if (prefixBytes === 0) return []
    const prefixQuality = qualitySpans?.length
      ? this.#sliceQuality(qualitySpans, 0, prefixBytes)
      : [{ bytes: prefixBytes, ...(discriminatorNoise === undefined ? {} : { discriminatorNoise }) }]
    if (prefixQuality.reduce((sum, span) => sum + span.bytes, 0) !== prefixBytes) {
      throw new Error('Replay quality spans must cover the supplied PCM exactly')
    }
    const previousPending = Buffer.from(this.#pending.subarray(0, this.#pendingLength))
    const previousQuality = this.#pendingQuality.map((span) => ({ ...span }))
    this.#pendingLength = 0
    this.#pendingQuality = []
    this.#pendingStartedAt = startedAt
    const created: ReplaySegment[] = []
    this.#copyPending(chunk.subarray(0, prefixBytes), prefixQuality, created)
    this.#copyPending(previousPending, previousQuality, created)
    this.#recomputeBreakState()
    return created
  }

  flush(): ReplaySegment | undefined {
    if (this.#pendingLength < 2) return undefined
    const segment = this.#store(
      this.#pending.subarray(0, this.#pendingLength), this.#pendingStartedAt, this.#takeQuality(this.#pendingLength)
    )
    this.#pendingLength = 0
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
      (this.#pendingLength >= 2 && id === this.#sequence + this.#sequenceStep ? this.#pendingSegment() : undefined)
  }

  /** Number of retained records, including live pending audio, without materializing it. */
  get segmentCount(): number {
    return this.#segments.length + (this.#pendingLength >= 2 ? 1 : 0)
  }

  /** Capture an immutable raw snapshot synchronously before a replay-to-live handoff. */
  snapshotFrom(id: number): ReplaySegment[] | undefined {
    const pending = this.#pendingSegment()
    const segments = pending ? [...this.#segments, pending] : this.#segments
    const start = segments.findIndex((segment) => segment.id === id)
    if (start < 0) return undefined
    const channel = segments[start]!.channel
    const contiguous: ReplaySegment[] = []
    for (const segment of segments.slice(start)) {
      if (segment.channel !== channel) break
      contiguous.push(segment)
    }
    return contiguous.map((segment) => ({
      ...segment,
      // Stored payload buffers are immutable; retain references instead of duplicating
      // an entire rolling archive on the event loop. Pending audio is materialized above.
      wav: segment.wav,
      ...(segment.opus ? { opus: segment.opus } : {}),
      qualitySpans: segment.qualitySpans.map((span) => ({ ...span }))
    }))
  }

  async snapshotPcm(segment: ReplaySegment): Promise<Buffer | undefined> {
    if (segment.wav.length >= 44) return segment.wav.subarray(44)
    const decoded = await this.#decodeOpus(segment)
    return decoded ? Buffer.from(decoded) : undefined
  }

  playbackCursor(id: number): ReplayPlaybackCursor | undefined {
    const segment = this.get(id)
    if (!segment) return undefined
    return { id: segment.id, slot: segment.slot, channel: segment.channel, startedAt: segment.startedAt, consumedBytes: 0 }
  }

  /** Read at most one small, immutable slice from the current retained segment. */
  async readPlaybackCursor(
    cursor: ReplayPlaybackCursor,
    maximumBytes = 64_000,
    prepared?: ReplayPlaybackPayload
  ): Promise<ReplayPlaybackRead> {
    const segment = this.get(cursor.id)
    if (!segment || segment.startedAt !== cursor.startedAt) return { kind: 'end', reason: 'retired' }
    if (segment.channel !== cursor.channel || segment.slot !== cursor.slot) return { kind: 'end', reason: 'channel-change' }
    let payload = prepared
    const segmentBytes = segment.wav.length >= 44
      ? segment.wav.length - 44
      : Math.round(segment.durationSeconds * this.#sampleRate) * 2
    if (!payload || payload.id !== cursor.id || payload.startedAt !== cursor.startedAt || payload.pcm.length < segmentBytes) {
      const snapshot: ReplaySegment = {
        ...segment,
        wav: segment.wav,
        ...(segment.opus ? { opus: segment.opus } : {}),
        qualitySpans: segment.qualitySpans.map((span) => ({ ...span }))
      }
      const pcm = snapshot.wav.length >= 44 ? snapshot.wav.subarray(44) : await this.#decodeOpus(snapshot)
      if (!pcm) return { kind: 'end', reason: 'decode-failed' }
      payload = {
        id: cursor.id, slot: cursor.slot, channel: cursor.channel, startedAt: cursor.startedAt,
        pcm, qualitySpans: snapshot.qualitySpans
      }
    }
    const current = this.get(cursor.id)
    if (!current || current.startedAt !== cursor.startedAt) return { kind: 'end', reason: 'retired' }
    if (current.channel !== cursor.channel || current.slot !== cursor.slot) return { kind: 'end', reason: 'channel-change' }
    if (cursor.consumedBytes > payload.pcm.length) return { kind: 'end', reason: 'retired' }
    const limit = Math.max(2, Math.floor(maximumBytes / 2) * 2)
    const end = Math.min(payload.pcm.length, cursor.consumedBytes + limit)
    if (end > cursor.consumedBytes) {
      const nextCursor = { ...cursor, consumedBytes: end }
      const qualitySpans = this.#sliceQuality(payload.qualitySpans, cursor.consumedBytes, end)
      let after: Extract<ReplayPlaybackRead, { kind: 'chunk' }>['after']
      const pending = this.#pendingLength >= 2 && cursor.id === this.#sequence + this.#sequenceStep
      if (!pending && end === segmentBytes && end === payload.pcm.length) {
        const next = this.#nextAfter(cursor.id)
        after = next
          ? next.channel === cursor.channel
            ? { kind: 'advance', cursor: { ...cursor, id: next.id, startedAt: next.startedAt, consumedBytes: 0 } }
            : { kind: 'channel-change' }
          : { kind: 'edge' }
      }
      return {
        kind: 'chunk', cursor: nextCursor, payload, pcm: payload.pcm.subarray(cursor.consumedBytes, end),
        ...(qualitySpans.reduce((sum, span) => sum + span.bytes, 0) === end - cursor.consumedBytes ? { qualitySpans } : {}),
        ...(after ? { after } : {})
      }
    }
    if (this.#pendingLength >= 2 && cursor.id === this.#sequence + this.#sequenceStep) {
      return { kind: 'edge', cursor }
    }
    const next = this.#nextAfter(cursor.id)
    if (!next) return { kind: 'edge', cursor }
    if (next.channel !== cursor.channel) return { kind: 'end', reason: 'channel-change' }
    return { kind: 'advance', cursor: { ...cursor, id: next.id, startedAt: next.startedAt, consumedBytes: 0 } }
  }

  /** Synchronous edge check to pair atomically with a runtime audio listener. */
  playbackCursorHasData(cursor: ReplayPlaybackCursor): boolean {
    const segment = this.get(cursor.id)
    if (!segment || segment.startedAt !== cursor.startedAt) return true
    const sampleBytes = segment.wav.length >= 44 ? segment.wav.length - 44 : Math.round(segment.durationSeconds * this.#sampleRate) * 2
    if (sampleBytes > cursor.consumedBytes) return true
    const next = this.#nextAfter(cursor.id)
    return next !== undefined
  }

  playbackCursorSuccessor(cursor: ReplayPlaybackCursor): ReplayPlaybackCursor | undefined {
    const current = this.get(cursor.id)
    if (!current || current.startedAt !== cursor.startedAt || current.channel !== cursor.channel) return undefined
    const next = this.#nextAfter(cursor.id)
    if (!next || next.channel !== cursor.channel) return undefined
    return { ...cursor, id: next.id, startedAt: next.startedAt, consumedBytes: 0 }
  }

  #nextAfter(id: number): ReplaySegment | undefined {
    const pending = this.#pendingSegment()
    const segments = pending ? [...this.#segments, pending] : this.#segments
    const current = segments.find((segment) => segment.id === id)
    if (!current) return undefined
    const index = segments.indexOf(current)
    return segments[index + 1]
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
      if (this.#pendingLength < 2 || id !== this.#sequence + this.#sequenceStep) return false
      this.#pendingLength = 0
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
    this.#pendingLength = 0
    this.#pendingQuality = []
    this.#pendingHasSignal = false
    this.#pendingQuietBytes = 0
  }

  #takeQuality(byteLength: number): ReplayQualitySpan[] {
    const taken: ReplayQualitySpan[] = []
    let remaining = byteLength
    let consumed = 0
    while (remaining > 0 && consumed < this.#pendingQuality.length) {
      const span = this.#pendingQuality[consumed]!
      const bytes = Math.min(remaining, span.bytes)
      taken.push({ bytes, ...(span.discriminatorNoise === undefined ? {} : { discriminatorNoise: span.discriminatorNoise }) })
      span.bytes -= bytes
      remaining -= bytes
      if (span.bytes === 0) consumed += 1
      else break
    }
    if (consumed > 0) this.#pendingQuality.splice(0, consumed)
    return taken
  }

  /** Copy incoming PCM once into a bounded segment buffer, materializing only completed segments. */
  #copyPending(chunk: Buffer, quality: ReplayQualitySpan[], created: ReplaySegment[]): void {
    let offset = 0
    let qualityIndex = 0
    let qualityOffset = 0
    while (offset < chunk.length) {
      if (this.#pending.length === 0) this.#pending = Buffer.alloc(this.#segmentBytes)
      const bytes = Math.min(this.#segmentBytes - this.#pendingLength, chunk.length - offset)
      const end = offset + bytes
      this.#pending.set(chunk.subarray(offset, end), this.#pendingLength)
      const appendedQuality: ReplayQualitySpan[] = []
      while (offset < end) {
        const span = quality[qualityIndex]
        if (!span) throw new Error('Replay quality spans must cover the supplied PCM exactly')
        const copied = Math.min(end - offset, span.bytes - qualityOffset)
        appendedQuality.push({
          bytes: copied,
          ...(span.discriminatorNoise === undefined ? {} : { discriminatorNoise: span.discriminatorNoise })
        })
        offset += copied
        qualityOffset += copied
        if (qualityOffset === span.bytes) {
          qualityIndex += 1
          qualityOffset = 0
        }
      }
      this.#pendingQuality.push(...appendedQuality)
      this.#recordBreakState(appendedQuality)
      this.#pendingLength += bytes
      if (this.#pendingLength === this.#segmentBytes) {
        const pcm = this.#pending.subarray(0, this.#pendingLength)
        created.push(this.#store(pcm, this.#pendingStartedAt, this.#takeQuality(this.#pendingLength)))
        this.#pendingLength = 0
        this.#pendingStartedAt += (pcm.length / 2 / this.#sampleRate) * 1000
        this.#recomputeBreakState()
      }
    }
  }

  #sliceQuality(spans: ReplayQualitySpan[], start: number, end: number): ReplayQualitySpan[] {
    const sliced: ReplayQualitySpan[] = []
    let offset = 0
    for (const span of spans) {
      const spanStart = offset
      const spanEnd = spanStart + span.bytes
      const bytes = Math.max(0, Math.min(end, spanEnd) - Math.max(start, spanStart))
      if (bytes > 0) sliced.push({ bytes,
        ...(span.discriminatorNoise === undefined ? {} : { discriminatorNoise: span.discriminatorNoise }) })
      offset = spanEnd
      if (offset >= end) break
    }
    return sliced
  }

  #recordBreakState(spans: ReplayQualitySpan[]): void {
    if (this.#breakSquelch === undefined) return
    for (const span of spans) {
      const open = span.discriminatorNoise === undefined || span.discriminatorNoise < discriminatorThreshold(this.#breakSquelch)
      if (open) {
        this.#pendingHasSignal = true
        this.#pendingQuietBytes = 0
      } else if (this.#pendingHasSignal) this.#pendingQuietBytes += span.bytes
    }
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
    if (this.#pendingLength < 2) return undefined
    return this.#createSegment(
      this.#sequence + this.#sequenceStep,
      this.#pending.subarray(0, this.#pendingLength),
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
