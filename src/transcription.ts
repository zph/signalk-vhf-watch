import { spawn, type ChildProcess } from 'node:child_process'
import { accessSync, constants, existsSync, readFileSync, readdirSync, statSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ReplaySegment } from './rolling-buffer'
import { discriminatorThreshold } from './squelch'
import { TranscriptArchive, type TranscriptArchiveRecord, type TranscriptArchiveStatus } from './transcript-archive'
import type { RnnoiseDenoiser } from './rnnoise'
import { pcmToWav } from './wav'
import { WhisperVadProbe } from './whisper-vad'
import { channelById } from './channels'
import { DEFAULT_WHISPER_SERVER_COMMAND, WhisperServerCancelledError, WhisperServerPool } from './whisper-server-pool'

export const DEFAULT_TRANSCRIPTION_COMMAND = '/usr/bin/vhf-whisper'
export const DEFAULT_TRANSCRIPTION_MODELS_DIR = '/usr/share/vhf-whisper'
export const DEFAULT_TRANSCRIPTION_MODEL = 'base.en-q5_1'
export const DEFAULT_TRANSCRIPTION_THREADS = 2
export const WEATHER_TRANSCRIPTION_MODEL = DEFAULT_TRANSCRIPTION_MODEL
export const WEATHER_TRANSCRIPTION_THREADS = DEFAULT_TRANSCRIPTION_THREADS
export const MAXIMUM_TRANSCRIPTION_THREADS = 16
export const DEFAULT_KEEP_MODELS_LOADED = false
export const MAXIMUM_OVERLAP_SECONDS = 30
export const MINIMUM_TRANSCRIPTION_SIGNAL_SECONDS = 0.35
export const TRANSCRIPTION_BATCH_SECONDS = 60
export const TRANSCRIPTION_OVERLAP_SECONDS = 2
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
  weatherModel: string
  weatherThreads: number
  overlapSeconds: number
  keepModelsLoaded: boolean
  weatherAvailable: boolean
  backend: 'whisper-server' | 'whisper-cli' | 'whisper-cli-fallback'
  activeModel?: string
  activeThreads?: number
  residentModels: string[]
  availableModels: TranscriptionModel[]
  command: string
  speechGate: { mode: 'observe' | 'filter'; checked: number; wouldSkip: number; skipped: number; failOpen: number }
  archive?: TranscriptArchiveStatus
  error?: string
}

export interface PersistedSettings {
  enabled: boolean
  model: string
  threads: number
  weatherModel: string
  weatherThreads: number
  overlapSeconds: number
  keepModelsLoaded: boolean
}

export type TranscriptionSettingsPatch = Partial<PersistedSettings>

export interface TranscriptionModel {
  id: string
  label: string
  bytes: number
}

interface TranscriptionBatch {
  segments: ReplaySegment[]
  wavs: Buffer[]
  durationSeconds: number
  overlapSegmentCount: number
  overlapSeconds: number
  channel: string
  squelch: number
  model: string
  threads: number
}

