import { spawn, type ChildProcess } from 'node:child_process'
import { accessSync, constants, existsSync, readFileSync, readdirSync, statSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { access } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ReplaySegment } from './rolling-buffer'
import { discriminatorThreshold } from './squelch'
import { TranscriptArchive, type TranscriptArchiveRecord, type TranscriptArchiveStatus } from './transcript-archive'
import type { NarrationManager } from './narration'
import type { RnnoiseDenoiser } from './rnnoise'
import { pcmToWav } from './wav'

export const DEFAULT_TRANSCRIPTION_COMMAND = '/usr/bin/vhf-whisper'
export const DEFAULT_TRANSCRIPTION_MODELS_DIR = '/usr/share/vhf-whisper'
export const DEFAULT_TRANSCRIPTION_MODEL = 'base.en-q5_1'
export const DEFAULT_TRANSCRIPTION_THREADS = 2
export const MAXIMUM_TRANSCRIPTION_THREADS = 16
export const MINIMUM_TRANSCRIPTION_SIGNAL_SECONDS = 0.35
export const TRANSCRIPTION_BATCH_SECONDS = 60
export const TRANSCRIPTION_OVERLAP_SECONDS = 10
export const TRANSCRIPTION_BATCH_IDLE_MS = 6_000
export const MINIMUM_TRANSCRIPTION_TIMEOUT_MS = 90_000
export const TRANSCRIPTION_TIMEOUT_AUDIO_MULTIPLIER = 2

export interface TranscriptionStatus {
  enabled: boolean
  available: boolean
  state: 'disabled' | 'unavailable' | 'idle' | 'transcribing'
  queued: number
  engine: string
  model: string
  threads: number
  availableModels: TranscriptionModel[]
  command: string
  archive?: TranscriptArchiveStatus
  error?: string
}

interface PersistedSettings {
  enabled: boolean
  model: string
  threads: number
}

export interface TranscriptionModel {
  id: string
  label: string
  bytes: number
}

interface TranscriptionBatch {
  segments: ReplaySegment[]
  durationSeconds: number
  overlapSegmentCount: number
  channel: string
}

interface TranscriptionOptions {
  batchSeconds?: number
  overlapSeconds?: number
  idleMs?: number
  archive?: TranscriptArchive
  modelsDir?: string
  denoiser?: RnnoiseDenoiser
}

interface TranscriptWord {
  original: string
  normalized: string
}

function transcriptWords(text: string): TranscriptWord[] {
  return text.split(/\s+/).flatMap((original) => {
    const normalized = original.toLocaleLowerCase().replace(/[^a-z0-9]/g, '')
    return normalized ? [{ original, normalized }] : []
  })
}

function wordEditDistance(left: string[], right: string[]): number {
  let previous = Array.from({ length: right.length + 1 }, (_value, index) => index)
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex]
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        previous[rightIndex]! + 1,
        current[rightIndex - 1]! + 1,
        previous[rightIndex - 1]! + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1)
      )
    }
    previous = current
  }
  return previous[right.length]!
}

