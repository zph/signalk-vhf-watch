import { spawn, type ChildProcess } from 'node:child_process'
import { accessSync, constants, existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { access } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ReplaySegment } from './rolling-buffer'
import { discriminatorThreshold } from './squelch'
import { TranscriptArchive, type TranscriptArchiveRecord, type TranscriptArchiveStatus } from './transcript-archive'
import { pcmToWav } from './wav'

export const DEFAULT_TRANSCRIPTION_COMMAND = '/usr/bin/vhf-whisper'
export const MINIMUM_TRANSCRIPTION_SIGNAL_SECONDS = 0.35
export const TRANSCRIPTION_BATCH_SECONDS = 15
export const TRANSCRIPTION_BATCH_IDLE_MS = 6_000

export interface TranscriptionStatus {
  enabled: boolean
  available: boolean
  state: 'disabled' | 'unavailable' | 'idle' | 'transcribing'
  queued: number
  engine: 'whisper.cpp tiny.en q5_1'
  command: string
  archive?: TranscriptArchiveStatus
  error?: string
}

interface PersistedSettings {
  enabled: boolean
}

interface TranscriptionBatch {
  segments: ReplaySegment[]
  durationSeconds: number
}

interface TranscriptionOptions {
  batchSeconds?: number
  idleMs?: number
  archive?: TranscriptArchive
}

export class TranscriptionManager {
  readonly #settingsPath: string
  readonly #command: string
  readonly #batchSeconds: number
  readonly #idleMs: number
  readonly #archive?: TranscriptArchive
  #enabled: boolean
  #queue: TranscriptionBatch[] = []
  #pending: ReplaySegment[] = []
  #pendingSeconds = 0
  #pendingTimer?: ReturnType<typeof setTimeout>
  #running = false
  #child?: ChildProcess
  #error?: string
  #closed = false

  constructor(settingsPath: string, command = DEFAULT_TRANSCRIPTION_COMMAND, options: TranscriptionOptions = {}) {
    this.#settingsPath = settingsPath
    this.#command = command
    this.#batchSeconds = options.batchSeconds ?? TRANSCRIPTION_BATCH_SECONDS
    this.#idleMs = options.idleMs ?? TRANSCRIPTION_BATCH_IDLE_MS
    this.#archive = options.archive
    this.#enabled = this.#load().enabled
  }

