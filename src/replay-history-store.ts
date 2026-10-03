import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { SpectrumActivityEvent } from './activity-log'
import type { ReplaySegment } from './rolling-buffer'

interface StoredSegment extends Omit<ReplaySegment, 'wav' | 'opus'> {
  wavBytes: number
  opusBytes: number
  transcription?: ReplaySegment['transcription']
}

interface Manifest {
  version: 1
  savedAt: string
  segments: StoredSegment[]
  activityEvents: SpectrumActivityEvent[]
}

export interface ReplayHistorySnapshot {
  segments: ReplaySegment[]
  activityEvents: SpectrumActivityEvent[]
}

/** Durable copy of the current rolling replay window and RF activity timeline. */
export class ReplayHistoryStore {
  readonly #directory: string
  readonly #manifestPath: string
  readonly #ttlMs: number
  readonly #maximumBytes: number
  readonly #onError: (error: unknown) => void
  #pending?: ReplayHistorySnapshot
  #writing?: Promise<void>
  readonly #writtenPayloads = new Map<string, { wav?: Buffer; opus?: Buffer }>()

  constructor(directory: string, ttlMinutes: number, maximumBytes: number, onError: (error: unknown) => void = console.warn) {
    this.#directory = directory
    this.#manifestPath = path.join(directory, 'manifest.json')
    this.#ttlMs = ttlMinutes * 60_000
    this.#maximumBytes = maximumBytes
    this.#onError = onError
  }