export function reconcileTranscriptOverlap(previousText: string, currentText: string): string {
  const previousWords = transcriptWords(previousText)
  const currentWords = transcriptWords(currentText)
  const previous = previousWords.map((word) => word.normalized)
  const current = currentWords.map((word) => word.normalized)
  const maximum = Math.min(previous.length, current.length)
  let removeWords = 0
  let bestMatchedWords = 0
  let bestScore = Number.POSITIVE_INFINITY
  const compare = (previousCount: number, currentCount: number): void => {
    const suffix = previous.slice(-previousCount)
    const prefix = current.slice(0, currentCount)
    const distance = wordEditDistance(suffix, prefix)
    const score = distance / Math.max(suffix.length, prefix.length)
    const matchedWords = Math.min(suffix.length, prefix.length) - distance
    if (score <= 0.34 && (matchedWords > bestMatchedWords || (matchedWords === bestMatchedWords && score < bestScore))) {
      removeWords = currentCount
      bestMatchedWords = matchedWords
      bestScore = score
    }
  }

  // Normal capture windows overlap by ten seconds, so exhaustively check the
  // short suffix where minor Whisper wording changes are expected.
  const shortMaximum = Math.min(50, maximum)
  for (let previousCount = 4; previousCount <= shortMaximum; previousCount += 1) {
    const minimumCurrent = Math.max(4, previousCount - 5)
    const maximumCurrent = Math.min(maximum, previousCount + 5)
    for (let currentCount = minimumCurrent; currentCount <= maximumCurrent; currentCount += 1) {
      compare(previousCount, currentCount)
    }
  }

  // Older builds retained an entire long replay slice as overlap. Find long
  // suffix candidates from matching three-word anchors near the start of the
  // current transcript instead of doing an expensive all-pairs comparison.
  const longCandidates = new Set<number>([previous.length])
  for (let currentOffset = 0; currentOffset <= Math.min(8, current.length - 3); currentOffset += 1) {
    for (let previousOffset = 0; previousOffset <= previous.length - 3; previousOffset += 1) {
      if (
        current[currentOffset] === previous[previousOffset] &&
        current[currentOffset + 1] === previous[previousOffset + 1] &&
        current[currentOffset + 2] === previous[previousOffset + 2]
      ) {
        const overlapStart = previousOffset - currentOffset
        if (overlapStart >= 0) longCandidates.add(previous.length - overlapStart)
      }
    }
  }
  for (const previousCount of longCandidates) {
    if (previousCount <= shortMaximum || previousCount > maximum) continue
    const variance = Math.max(12, Math.ceil(previousCount * 0.12))
    for (
      let currentCount = Math.max(4, previousCount - variance);
      currentCount <= Math.min(maximum, previousCount + variance);
      currentCount += 1
    ) {
      compare(previousCount, currentCount)
    }
  }
  return currentWords.slice(removeWords).map((word) => word.original).join(' ').trim()
}

export function transcriptionTimeoutMs(durationSeconds: number): number {
  return Math.max(
    MINIMUM_TRANSCRIPTION_TIMEOUT_MS,
    Math.ceil(durationSeconds * TRANSCRIPTION_TIMEOUT_AUDIO_MULTIPLIER * 1_000)
  )
}

export function transcriptionActiveSeconds(segment: ReplaySegment, squelch: number): number {
  const pcmBytes = Math.max(0, segment.wav.length - 44)
  if (pcmBytes === 0) return 0
  if (segment.qualitySpans.length === 0) return segment.durationSeconds
  const threshold = discriminatorThreshold(squelch)
  const activeBytes = segment.qualitySpans.reduce((total, span) => (
    span.discriminatorNoise !== undefined && span.discriminatorNoise < threshold
      ? total + span.bytes
      : total
  ), 0)
  return activeBytes / pcmBytes * segment.durationSeconds
}

