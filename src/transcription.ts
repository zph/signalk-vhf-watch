import { spawn, type ChildProcess } from 'node:child_process'
import { accessSync, constants, existsSync, readFileSync, readdirSync, statSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { access } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ReplaySegment } from './rolling-buffer'
import { discriminatorThreshold } from './squelch'
import { TranscriptArchive, type TranscriptArchiveRecord, type TranscriptArchiveStatus } from './transcript-archive'
import type { RnnoiseDenoiser } from './rnnoise'
import { pcmToWav } from './wav'
import { WhisperVadProbe } from './whisper-vad'

export const DEFAULT_TRANSCRIPTION_COMMAND = '/usr/bin/vhf-whisper'
export const DEFAULT_TRANSCRIPTION_MODELS_DIR = '/usr/share/vhf-whisper'
export const DEFAULT_TRANSCRIPTION_MODEL = 'base.en-q5_1'
export const DEFAULT_TRANSCRIPTION_THREADS = 2
export const MAXIMUM_TRANSCRIPTION_THREADS = 16
export const MINIMUM_TRANSCRIPTION_SIGNAL_SECONDS = 0.35
export const TRANSCRIPTION_BATCH_SECONDS = 60
export const TRANSCRIPTION_OVERLAP_SECONDS = 10
export const TRANSCRIPTION_ARCHIVE_PADDING_SECONDS = 1
export const TRANSCRIPTION_BATCH_IDLE_MS = 6_000
export const MINIMUM_TRANSCRIPTION_TIMEOUT_MS = 90_000
export const TRANSCRIPTION_TIMEOUT_AUDIO_MULTIPLIER = 2
const MODEL_INVENTORY_CACHE_MS = 30_000

class TranscriptionCancelledError extends Error {}

export interface TranscriptionStatus {
  enabled: boolean
  available: boolean
  state: 'disabled' | 'unavailable' | 'idle' | 'transcribing'
  queued: number
  /** Unfinished clips and input audio seconds, excluding repeated overlap; not a completion ETA. */
  backlog: { clips: number; seconds: number; processingClips: number }
  engine: string
  model: string
  threads: number
  availableModels: TranscriptionModel[]
  command: string
  speechGate: { mode: 'observe' | 'filter'; checked: number; wouldSkip: number; skipped: number; failOpen: number }
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
  squelch: number
}

interface TranscriptionOptions {
  batchSeconds?: number
  overlapSeconds?: number
  idleMs?: number
  archive?: TranscriptArchive
  modelsDir?: string
  denoiser?: RnnoiseDenoiser
  vad?: WhisperVadProbe
  /** Test-only behavior switch; production observes VAD but never drops a batch. */
  vadMode?: 'observe' | 'filter'
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
    .replace(/\[\s*(?:BLANK_AUDIO|MUSIC|STATIC|NOISE|SILENCE)\s*\]/gi, ' ')
    .replace(/\((?:machine whirring|motor running)\)/gi, ' ')
    .replace(/[♩♪♫♬]/g, ' ')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\[\d{2}:\d{2}:\d{2}\.\d{3}\s+-->\s+\d{2}:\d{2}:\d{2}\.\d{3}\]\s*/, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function hasLexicalSpeech(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text)
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
  readonly #vad: WhisperVadProbe
  readonly #vadMode: 'observe' | 'filter'
  #enabled: boolean
  #model: string
  #threads: number
  #queue: TranscriptionBatch[] = []
  #pending: ReplaySegment[] = []
  #pendingSeconds = 0
  #pendingOverlapCount = 0
  #pendingSquelch?: number
  #pendingTimer?: ReturnType<typeof setTimeout>
  #running = false
  #activeBatch?: TranscriptionBatch
  #child?: ChildProcess
  #currentAbort?: AbortController
  #vadChecked = 0
  #vadWouldSkip = 0
  #vadSkipped = 0
  #vadFailOpen = 0
  #error?: string
  #closed = false
  #previousTranscript = new Map<string, string>()
  #modelsCache?: { checkedAt: number; models: TranscriptionModel[] }