  status(): TranscriptionStatus {
    const available = this.available()
    return {
      enabled: this.#enabled,
      available,
      state: !this.#enabled ? 'disabled' : !available ? 'unavailable' : this.#running ? 'transcribing' : 'idle',
      queued: this.#queue.length + (this.#pending.length > 0 ? 1 : 0),
      engine: 'whisper.cpp tiny.en q5_1',
      command: this.#command,
      ...(this.#archive ? { archive: this.#archive.status() } : {}),
      ...(this.#error ? { error: this.#error } : {})
    }
  }

  available(): boolean {
    try {
      accessSync(this.#command, constants.X_OK)
      return true
    } catch {
      return false
    }
  }

  async setEnabled(enabled: boolean): Promise<TranscriptionStatus> {
    if (enabled) {
      try {
        await access(this.#command, constants.X_OK)
      } catch {
        throw new Error('Install the vhf-whisper-runtime package before enabling transcription')
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
    const threshold = discriminatorThreshold(squelch)
    const activeBytes = segment.qualitySpans.length === 0
      ? segment.wav.length - 44
      : segment.qualitySpans.reduce((total, span) => (
          span.discriminatorNoise === undefined || span.discriminatorNoise < threshold ? total + span.bytes : total
        ), 0)
    const activeSeconds = activeBytes / Math.max(1, segment.wav.length - 44) * segment.durationSeconds
    if (activeSeconds < MINIMUM_TRANSCRIPTION_SIGNAL_SECONDS) {
      segment.transcription = { status: 'skipped', text: '' }
      this.#flushPending()
      return
    }
    const previous = this.#pending.at(-1)
    if (previous && (previous.channel !== segment.channel || Math.abs(Date.parse(segment.startedAt) - Date.parse(previous.endedAt)) > 500)) {
      this.#flushPending()
    }
    segment.transcription = { status: 'queued', text: '' }
    this.#pending.push(segment)
    this.#pendingSeconds += segment.durationSeconds
    if (this.#pendingSeconds >= this.#batchSeconds) this.#flushPending()
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

  #flushPending(): void {
    if (this.#pendingTimer) clearTimeout(this.#pendingTimer)
    this.#pendingTimer = undefined
    if (this.#pending.length === 0) return
    this.#queue.push({ segments: this.#pending, durationSeconds: this.#pendingSeconds })
    this.#pending = []
    this.#pendingSeconds = 0
    while (this.#queue.length > 8) {
      const dropped = this.#queue.shift()
      for (const segment of dropped?.segments ?? []) {
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
  }

  async #drain(): Promise<void> {
    if (this.#running) return
    this.#running = true
    try {
      while (this.#enabled && this.#queue.length > 0) {
        const batch = this.#queue.shift()!
        for (const segment of batch.segments) segment.transcription = { status: 'transcribing', text: '' }
        try {
          const text = await this.#transcribe(batch)
          for (const segment of batch.segments) segment.transcription = { status: 'complete', text: '' }
          batch.segments.at(-1)!.transcription = { status: 'complete', text }
          this.#error = undefined
          try {
            this.#archiveBatch(batch, text)
          } catch (error) {
            this.#error = `Transcript archive: ${error instanceof Error ? error.message : String(error)}`
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          for (const segment of batch.segments) segment.transcription = { status: 'error', text: '', error: message }
          this.#error = message
        }
      }
    } finally {
      this.#running = false
      this.#child = undefined
    }
  }

  #transcribe(batch: TranscriptionBatch): Promise<string> {
    const lastSegment = batch.segments.at(-1)!
    const wavPath = path.join(os.tmpdir(), `vhf-watch-${process.pid}-${lastSegment.id}.wav`)
    const sampleRate = batch.segments[0]!.wav.readUInt32LE(24)
    const pcm = Buffer.concat(batch.segments.map((segment) => segment.wav.subarray(44)))
    writeFileSync(wavPath, pcmToWav(pcm, sampleRate), { mode: 0o600 })
    return new Promise((resolve, reject) => {
      const child = spawn(this.#command, [wavPath], { stdio: ['ignore', 'pipe', 'pipe'] })
      this.#child = child
      let stdout = ''
      let stderr = ''
      const timeout = setTimeout(() => child.kill('SIGKILL'), 30_000)
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
        resolve(stdout.replace(/\x1b\[[0-9;]*m/g, '').replace(/\s+/g, ' ').trim())
      })
    })
  }

  #archiveBatch(batch: TranscriptionBatch, transcript: string): void {
    if (!this.#archive) return
    const first = batch.segments[0]!
    const last = batch.segments.at(-1)!
    const measuredNoise = batch.segments.flatMap((segment) => segment.qualitySpans.flatMap((span) => (
      span.discriminatorNoise === undefined ? [] : [span.discriminatorNoise]
    )))
    const sampleRate = first.wav.readUInt32LE(24)
    const pcm = Buffer.concat(batch.segments.map((segment) => segment.wav.subarray(44)))
    this.#archive.add({
      startedAt: first.startedAt,
      endedAt: last.endedAt,
      channel: first.channel,
      durationSeconds: batch.durationSeconds,
      sampleRate,
      ...(measuredNoise.length === 0 ? {} : { minimumDiscriminatorNoise: Math.min(...measuredNoise) }),
      transcript,
      wav: pcmToWav(pcm, sampleRate)
    })
  }

  #load(): PersistedSettings {
    try {
      if (!existsSync(this.#settingsPath)) return { enabled: false }
      const parsed = JSON.parse(readFileSync(this.#settingsPath, 'utf8')) as Partial<PersistedSettings>
      return { enabled: parsed.enabled === true }
    } catch {
      return { enabled: false }
    }
  }

  #save(): void {
    const temporary = `${this.#settingsPath}.new`
    writeFileSync(temporary, `${JSON.stringify({ enabled: this.#enabled })}\n`, { mode: 0o600 })
    renameSync(temporary, this.#settingsPath)
  }
}