export function cleanWhisperOutput(output: string): string {
  return output
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\[BLANK_AUDIO\]/gi, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\[\d{2}:\d{2}:\d{2}\.\d{3}\s+-->\s+\d{2}:\d{2}:\d{2}\.\d{3}\]\s*/, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export class TranscriptionManager {
  readonly #settingsPath: string
  readonly #command: string
  readonly #batchSeconds: number
  readonly #overlapSeconds: number
  readonly #idleMs: number
  readonly #archive?: TranscriptArchive
  readonly #modelsDir: string
  readonly #denoiser?: RnnoiseDenoiser
  #enabled: boolean
  #model: string
  #threads: number
  #queue: TranscriptionBatch[] = []
  #pending: ReplaySegment[] = []
  #pendingSeconds = 0
  #pendingOverlapCount = 0
  #pendingTimer?: ReturnType<typeof setTimeout>
  #running = false
  #child?: ChildProcess
  #error?: string
  #closed = false
  #previousTranscript = new Map<string, string>()
  #narrator?: NarrationManager

  constructor(settingsPath: string, command = DEFAULT_TRANSCRIPTION_COMMAND, options: TranscriptionOptions = {}) {
    this.#settingsPath = settingsPath
    this.#command = command
    this.#batchSeconds = options.batchSeconds ?? TRANSCRIPTION_BATCH_SECONDS
    this.#overlapSeconds = Math.min(options.overlapSeconds ?? TRANSCRIPTION_OVERLAP_SECONDS, this.#batchSeconds / 2)
    this.#idleMs = options.idleMs ?? TRANSCRIPTION_BATCH_IDLE_MS
    this.#archive = options.archive
    this.#modelsDir = options.modelsDir ?? DEFAULT_TRANSCRIPTION_MODELS_DIR
    this.#denoiser = options.denoiser
    const settings = this.#load()
    this.#enabled = settings.enabled
    this.#model = settings.model
    this.#threads = settings.threads
    this.#repairArchivedTranscriptOverlap()
  }

  status(): TranscriptionStatus {
    const available = this.available()
    return {
      enabled: this.#enabled,
      available,
      state: !this.#enabled ? 'disabled' : !available ? 'unavailable' : this.#running ? 'transcribing' : 'idle',
      queued: this.#queue.length + (this.#pending.length > 0 ? 1 : 0),
      engine: `whisper.cpp ${this.#model}${this.#denoiser?.available() ? ' · RNNoise 50%' : ''}`,
      model: this.#model,
      threads: this.#threads,
      availableModels: this.availableModels(),
      command: this.#command,
      ...(this.#archive ? { archive: this.#archive.status() } : {}),
      ...(this.#error ? { error: this.#error } : {})
    }
  }

  available(): boolean {
    try {
      accessSync(this.#command, constants.X_OK)
      return this.availableModels().some((candidate) => candidate.id === this.#model)
    } catch {
      return false
    }
  }

  availableModels(): TranscriptionModel[] {
    try {
      return readdirSync(this.#modelsDir)
        .flatMap((filename) => {
          const match = /^ggml-([a-z0-9._-]+)\.bin$/i.exec(filename)
          if (!match) return []
          const id = match[1]!
          return [{ id, label: id.replaceAll('-', ' '), bytes: statSync(path.join(this.#modelsDir, filename)).size }]
        })
        .sort((left, right) => left.bytes - right.bytes || left.id.localeCompare(right.id))
    } catch {
      return []
    }
  }

  async configure(model: string, threads: number): Promise<TranscriptionStatus> {
    if (!this.availableModels().some((candidate) => candidate.id === model)) {
      throw new Error(`Whisper model ${model} is not installed`)
    }
    if (!Number.isSafeInteger(threads) || threads < 1 || threads > MAXIMUM_TRANSCRIPTION_THREADS) {
      throw new Error(`threads must be an integer from 1 to ${MAXIMUM_TRANSCRIPTION_THREADS}`)
    }
    this.#model = model
    this.#threads = threads
    this.#error = undefined
    this.#save()
    return this.status()
  }

  async setEnabled(enabled: boolean): Promise<TranscriptionStatus> {
    if (enabled) {
      try {
        await access(this.#command, constants.X_OK)
      } catch {
        throw new Error('Install the vhf-whisper-runtime package before enabling transcription')
      }
      if (!this.availableModels().some((candidate) => candidate.id === this.#model)) {
        throw new Error(`Install or select the Whisper model ${this.#model} before enabling transcription`)
      }
    }
    this.#enabled = enabled
    this.#error = undefined
    if (!enabled) {
      this.#queue = []
      this.#clearPending()
      this.#child?.kill('SIGTERM')
    }
    this.#save()
    return this.status()
  }

  enqueue(segment: ReplaySegment, squelch: number): void {
    if (!this.#enabled || !this.available()) return
    const activeSeconds = transcriptionActiveSeconds(segment, squelch)
    if (activeSeconds < MINIMUM_TRANSCRIPTION_SIGNAL_SECONDS) {
      segment.transcription = { status: 'skipped', text: '' }
      this.#flushPending()
      return
    }
    this.#narrator?.yield()
    const previous = this.#pending.at(-1)
    if (previous && (previous.channel !== segment.channel || Math.abs(Date.parse(segment.startedAt) - Date.parse(previous.endedAt)) > 500)) {
      this.#flushPending()
    }
    segment.transcription = { status: 'queued', text: '' }
    this.#pending.push(segment)
    this.#pendingSeconds += segment.durationSeconds
    if (this.#pendingSeconds >= this.#batchSeconds) this.#flushPending(true)
    else this.#schedulePending()
  }

  stop(): void {
    this.#queue = []
    this.#clearPending()
    this.#child?.kill('SIGTERM')
  }

  close(): void {
    if (this.#closed) return
    this.stop()
    this.#archive?.close()
    this.#closed = true
  }

  attachNarrator(narrator: NarrationManager): void {
    this.#narrator = narrator
    narrator.resume()
  }

  busy(): boolean {
    return this.#running || this.#queue.length > 0 || this.#pending.length > 0
  }

  archiveRecords(limit?: number): TranscriptArchiveRecord[] {
    return this.#archive?.list(limit) ?? []
  }

  archiveRecord(id: number): TranscriptArchiveRecord | undefined {
    return this.#archive?.record(id)
  }

  archiveWav(id: number): Buffer | undefined {
    return this.#archive?.wav(id)
  }

  #schedulePending(): void {
    if (this.#pendingTimer) clearTimeout(this.#pendingTimer)
    this.#pendingTimer = setTimeout(() => {
      this.#pendingTimer = undefined
      this.#flushPending()
    }, this.#idleMs)
    this.#pendingTimer.unref()
  }

  #flushPending(retainOverlap = false): void {
    if (this.#pendingTimer) clearTimeout(this.#pendingTimer)
    this.#pendingTimer = undefined
    if (this.#pending.length === 0) return
    if (this.#pending.length <= this.#pendingOverlapCount) {
      this.#clearPending()
      return
    }
    const segments = this.#pending
    this.#queue.push({
      segments,
      durationSeconds: this.#pendingSeconds,
      overlapSegmentCount: this.#pendingOverlapCount,
      channel: segments.at(-1)!.channel
    })
    const retained: ReplaySegment[] = []
    let retainedSeconds = 0
    if (retainOverlap && this.#overlapSeconds > 0) {
      for (let index = segments.length - 1; index >= 0 && retainedSeconds < this.#overlapSeconds; index -= 1) {
        retained.unshift(segments[index]!)
        retainedSeconds += segments[index]!.durationSeconds
      }
    }
    this.#pending = retained
    this.#pendingSeconds = Math.min(retainedSeconds, this.#overlapSeconds)
    this.#pendingOverlapCount = retained.length
    while (this.#queue.length > 8) {
      const dropped = this.#queue.shift()
      for (const segment of dropped?.segments.slice(dropped.overlapSegmentCount) ?? []) {
        segment.transcription = { status: 'error', text: '', error: 'Transcription queue full' }
      }
    }
    void this.#drain()
  }

  #clearPending(): void {
    if (this.#pendingTimer) clearTimeout(this.#pendingTimer)
    this.#pendingTimer = undefined
    this.#pending = []
    this.#pendingSeconds = 0
    this.#pendingOverlapCount = 0
  }

  async #drain(): Promise<void> {
    if (this.#running) return
    this.#running = true
    try {
      while (this.#enabled && this.#queue.length > 0) {
        const batch = this.#queue.shift()!
        const outputSegments = batch.segments.slice(batch.overlapSegmentCount)
        for (const segment of outputSegments) segment.transcription = { status: 'transcribing', text: '' }
        try {
          const rawText = await this.#transcribe(batch)
          const previousText = this.#previousTranscript.get(batch.channel)
          const text = batch.overlapSegmentCount > 0 && previousText
            ? reconcileTranscriptOverlap(previousText, rawText)
            : rawText
          for (const segment of outputSegments) segment.transcription = { status: 'complete', text: '' }
          outputSegments.at(-1)!.transcription = { status: 'complete', text }
          this.#previousTranscript.set(batch.channel, rawText)
          this.#error = undefined
          try {
            this.#archiveBatch(batch, text)
          } catch (error) {
            this.#error = `Transcript archive: ${error instanceof Error ? error.message : String(error)}`
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          for (const segment of outputSegments) segment.transcription = { status: 'error', text: '', error: message }
          this.#error = message
        }
      }
    } finally {
      this.#running = false
      this.#child = undefined
      this.#narrator?.resume()
    }
  }

  async #transcribe(batch: TranscriptionBatch): Promise<string> {
    const lastSegment = batch.segments.at(-1)!
    const wavPath = path.join(os.tmpdir(), `vhf-watch-${process.pid}-${lastSegment.id}.wav`)
    const sampleRate = batch.segments[0]!.wav.readUInt32LE(24)
    const overlapPcm = Buffer.concat(batch.segments.slice(0, batch.overlapSegmentCount).map((segment) => segment.wav.subarray(44)))
    const maximumOverlapBytes = Math.floor(this.#overlapSeconds * sampleRate) * 2
    const retainedOverlap = overlapPcm.subarray(Math.max(0, overlapPcm.length - maximumOverlapBytes))
    const rawPcm = Buffer.concat([
      retainedOverlap,
      ...batch.segments.slice(batch.overlapSegmentCount).map((segment) => segment.wav.subarray(44))
    ])
    const pcm = this.#denoiser?.available()
      ? await this.#denoiser.processPcm(rawPcm, sampleRate)
      : rawPcm
    writeFileSync(wavPath, pcmToWav(pcm, sampleRate), { mode: 0o600 })
    return new Promise((resolve, reject) => {
      const child = spawn(this.#command, [wavPath, this.#model, String(this.#threads)], { stdio: ['ignore', 'pipe', 'pipe'] })
      this.#child = child
      let stdout = ''
      let stderr = ''
      const timeout = setTimeout(() => child.kill('SIGKILL'), transcriptionTimeoutMs(batch.durationSeconds))
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout = (stdout + chunk).slice(-65_536) })
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-8_192) })
      child.on('error', (error) => reject(error))
      child.on('close', (code, signal) => {
        clearTimeout(timeout)
        try { unlinkSync(wavPath) } catch { /* already removed */ }
        if (code !== 0) {
          reject(new Error(signal === 'SIGKILL' ? 'Transcription timed out' : stderr.trim() || `Whisper exited ${code}`))
          return
        }
        resolve(cleanWhisperOutput(stdout))
      })
    })
  }

  #archiveBatch(batch: TranscriptionBatch, transcript: string): void {
    if (!this.#archive) return
    const archivedSegments = batch.segments.slice(batch.overlapSegmentCount)
    const first = archivedSegments[0]!
    const last = archivedSegments.at(-1)!
    const measuredNoise = archivedSegments.flatMap((segment) => segment.qualitySpans.flatMap((span) => (
      span.discriminatorNoise === undefined ? [] : [span.discriminatorNoise]
    )))
    const sampleRate = first.wav.readUInt32LE(24)
    const pcm = Buffer.concat(archivedSegments.map((segment) => segment.wav.subarray(44)))
    const record = this.#archive.add({
      startedAt: first.startedAt,
      endedAt: last.endedAt,
      channel: first.channel,
      durationSeconds: archivedSegments.reduce((sum, segment) => sum + segment.durationSeconds, 0),
      sampleRate,
      ...(measuredNoise.length === 0 ? {} : { minimumDiscriminatorNoise: Math.min(...measuredNoise) }),
      transcript,
      wav: pcmToWav(pcm, sampleRate)
    })
    if (record) this.#narrator?.enqueue(record.id)
  }

  #repairArchivedTranscriptOverlap(): void {
    if (!this.#archive) return
    const records = this.#archive.list(2_000).reverse()
    let previous: TranscriptArchiveRecord | undefined
    for (const record of records) {
      if (previous && previous.channel === record.channel &&
        Math.abs(Date.parse(record.startedAt) - Date.parse(previous.endedAt)) <= 1_500) {
        const reconciled = reconcileTranscriptOverlap(previous.transcript, record.transcript)
        if (reconciled !== record.transcript) {
          record.transcript = reconciled
          this.#archive.updateTranscript(record.id, reconciled)
        }
      }
      previous = record
    }
  }

  #load(): PersistedSettings {
    try {
      if (!existsSync(this.#settingsPath)) return {
        enabled: false,
        model: DEFAULT_TRANSCRIPTION_MODEL,
        threads: DEFAULT_TRANSCRIPTION_THREADS
      }
      const parsed = JSON.parse(readFileSync(this.#settingsPath, 'utf8')) as Partial<PersistedSettings>
      return {
        enabled: parsed.enabled === true,
        model: typeof parsed.model === 'string' ? parsed.model : DEFAULT_TRANSCRIPTION_MODEL,
        threads: Number.isSafeInteger(parsed.threads) && parsed.threads! >= 1 && parsed.threads! <= MAXIMUM_TRANSCRIPTION_THREADS
          ? parsed.threads!
          : DEFAULT_TRANSCRIPTION_THREADS
      }
    } catch {
      return { enabled: false, model: DEFAULT_TRANSCRIPTION_MODEL, threads: DEFAULT_TRANSCRIPTION_THREADS }
    }
  }

  #save(): void {
    const temporary = `${this.#settingsPath}.new`
    writeFileSync(temporary, `${JSON.stringify({
      enabled: this.#enabled,
      model: this.#model,
      threads: this.#threads
    })}\n`, { mode: 0o600 })
    renameSync(temporary, this.#settingsPath)
  }
}