  constructor(settingsPath: string, command = DEFAULT_TRANSCRIPTION_COMMAND, options: TranscriptionOptions = {}) {
    this.#settingsPath = settingsPath
    this.#command = command
    this.#batchSeconds = options.batchSeconds ?? TRANSCRIPTION_BATCH_SECONDS
    this.#overlapSeconds = Math.min(options.overlapSeconds ?? TRANSCRIPTION_OVERLAP_SECONDS, this.#batchSeconds / 2)
    this.#idleMs = options.idleMs ?? TRANSCRIPTION_BATCH_IDLE_MS
    this.#archive = options.archive
    this.#modelsDir = options.modelsDir ?? DEFAULT_TRANSCRIPTION_MODELS_DIR
    this.#denoiser = options.denoiser
    this.#vad = options.vad ?? new WhisperVadProbe()
    this.#vadMode = options.vadMode ?? 'observe'
    const settings = this.#load()
    this.#enabled = settings.enabled
    this.#model = settings.model
    this.#threads = settings.threads
    this.#repairArchivedTranscriptOverlap()
  }

  status(): TranscriptionStatus {
    const availableModels = this.availableModels()
    const available = this.#commandAvailable() && availableModels.some((candidate) => candidate.id === this.#model)
    return {
      enabled: this.#enabled,
      available,
      state: !this.#enabled ? 'disabled' : !available ? 'unavailable' : this.#running ? 'transcribing' : 'idle',
      queued: this.#queue.length + (this.#pending.length > 0 ? 1 : 0),
      backlog: this.#backlog(),
      engine: `whisper.cpp ${this.#model}${this.#denoiser?.available() ? ' · RNNoise 50%' : ''}`,
      model: this.#model,
      threads: this.#threads,
      availableModels,
      command: this.#command,
      speechGate: {
        mode: this.#vadMode,
        checked: this.#vadChecked,
        wouldSkip: this.#vadWouldSkip,
        skipped: this.#vadSkipped,
        failOpen: this.#vadFailOpen
      },
      ...(this.#archive ? { archive: this.#archive.status() } : {}),
      ...(this.#error ? { error: this.#error } : {})
    }
  }

  #backlog(): TranscriptionStatus['backlog'] {
    let clips = 0
    let seconds = 0
    const add = (segments: ReplaySegment[], overlapCount: number) => {
      for (let index = overlapCount; index < segments.length; index += 1) {
        clips += 1
        seconds += segments[index]!.durationSeconds
      }
    }
    if (this.#activeBatch) add(this.#activeBatch.segments, this.#activeBatch.overlapSegmentCount)
    const processingClips = clips
    for (const batch of this.#queue) add(batch.segments, batch.overlapSegmentCount)
    add(this.#pending, this.#pendingOverlapCount)
    return { clips, seconds, processingClips }
  }

  available(): boolean {
    return this.#commandAvailable() && this.availableModels().some((candidate) => candidate.id === this.#model)
  }

  #commandAvailable(): boolean {
    try { accessSync(this.#command, constants.X_OK); return true } catch { return false }
  }

  availableModels(forceRefresh = false): TranscriptionModel[] {
    const now = Date.now()
    if (!forceRefresh && this.#modelsCache && now - this.#modelsCache.checkedAt < MODEL_INVENTORY_CACHE_MS) {
      return this.#modelsCache.models.map((model) => ({ ...model }))
    }
    let models: TranscriptionModel[]
    try {
      models = readdirSync(this.#modelsDir)
        .flatMap((filename) => {
          const match = /^ggml-([a-z0-9._-]+)\.bin$/i.exec(filename)
          if (!match) return []
          const id = match[1]!
          return [{ id, label: id.replaceAll('-', ' '), bytes: statSync(path.join(this.#modelsDir, filename)).size }]
        })
        .sort((left, right) => left.bytes - right.bytes || left.id.localeCompare(right.id))
    } catch {
      models = []
    }
    this.#modelsCache = { checkedAt: now, models }
    return models.map((model) => ({ ...model }))
  }

  async configure(model: string, threads: number): Promise<TranscriptionStatus> {
    if (!this.availableModels(true).some((candidate) => candidate.id === model)) {
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
      if (!this.availableModels(true).some((candidate) => candidate.id === this.#model)) {
        throw new Error(`Install or select the Whisper model ${this.#model} before enabling transcription`)
      }
    }
    this.#enabled = enabled
    this.#error = undefined
    if (!enabled) {
      this.#queue = []
      this.#clearPending()
      this.#currentAbort?.abort()
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
    const previous = this.#pending.at(-1)
    if (previous && (
      previous.channel !== segment.channel ||
      Math.abs(Date.parse(segment.startedAt) - Date.parse(previous.endedAt)) > 500 ||
      this.#pendingSquelch !== squelch
    )) {
      this.#flushPending()
    }
    if (this.#pending.length === 0) this.#pendingSquelch = squelch
    segment.transcription = { status: 'queued', text: '' }
    this.#pending.push(segment)
    this.#pendingSeconds += segment.durationSeconds
    if (this.#pendingSeconds >= this.#batchSeconds) this.#flushPending(true)
    else this.#schedulePending()
  }

  stop(): void {
    this.#queue = []
    this.#clearPending()
    this.#currentAbort?.abort()
    this.#child?.kill('SIGTERM')
  }

  close(): void {
    if (this.#closed) return
    this.stop()
    this.#archive?.close()
    this.#closed = true
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
      channel: segments.at(-1)!.channel,
      squelch: this.#pendingSquelch ?? 0
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
    if (retained.length === 0) this.#pendingSquelch = undefined
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
    this.#pendingSquelch = undefined
  }

  async #drain(): Promise<void> {
    if (this.#running) return
    this.#running = true
    try {
      while (this.#enabled && this.#queue.length > 0) {
        const batch = this.#queue.shift()!
        this.#activeBatch = batch
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
            this.#archiveBatch(batch, text, rawText)
          } catch (error) {
            this.#error = `Transcript archive: ${error instanceof Error ? error.message : String(error)}`
          }
        } catch (error) {
          if (error instanceof TranscriptionCancelledError || !this.#enabled || this.#closed) {
            for (const segment of outputSegments) segment.transcription = { status: 'skipped', text: '' }
            continue
          }
          const message = error instanceof Error ? error.message : String(error)
          for (const segment of outputSegments) segment.transcription = { status: 'error', text: '', error: message }
          this.#error = message
        } finally {
          this.#activeBatch = undefined
        }
      }
    } finally {
      this.#running = false
      this.#activeBatch = undefined
      this.#child = undefined
    }
  }

  async #transcribe(batch: TranscriptionBatch): Promise<string> {
    const controller = new AbortController()
    this.#currentAbort = controller
    let wavPath: string | undefined
    try {
      const lastSegment = batch.segments.at(-1)!
      wavPath = path.join(os.tmpdir(), `vhf-watch-${process.pid}-${lastSegment.id}.wav`)
      const sampleRate = batch.segments[0]!.wav.readUInt32LE(24)
      const newSegments = batch.segments.slice(batch.overlapSegmentCount)
      const newPcm = Buffer.concat(newSegments.map((segment) => segment.wav.subarray(44)))
      const overlapPcm = Buffer.concat(batch.segments.slice(0, batch.overlapSegmentCount).map((segment) => segment.wav.subarray(44)))
      const maximumOverlapBytes = Math.floor(this.#overlapSeconds * sampleRate) * 2
      const retainedOverlap = overlapPcm.subarray(Math.max(0, overlapPcm.length - maximumOverlapBytes))
      const rawPcm = Buffer.concat([retainedOverlap, ...newSegments.map((segment) => segment.wav.subarray(44))])

      const vad = await this.#vad.detect(newPcm, sampleRate, controller.signal, (child) => { this.#child = child })
      if (vad.outcome === 'aborted' || controller.signal.aborted || !this.#enabled || this.#closed) {
        throw new TranscriptionCancelledError()
      }
      if (vad.outcome === 'speech' || vad.outcome === 'no-speech') this.#vadChecked += 1
      else this.#vadFailOpen += 1
      if (vad.outcome === 'no-speech') {
        this.#vadWouldSkip += 1
        if (this.#vadMode === 'filter') {
          this.#vadSkipped += 1
          return ''
        }
      }

      const pcm = this.#denoiser?.available()
        ? await this.#denoiser.processPcm(rawPcm, sampleRate)
        : rawPcm
      if (controller.signal.aborted || !this.#enabled || this.#closed) throw new TranscriptionCancelledError()
      writeFileSync(wavPath, pcmToWav(pcm, sampleRate), { mode: 0o600 })
      return await new Promise((resolve, reject) => {
        const child = spawn(this.#command, [wavPath!, this.#model, String(this.#threads)], { stdio: ['ignore', 'pipe', 'pipe'] })
        this.#child = child
        let stdout = ''
        let stderr = ''
        const timeout = setTimeout(() => child.kill('SIGKILL'), transcriptionTimeoutMs(batch.durationSeconds))
        const abort = (): void => { child.kill('SIGTERM') }
        controller.signal.addEventListener('abort', abort, { once: true })
        if (controller.signal.aborted) abort()
        child.stdout?.setEncoding('utf8').on('data', (chunk: string) => { stdout = (stdout + chunk).slice(-65_536) })
        child.stderr?.setEncoding('utf8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-8_192) })
        child.on('error', (error) => reject(error))
        child.on('close', (code, signal) => {
          clearTimeout(timeout)
          controller.signal.removeEventListener('abort', abort)
          if (controller.signal.aborted) { reject(new TranscriptionCancelledError()); return }
          if (code !== 0) {
            reject(new Error(signal === 'SIGKILL' ? 'Transcription timed out' : stderr.trim() || `Whisper exited ${code}`))
            return
          }
          resolve(cleanWhisperOutput(stdout))
        })
      })
    } finally {
      if (wavPath) try { unlinkSync(wavPath) } catch { /* already removed */ }
      if (this.#currentAbort === controller) this.#currentAbort = undefined
      this.#child = undefined
    }
  }

  #archiveBatch(batch: TranscriptionBatch, transcript: string, rawTranscript: string): void {
    if (!this.#archive || !hasLexicalSpeech(rawTranscript)) return
    const archivedSegments = batch.segments.slice(batch.overlapSegmentCount)
    const first = archivedSegments[0]!
    const measuredNoise = archivedSegments.flatMap((segment) => segment.qualitySpans.flatMap((span) => (
      span.discriminatorNoise === undefined ? [] : [span.discriminatorNoise]
    )))
    const sampleRate = first.wav.readUInt32LE(24)
    const pcm = Buffer.concat(archivedSegments.map((segment) => segment.wav.subarray(44)))
    const bytesPerSecond = sampleRate * 2
    const paddingBytes = TRANSCRIPTION_ARCHIVE_PADDING_SECONDS * bytesPerSecond
    const threshold = discriminatorThreshold(batch.squelch)
    let segmentOffset = 0
    let activeStart = Number.POSITIVE_INFINITY
    let activeEnd = 0
    for (const segment of archivedSegments) {
      const segmentBytes = segment.wav.length - 44
      let spanOffset = segmentOffset
      for (const span of segment.qualitySpans) {
        const spanEnd = Math.min(segmentOffset + segmentBytes, spanOffset + span.bytes)
        if (span.discriminatorNoise !== undefined && span.discriminatorNoise < threshold) {
          activeStart = Math.min(activeStart, spanOffset)
          activeEnd = Math.max(activeEnd, spanEnd)
        }
        spanOffset = spanEnd
      }
      segmentOffset += segmentBytes
    }
    const hasMeasuredActivity = Number.isFinite(activeStart) && activeEnd > activeStart
    const trimStart = hasMeasuredActivity ? Math.floor(Math.max(0, activeStart - paddingBytes) / 2) * 2 : 0
    const trimEnd = hasMeasuredActivity ? Math.floor(Math.min(pcm.length, activeEnd + paddingBytes) / 2) * 2 : pcm.length
    const activityStartSeconds = trimStart / bytesPerSecond
    const activityEndSeconds = trimEnd / bytesPerSecond
    this.#archive.add({
      startedAt: first.startedAt,
      endedAt: archivedSegments.at(-1)!.endedAt,
      channel: first.channel,
      durationSeconds: pcm.length / bytesPerSecond,
      sampleRate,
      ...(measuredNoise.length === 0 ? {} : { minimumDiscriminatorNoise: Math.min(...measuredNoise) }),
      ...(hasMeasuredActivity ? { activityStartSeconds, activityEndSeconds } : {}),
      transcript,
      wav: pcmToWav(pcm, sampleRate)
    })
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