interface TranscriptionOptions {
  batchSeconds?: number
  overlapSeconds?: number
  idleMs?: number
  archive?: TranscriptArchive
  modelsDir?: string
  denoiser?: RnnoiseDenoiser
  vad?: WhisperVadProbe
  /** Test-only override; production filters valid no-speech VAD results. */
  vadMode?: 'observe' | 'filter'
  serverCommand?: string
  serverPool?: WhisperServerPool
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
  readonly #server: WhisperServerPool
  readonly #batchSeconds: number
  #overlapSeconds: number
  readonly #idleMs: number
  readonly #archive?: TranscriptArchive
  readonly #modelsDir: string
  readonly #denoiser?: RnnoiseDenoiser
  readonly #vad: WhisperVadProbe
  readonly #vadMode: 'observe' | 'filter'
  #enabled: boolean
  #model: string
  #threads: number
  #weatherModel: string
  #weatherThreads: number
  #keepModelsLoaded: boolean
  #queue: TranscriptionBatch[] = []
  #pending: ReplaySegment[] = []
  #pendingWavs: Buffer[] = []
  #pendingSeconds = 0
  #pendingOverlapCount = 0
  #pendingSquelch?: number
  #pendingModel?: string
  #pendingThreads?: number
  #pendingTimer?: ReturnType<typeof setTimeout>
  #running = false
  #reconfiguring = false
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
    this.#server = options.serverPool ?? new WhisperServerPool({
      command: options.serverCommand ?? DEFAULT_WHISPER_SERVER_COMMAND,
      modelsDir: options.modelsDir ?? DEFAULT_TRANSCRIPTION_MODELS_DIR
    })
    this.#batchSeconds = options.batchSeconds ?? TRANSCRIPTION_BATCH_SECONDS
    this.#idleMs = options.idleMs ?? TRANSCRIPTION_BATCH_IDLE_MS
    this.#archive = options.archive
    this.#modelsDir = options.modelsDir ?? DEFAULT_TRANSCRIPTION_MODELS_DIR
    this.#denoiser = options.denoiser
    this.#vad = options.vad ?? new WhisperVadProbe()
    this.#vadMode = options.vadMode ?? 'filter'
    const initialOverlap = Math.min(
      Number.isFinite(options.overlapSeconds) ? Math.max(0, options.overlapSeconds!) : TRANSCRIPTION_OVERLAP_SECONDS,
      MAXIMUM_OVERLAP_SECONDS,
      this.#batchSeconds / 2
    )
    const settings = this.#load(initialOverlap)
    this.#enabled = settings.enabled
    this.#model = settings.model
    this.#threads = settings.threads
    this.#weatherModel = settings.weatherModel
    this.#weatherThreads = settings.weatherThreads
    this.#keepModelsLoaded = settings.keepModelsLoaded
    this.#overlapSeconds = settings.overlapSeconds
    this.#repairArchivedTranscriptOverlap()
  }

  status(): TranscriptionStatus {
    const availableModels = this.availableModels()
    const available = this.#backendAvailable() && availableModels.some((candidate) => candidate.id === this.#model)
    const activeModel = this.#activeBatch?.model
    const activeThreads = this.#activeBatch?.threads
    return {
      enabled: this.#enabled,
      available,
      state: !this.#enabled ? 'disabled' : !available ? 'unavailable' : this.#running ? 'transcribing' : 'idle',
      queued: this.#queue.length + (this.#pending.length > 0 ? 1 : 0),
      backlog: this.#backlog(),
      engine: `whisper.cpp ${this.#model} · WX ${this.#weatherModel}${this.#denoiser?.available() ? ' · RNNoise 50%' : ''}`,
      model: this.#model,
      threads: this.#threads,
      weatherModel: this.#weatherModel,
      weatherThreads: this.#weatherThreads,
      overlapSeconds: this.#overlapSeconds,
      keepModelsLoaded: this.#keepModelsLoaded,
      weatherAvailable: availableModels.some((candidate) => candidate.id === this.#weatherModel),
      backend: !this.#keepModelsLoaded
        ? 'whisper-cli'
        : this.#server.available ? 'whisper-server' : 'whisper-cli-fallback',
      ...(activeModel ? { activeModel } : {}),
      ...(activeThreads ? { activeThreads } : {}),
      residentModels: this.#server.residentModels,
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
    return this.#backendAvailable() && this.availableModels().some((candidate) => candidate.id === this.#model)
  }

  #commandAvailable(): boolean {
    try { accessSync(this.#command, constants.X_OK); return true } catch { return false }
  }

  #modelForChannel(channel: string): string {
    return channelById(channel)?.weather ? this.#weatherModel : this.#model
  }

  #threadsForChannel(channel: string): number {
    return channelById(channel)?.weather ? this.#weatherThreads : this.#threads
  }

  #backendAvailable(): boolean {
    return this.#commandAvailable() || (this.#keepModelsLoaded && this.#server.available)
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

  async configure(patchOrModel: TranscriptionSettingsPatch | string, legacyThreads?: number): Promise<TranscriptionStatus> {
    const patch: TranscriptionSettingsPatch = typeof patchOrModel === 'string'
      ? { model: patchOrModel, ...(legacyThreads !== undefined ? { threads: legacyThreads } : {}) }
      : patchOrModel
    const current = this.#settings()
    const next: PersistedSettings = { ...current, ...patch }
    if (typeof next.enabled !== 'boolean') throw new Error('enabled must be true or false')
    if (typeof next.model !== 'string') throw new Error('model must be a string')
    if (!Number.isSafeInteger(next.threads) || next.threads < 1 || next.threads > MAXIMUM_TRANSCRIPTION_THREADS) {
      throw new Error(`threads must be an integer from 1 to ${MAXIMUM_TRANSCRIPTION_THREADS}`)
    }
    if (typeof next.weatherModel !== 'string') throw new Error('weatherModel must be a string')
    if (!Number.isSafeInteger(next.weatherThreads) || next.weatherThreads < 1 || next.weatherThreads > MAXIMUM_TRANSCRIPTION_THREADS) {
      throw new Error(`weatherThreads must be an integer from 1 to ${MAXIMUM_TRANSCRIPTION_THREADS}`)
    }
    if (!Number.isFinite(next.overlapSeconds) || next.overlapSeconds < 0 ||
      next.overlapSeconds > MAXIMUM_OVERLAP_SECONDS || next.overlapSeconds > this.#batchSeconds / 2) {
      throw new Error(`overlapSeconds must be from 0 to ${Math.min(MAXIMUM_OVERLAP_SECONDS, this.#batchSeconds / 2)} seconds`)
    }
    if (typeof next.keepModelsLoaded !== 'boolean') throw new Error('keepModelsLoaded must be true or false')

    const models = this.availableModels(true)
    if (patch.model !== undefined && !models.some((candidate) => candidate.id === next.model)) {
      throw new Error(`Whisper model ${next.model} is not installed`)
    }
    if (patch.weatherModel !== undefined && next.weatherModel !== current.weatherModel &&
      !models.some((candidate) => candidate.id === next.weatherModel)) {
      throw new Error(`Weather Whisper model ${next.weatherModel} is not installed`)
    }
    if (next.enabled) {
      const backendAvailable = this.#commandAvailable() || (next.keepModelsLoaded && this.#server.available)
      if (!backendAvailable) throw new Error('Install the vhf-whisper-runtime package before enabling transcription')
      if (!models.some((candidate) => candidate.id === next.model)) {
        throw new Error(`Install or select the Whisper model ${next.model} before enabling transcription`)
      }
    }

    const changed = Object.keys(current).some((key) => current[key as keyof PersistedSettings] !== next[key as keyof PersistedSettings])
    if (!changed) return this.status()
    const overlapChanged = next.overlapSeconds !== this.#overlapSeconds
    const workerConfigChanged = next.model !== this.#model || next.threads !== this.#threads ||
      next.weatherModel !== this.#weatherModel || next.weatherThreads !== this.#weatherThreads ||
      next.keepModelsLoaded !== this.#keepModelsLoaded
    const disabling = this.#enabled && !next.enabled

    this.#reconfiguring = true
    try {
      if (overlapChanged && !disabling) this.#flushPending()
      this.#saveSettings(next)
      if (workerConfigChanged || disabling) this.#currentAbort?.abort()
      if (disabling) {
        this.#queue = []
        this.#clearPending()
      }
      this.#enabled = next.enabled
      this.#model = next.model
      this.#threads = next.threads
      this.#weatherModel = next.weatherModel
      this.#weatherThreads = next.weatherThreads
      this.#overlapSeconds = next.overlapSeconds
      this.#keepModelsLoaded = next.keepModelsLoaded
      this.#error = undefined
      if (workerConfigChanged || disabling) await this.#server.closeAll()
    } finally {
      this.#reconfiguring = false
      if (this.#enabled && this.#queue.length > 0) void this.#drain()
    }
    return this.status()
  }

  async setEnabled(enabled: boolean): Promise<TranscriptionStatus> {
    return this.configure({ enabled })
  }

  enqueue(segment: ReplaySegment, squelch: number): void {
    if (this.#closed || !this.#enabled || !this.available()) return
    const model = this.#modelForChannel(segment.channel)
    if (channelById(segment.channel)?.weather && !this.availableModels().some((candidate) => candidate.id === model)) {
      const error = `Weather transcription unavailable: install ${model}`
      segment.transcription = { status: 'error', text: '', error }
      this.#error = error
      return
    }
    const activeSeconds = transcriptionActiveSeconds(segment, squelch)
    if (activeSeconds < MINIMUM_TRANSCRIPTION_SIGNAL_SECONDS) {
      segment.transcription = { status: 'skipped', text: '' }
      this.#flushPending()
      return
    }
    const previous = this.#pending.at(-1)
    const threads = this.#threadsForChannel(segment.channel)
    if (previous && (
      previous.channel !== segment.channel ||
      this.#pendingModel !== model ||
      this.#pendingThreads !== threads ||
      Math.abs(Date.parse(segment.startedAt) - Date.parse(previous.endedAt)) > 500 ||
      this.#pendingSquelch !== squelch
    )) {
      this.#flushPending()
    }
    if (this.#pending.length === 0) {
      this.#pendingSquelch = squelch
      this.#pendingModel = model
      this.#pendingThreads = threads
    }
    segment.transcription = { status: 'queued', text: '' }
    this.#pending.push(segment)
    // Replay compaction may replace segment.wav before a later overlapping batch uses it.
    this.#pendingWavs.push(segment.wav)
    this.#pendingSeconds += segment.durationSeconds
    if (this.#pendingSeconds >= this.#batchSeconds) this.#flushPending(true)
    else this.#schedulePending()
  }

  async stop(): Promise<void> {
    this.#queue = []
    this.#clearPending()
    this.#currentAbort?.abort()
    await this.#server.closeAll()
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    await this.stop()
    this.#archive?.close()
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
    const wavs = this.#pendingWavs
    this.#queue.push({
      segments,
      wavs,
      durationSeconds: this.#pendingSeconds,
      overlapSegmentCount: this.#pendingOverlapCount,
      overlapSeconds: this.#overlapSeconds,
      channel: segments.at(-1)!.channel,
      squelch: this.#pendingSquelch ?? 0,
      model: this.#pendingModel ?? this.#model,
      threads: this.#pendingThreads ?? this.#threads
    })
    const retained: ReplaySegment[] = []
    const retainedWavs: Buffer[] = []
    let retainedSeconds = 0
    if (retainOverlap && this.#overlapSeconds > 0) {
      for (let index = segments.length - 1; index >= 0 && retainedSeconds < this.#overlapSeconds; index -= 1) {
        retained.unshift(segments[index]!)
        retainedWavs.unshift(wavs[index]!)
        retainedSeconds += segments[index]!.durationSeconds
      }
    }
    this.#pending = retained
    this.#pendingWavs = retainedWavs
    this.#pendingSeconds = Math.min(retainedSeconds, this.#overlapSeconds)
    this.#pendingOverlapCount = retained.length
    if (retained.length === 0) {
      this.#pendingSquelch = undefined
      this.#pendingModel = undefined
      this.#pendingThreads = undefined
    }
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
    this.#pendingWavs = []
    this.#pendingSeconds = 0
    this.#pendingOverlapCount = 0
    this.#pendingSquelch = undefined
    this.#pendingModel = undefined
    this.#pendingThreads = undefined
  }

  async #drain(): Promise<void> {
    if (this.#running) return
    this.#running = true
    try {
      while (this.#enabled && !this.#closed && !this.#reconfiguring && this.#queue.length > 0) {
        const batch = this.#queue.shift()!
        // Queued audio follows the current selection; the model/thread pair is then
        // frozen for the full active batch. Configuration changes abort that batch.
        batch.model = this.#modelForChannel(batch.channel)
        batch.threads = this.#threadsForChannel(batch.channel)
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
      if (this.#enabled && !this.#closed && !this.#reconfiguring && this.#queue.length > 0) {
        queueMicrotask(() => { void this.#drain() })
      }
    }
  }

  async #transcribe(batch: TranscriptionBatch): Promise<string> {
    const controller = new AbortController()
    this.#currentAbort = controller
    let wavPath: string | undefined
    try {
      const lastSegment = batch.segments.at(-1)!
      wavPath = path.join(os.tmpdir(), `vhf-watch-${process.pid}-${lastSegment.id}.wav`)
      const sampleRate = batch.wavs[0]!.readUInt32LE(24)
      const newPcm = Buffer.concat(batch.wavs.slice(batch.overlapSegmentCount).map((wav) => wav.subarray(44)))
      const overlapPcm = Buffer.concat(batch.wavs.slice(0, batch.overlapSegmentCount).map((wav) => wav.subarray(44)))
      const maximumOverlapBytes = Math.floor(batch.overlapSeconds * sampleRate) * 2
      const retainedOverlap = overlapPcm.subarray(Math.max(0, overlapPcm.length - maximumOverlapBytes))
      const rawPcm = Buffer.concat([
        retainedOverlap,
        ...batch.wavs.slice(batch.overlapSegmentCount).map((wav) => wav.subarray(44))
      ])

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
      if (this.#keepModelsLoaded && this.#server.available) {
        try {
          return cleanWhisperOutput(await this.#server.transcribe(
            batch.model,
            batch.threads,
            wavPath,
            controller.signal,
            transcriptionTimeoutMs(batch.durationSeconds),
            (child) => { this.#child = child }
          ))
        } catch (error) {
          if (error instanceof WhisperServerCancelledError || controller.signal.aborted) throw new TranscriptionCancelledError()
          throw error
        }
      }
      return await new Promise((resolve, reject) => {
        const child = spawn(this.#command, [wavPath!, batch.model, String(batch.threads)], { stdio: ['ignore', 'pipe', 'pipe'] })
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
    const archivedWavs = batch.wavs.slice(batch.overlapSegmentCount)
    const measuredNoise = archivedSegments.flatMap((segment) => segment.qualitySpans.flatMap((span) => (
      span.discriminatorNoise === undefined ? [] : [span.discriminatorNoise]
    )))
    const sampleRate = archivedWavs[0]!.readUInt32LE(24)
    const pcm = Buffer.concat(archivedWavs.map((wav) => wav.subarray(44)))
    const bytesPerSecond = sampleRate * 2
    const paddingBytes = TRANSCRIPTION_ARCHIVE_PADDING_SECONDS * bytesPerSecond
    const threshold = discriminatorThreshold(batch.squelch)
    let segmentOffset = 0
    let activeStart = Number.POSITIVE_INFINITY
    let activeEnd = 0
    for (const [index, segment] of archivedSegments.entries()) {
      const segmentBytes = archivedWavs[index]!.length - 44
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

  #settings(): PersistedSettings {
    return {
      enabled: this.#enabled,
      model: this.#model,
      threads: this.#threads,
      weatherModel: this.#weatherModel,
      weatherThreads: this.#weatherThreads,
      overlapSeconds: this.#overlapSeconds,
      keepModelsLoaded: this.#keepModelsLoaded
    }
  }

  #load(defaultOverlapSeconds: number): PersistedSettings {
    const defaults: PersistedSettings = {
      enabled: false,
      model: DEFAULT_TRANSCRIPTION_MODEL,
      threads: DEFAULT_TRANSCRIPTION_THREADS,
      weatherModel: WEATHER_TRANSCRIPTION_MODEL,
      weatherThreads: WEATHER_TRANSCRIPTION_THREADS,
      overlapSeconds: defaultOverlapSeconds,
      keepModelsLoaded: DEFAULT_KEEP_MODELS_LOADED
    }
    try {
      if (!existsSync(this.#settingsPath)) return defaults
      const parsed = JSON.parse(readFileSync(this.#settingsPath, 'utf8')) as Partial<PersistedSettings>
      return {
        enabled: parsed.enabled === true,
        model: typeof parsed.model === 'string' ? parsed.model : DEFAULT_TRANSCRIPTION_MODEL,
        threads: Number.isSafeInteger(parsed.threads) && parsed.threads! >= 1 && parsed.threads! <= MAXIMUM_TRANSCRIPTION_THREADS
          ? parsed.threads!
          : DEFAULT_TRANSCRIPTION_THREADS,
        weatherModel: typeof parsed.weatherModel === 'string' ? parsed.weatherModel : WEATHER_TRANSCRIPTION_MODEL,
        weatherThreads: Number.isSafeInteger(parsed.weatherThreads) && parsed.weatherThreads! >= 1 && parsed.weatherThreads! <= MAXIMUM_TRANSCRIPTION_THREADS
          ? parsed.weatherThreads!
          : WEATHER_TRANSCRIPTION_THREADS,
        overlapSeconds: typeof parsed.overlapSeconds === 'number' && Number.isFinite(parsed.overlapSeconds) &&
          parsed.overlapSeconds >= 0 && parsed.overlapSeconds <= MAXIMUM_OVERLAP_SECONDS && parsed.overlapSeconds <= this.#batchSeconds / 2
          ? parsed.overlapSeconds
          : defaultOverlapSeconds,
        keepModelsLoaded: typeof parsed.keepModelsLoaded === 'boolean' ? parsed.keepModelsLoaded : DEFAULT_KEEP_MODELS_LOADED
      }
    } catch {
      return defaults
    }
  }

  #saveSettings(settings: PersistedSettings): void {
    const temporary = `${this.#settingsPath}.new`
    writeFileSync(temporary, `${JSON.stringify(settings)}\n`, { mode: 0o600 })
    renameSync(temporary, this.#settingsPath)
  }
}