  load(now = Date.now()): ReplayHistorySnapshot {
    let manifest: Manifest
    try {
      mkdirSync(this.#directory, { recursive: true })
      manifest = JSON.parse(readFileSync(this.#manifestPath, 'utf8')) as Manifest
      if (manifest.version !== 1 || !Array.isArray(manifest.segments) || !Array.isArray(manifest.activityEvents)) {
        throw new Error('Unsupported replay history manifest')
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.#onError(new Error(`Ignoring invalid VHF replay history: ${String(error)}`))
      return { segments: [], activityEvents: [] }
    }

    const segments: ReplaySegment[] = []
    let retainedBytes = 0
    const validRecords = manifest.segments.slice().reverse()
    for (const stored of validRecords) {
      try {
        const payloadBytes = stored?.wavBytes + stored?.opusBytes
        if (!this.#validMetadata(stored) || payloadBytes > this.#maximumBytes || retainedBytes + payloadBytes > this.#maximumBytes) continue
        const wavPath = this.#payloadPath(stored, 'wav')
        const opusPath = this.#payloadPath(stored, 'opus')
        if ((stored.wavBytes > 0 && statSync(wavPath).size !== stored.wavBytes) ||
          (stored.opusBytes > 0 && statSync(opusPath).size !== stored.opusBytes)) continue
        const wav = stored.wavBytes > 0 ? readFileSync(wavPath) : Buffer.alloc(0)
        const opus = stored.opusBytes > 0 ? readFileSync(opusPath) : undefined
        if (wav.length !== stored.wavBytes || (stored.opusBytes > 0 && opus?.length !== stored.opusBytes) || (!wav.length && !opus?.length)) continue
        const transcription = stored.transcription && ['queued', 'transcribing'].includes(stored.transcription.status)
          ? { status: 'skipped' as const, text: stored.transcription.text, error: 'Interrupted by Signal K restart' }
          : stored.transcription
        const { wavBytes: _wavBytes, opusBytes: _opusBytes, ...metadata } = stored
        segments.push({ ...metadata, wav, ...(opus ? { opus } : {}), ...(transcription ? { transcription } : {}) })
        retainedBytes += payloadBytes
      } catch (error) {
        this.#onError(new Error(`Skipping unreadable VHF replay segment ${stored.slot}:${stored.id}: ${String(error)}`))
      }
    }
    const expected = new Set(segments.flatMap((record) => [
      path.basename(this.#payloadPath(record, 'wav')), path.basename(this.#payloadPath(record, 'opus'))
    ]))
    try {
      for (const filename of readdirSync(this.#directory)) {
        if ((filename.endsWith('.wav') || filename.endsWith('.opus')) && !expected.has(filename)) {
          unlinkSync(path.join(this.#directory, filename))
        }
      }
    } catch (error) {
      this.#onError(new Error(`Could not clean VHF replay history files: ${String(error)}`))
    }
    const cutoff = now - this.#ttlMs
    const checkpoint = Number.isFinite(Date.parse(manifest.savedAt)) ? manifest.savedAt : new Date(now).toISOString()
    const activityEvents = manifest.activityEvents
      .filter((event) => Boolean(event && Number.isSafeInteger(event.id) && event.id > 0 &&
        typeof event.channel === 'string' && Number.isFinite(event.frequencyHz) && Number.isFinite(event.score) &&
        Number.isFinite(Date.parse(event.startedAt)) && (event.endedAt === undefined || Number.isFinite(Date.parse(event.endedAt))))
      )
      .map((event) => ({ ...event, ...(event.endedAt ? {} : { endedAt: checkpoint }) }))
      .filter((event) => Date.parse(event.endedAt!) >= cutoff)
    return this.#bound({ segments, activityEvents }, now)
  }

  schedule(snapshot: ReplayHistorySnapshot): void {
    this.#pending = snapshot
    if (!this.#writing) this.#writing = this.#drain()
  }

  async flush(): Promise<void> {
    while (this.#writing || this.#pending) {
      if (!this.#writing) this.#writing = this.#drain()
      await this.#writing
    }
  }

  async clear(): Promise<void> {
    this.schedule({ segments: [], activityEvents: [] })
    await this.flush()
  }

  async #drain(): Promise<void> {
    while (this.#pending) {
      const snapshot = this.#pending
      this.#pending = undefined
      try {
        await this.#writeSnapshot(snapshot)
      } catch (error) {
        this.#onError(error)
      }
    }
    this.#writing = undefined
  }

  async #writeSnapshot(snapshot: ReplayHistorySnapshot): Promise<void> {
    await mkdir(this.#directory, { recursive: true })
    const bounded = this.#bound(snapshot, Date.now())
    const records: StoredSegment[] = []
    const retainedKeys = new Set<string>()
    for (const segment of bounded.segments) {
      const wavBytes = segment.wav.length
      const opusBytes = segment.opus?.length ?? 0
      if (wavBytes + opusBytes > this.#maximumBytes || (wavBytes === 0 && opusBytes === 0)) continue
      const stored = {
        ...segment,
        wav: undefined,
        opus: undefined,
        ...(segment.transcription ? { transcription: segment.transcription } : {}),
        wavBytes,
        opusBytes
      } as unknown as StoredSegment
      const key = `${segment.slot}:${segment.id}`
      retainedKeys.add(key)
      const previous = this.#writtenPayloads.get(key)
      if (wavBytes > 0) {
        if (previous?.wav !== segment.wav || previous.wav?.length !== wavBytes) {
          await this.#writeAtomic(this.#payloadPath(stored, 'wav'), segment.wav)
        }
      } else await rm(this.#payloadPath(stored, 'wav'), { force: true })
      if (segment.opus) {
        if (previous?.opus !== segment.opus || previous.opus?.length !== opusBytes) {
          await this.#writeAtomic(this.#payloadPath(stored, 'opus'), segment.opus)
        }
      } else await rm(this.#payloadPath(stored, 'opus'), { force: true })
      this.#writtenPayloads.set(key, { ...(wavBytes ? { wav: segment.wav } : {}), ...(segment.opus ? { opus: segment.opus } : {}) })
      records.push(stored)
    }
    const manifest: Manifest = { version: 1, savedAt: new Date().toISOString(), segments: records, activityEvents: bounded.activityEvents }
    await this.#writeAtomic(this.#manifestPath, `${JSON.stringify(manifest)}\n`)
    const keep = new Set(records.flatMap((record) => [this.#payloadPath(record, 'wav'), this.#payloadPath(record, 'opus')]))
    for (const key of this.#writtenPayloads.keys()) if (!retainedKeys.has(key)) this.#writtenPayloads.delete(key)
    for (const name of await readdir(this.#directory)) {
      const file = path.join(this.#directory, name)
      if (name.endsWith('.wav') || name.endsWith('.opus')) if (!keep.has(file)) await rm(file, { force: true })
    }
  }

  #bound(snapshot: ReplayHistorySnapshot, now: number): ReplayHistorySnapshot {
    const cutoff = now - this.#ttlMs
    const segments = snapshot.segments
      .filter((segment) => Date.parse(segment.endedAt) >= cutoff)
      .filter((segment) => segment.wav.length + (segment.opus?.length ?? 0) <= this.#maximumBytes &&
        (segment.wav.length > 0 || Boolean(segment.opus?.length)))
      .sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt))
    let bytes = segments.reduce((sum, segment) => sum + segment.wav.length + (segment.opus?.length ?? 0), 0)
    while (segments.length > 0 && bytes > this.#maximumBytes) {
      const removed = segments.shift()!
      bytes -= removed.wav.length + (removed.opus?.length ?? 0)
    }
    return {
      segments,
      activityEvents: snapshot.activityEvents.filter((event) => event.endedAt === undefined || Date.parse(event.endedAt) >= cutoff).slice(-5_000)
    }
  }

  #validMetadata(segment: StoredSegment): boolean {
    return Boolean(segment && (segment.slot === 'A' || segment.slot === 'B') && Number.isSafeInteger(segment.id) && segment.id > 0 &&
      typeof segment.channel === 'string' && segment.channel.length > 0 &&
      Number.isFinite(Date.parse(segment.startedAt)) && Number.isFinite(Date.parse(segment.endedAt)) &&
      Number.isFinite(segment.durationSeconds) && segment.durationSeconds > 0 && Number.isFinite(segment.level) &&
      Number.isSafeInteger(segment.wavBytes) && segment.wavBytes >= 0 && Number.isSafeInteger(segment.opusBytes) && segment.opusBytes >= 0 &&
      Array.isArray(segment.qualitySpans) && segment.qualitySpans.every((span) => Number.isSafeInteger(span.bytes) && span.bytes > 0 &&
        (span.discriminatorNoise === undefined || Number.isFinite(span.discriminatorNoise))) &&
      (!segment.transcription || (['queued', 'transcribing', 'complete', 'skipped', 'error'].includes(segment.transcription.status) &&
        typeof segment.transcription.text === 'string')))
  }

  #payloadPath(segment: Pick<ReplaySegment, 'slot' | 'id'>, extension: 'wav' | 'opus'): string {
    return path.join(this.#directory, `slot-${segment.slot}-${segment.id}.${extension}`)
  }

  async #writeAtomic(destination: string, data: string | Buffer): Promise<void> {
    const temporary = `${destination}.${process.pid}.${randomUUID()}.new`
    try {
      await writeFile(temporary, data, { mode: 0o600 })
      await rename(temporary, destination)
    } finally {
      await rm(temporary, { force: true })
    }
  }
}
