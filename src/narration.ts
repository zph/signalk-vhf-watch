import { spawn, type ChildProcess } from 'node:child_process'
import { accessSync, constants, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { TranscriptArchive } from './transcript-archive'

export const DEFAULT_NARRATION_COMMAND = '/usr/bin/vhf-tts'
export const DEFAULT_NARRATION_VOICE = 'af_sarah'
export const DEFAULT_NARRATION_THREADS = 2
const RETRY_DELAY_MS = 2_000
const MAX_SESSION_CACHE_BYTES = 32 * 1024 * 1024

export interface NarrationStatus {
  available: boolean
  state: 'unavailable' | 'idle' | 'waiting' | 'generating'
  voice: string
  threads: number
  queued: number
  currentRecordId?: number
  error?: string
}

interface NarrationOptions {
  voice?: string
  threads?: number
  canRun?: () => boolean
  ffmpegCommand?: string
}

interface SessionCacheEntry {
  opus: Buffer
  bytes: number
}

export class NarrationManager {
  readonly #archive: TranscriptArchive
  readonly #command: string
  readonly #voice: string
  readonly #threads: number
  readonly #canRun: () => boolean
  readonly #ffmpegCommand: string
  #queue: number[] = []
  #running = false
  #currentRecordId?: number
  #child?: ChildProcess
  #yielding = false
  #closed = false
  #retryTimer?: ReturnType<typeof setTimeout>
  #error?: string
  #sessionCache = new Map<string, SessionCacheEntry>()
  #sessionCacheBytes = 0

  constructor(archive: TranscriptArchive, command = DEFAULT_NARRATION_COMMAND, options: NarrationOptions = {}) {
    this.#archive = archive
    this.#command = command
    this.#voice = options.voice ?? DEFAULT_NARRATION_VOICE
    this.#threads = options.threads ?? DEFAULT_NARRATION_THREADS
    this.#canRun = options.canRun ?? (() => true)
    this.#ffmpegCommand = options.ffmpegCommand ?? '/usr/bin/ffmpeg'
    for (const record of archive.recordsNeedingNarration()) this.#enqueueId(record.id)
    this.resume()
  }

  available(): boolean {
    try {
      accessSync(this.#command, constants.X_OK)
      accessSync(this.#ffmpegCommand, constants.X_OK)
      return true
    } catch {
      return false
    }
  }

  status(): NarrationStatus {
    const available = this.available()
    return {
      available,
      state: !available ? 'unavailable' : this.#running ? 'generating' : this.#queue.length > 0 ? 'waiting' : 'idle',
      voice: this.#voice,
      threads: this.#threads,
      queued: this.#queue.length,
      ...(this.#currentRecordId === undefined ? {} : { currentRecordId: this.#currentRecordId }),
      ...(this.#error ? { error: this.#error } : {})
    }
  }

  enqueue(id: number): void {
    const record = this.#archive.record(id)
    if (!record?.transcript.trim() || record.narrationBytes > 0) return
    this.#enqueueId(id)
    this.resume()
  }

  yield(): void {
    if (!this.#child || this.#currentRecordId === undefined) return
    this.#yielding = true
    this.#enqueueId(this.#currentRecordId, true)
    this.#killChild('SIGTERM')
  }

  resume(): void {
    if (this.#closed || this.#running || this.#queue.length === 0 || !this.available()) return
    if (!this.#canRun()) {
      this.#scheduleRetry()
      return
    }
    void this.#drain()
  }

  narrationOpus(id: number): Buffer | undefined {
    return this.#archive.narrationOpus(id)
  }

  async sessionOpus(ids: number[]): Promise<Buffer | undefined> {
    const records = ids.map((id) => this.#archive.record(id))
    if (records.some((record) => !record || record.narrationBytes === 0)) return undefined
    const key = records.map((record) => `${record!.id}:${record!.narrationBytes}`).join(',')
    const cached = this.#sessionCache.get(key)
    if (cached) {
      this.#sessionCache.delete(key)
      this.#sessionCache.set(key, cached)
      return cached.opus
    }
    const clips = ids.map((id) => this.#archive.narrationOpus(id))
    if (clips.some((clip) => !clip)) return undefined
    const opus = clips.length === 1 ? clips[0]! : await this.#concatenate(clips as Buffer[])
    this.#cacheSession(key, opus)
    return opus
  }

  close(): void {
    this.#closed = true
    if (this.#retryTimer) clearTimeout(this.#retryTimer)
    this.#killChild('SIGTERM')
    this.#queue = []
    this.#sessionCache.clear()
    this.#sessionCacheBytes = 0
  }

  #enqueueId(id: number, front = false): void {
    if (this.#queue.includes(id)) return
    if (front) this.#queue.unshift(id)
    else this.#queue.push(id)
  }

  #scheduleRetry(): void {
    if (this.#retryTimer || this.#closed) return
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined
      this.resume()
    }, RETRY_DELAY_MS)
    this.#retryTimer.unref()
  }

  async #drain(): Promise<void> {
    if (this.#running) return
    this.#running = true
    try {
      while (!this.#closed && this.#queue.length > 0) {
        if (!this.#canRun()) break
        const id = this.#queue.shift()!
        const record = this.#archive.record(id)
        if (!record?.transcript.trim() || record.narrationBytes > 0) continue
        this.#currentRecordId = id
        try {
          const opus = await this.#generate(id, record.transcript)
          if (!this.#yielding) {
            this.#archive.setNarration(id, opus, this.#voice)
            this.#error = undefined
          }
        } catch (error) {
          if (!this.#yielding) {
            const message = error instanceof Error ? error.message : String(error)
            this.#archive.setNarrationError(id, message)
            this.#error = message
          }
        } finally {
          this.#yielding = false
          this.#currentRecordId = undefined
          this.#child = undefined
        }
      }
    } finally {
      this.#running = false
      if (this.#queue.length > 0) this.#scheduleRetry()
    }
  }

  #generate(id: number, transcript: string): Promise<Buffer> {
    const base = path.join(os.tmpdir(), `vhf-watch-tts-${process.pid}-${id}`)
    const textPath = `${base}.txt`
    const opusPath = `${base}.opus`
    writeFileSync(textPath, `${transcript.trim()}\n`, { mode: 0o600 })
    return new Promise((resolve, reject) => {
      const child = spawn(this.#command, [textPath, opusPath, this.#voice, String(this.#threads)], {
        stdio: ['ignore', 'ignore', 'pipe'],
        detached: process.platform !== 'win32'
      })
      this.#child = child
      let stderr = ''
      const timeoutMs = Math.max(180_000, Math.min(15 * 60_000, transcript.length * 650))
      const timeout = setTimeout(() => this.#killChild('SIGKILL'), timeoutMs)
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-8_192) })
      child.on('error', reject)
      child.on('close', (code, signal) => {
        clearTimeout(timeout)
        try {
          if (code !== 0) {
            reject(new Error(signal === 'SIGKILL' ? 'Transcript narration timed out' : stderr.trim() || `TTS exited ${code}`))
            return
          }
          const opus = readFileSync(opusPath)
          if (opus.length < 64 || opus.subarray(0, 4).toString('ascii') !== 'OggS') {
            reject(new Error('TTS did not produce a valid Ogg Opus file'))
            return
          }
          resolve(opus)
        } catch (error) {
          reject(error)
        } finally {
          try { unlinkSync(textPath) } catch { /* already removed */ }
          try { unlinkSync(opusPath) } catch { /* not created or already removed */ }
        }
      })
    })
  }

  #concatenate(clips: Buffer[]): Promise<Buffer> {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'vhf-watch-tts-session-'))
    const listPath = path.join(directory, 'clips.txt')
    const outputPath = path.join(directory, 'session.opus')
    const clipPaths = clips.map((clip, index) => {
      const clipPath = path.join(directory, `${index}.opus`)
      writeFileSync(clipPath, clip, { mode: 0o600 })
      return clipPath
    })
    writeFileSync(listPath, clipPaths.map((clipPath) => `file '${clipPath}'`).join('\n'), { mode: 0o600 })
    return new Promise((resolve, reject) => {
      const child = spawn(this.#ffmpegCommand, [
        '-nostdin', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0',
        '-i', listPath, '-map', '0:a:0', '-c', 'copy', '-f', 'opus', outputPath
      ], { stdio: ['ignore', 'ignore', 'pipe'] })
      let stderr = ''
      const timeout = setTimeout(() => child.kill('SIGKILL'), 30_000)
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-8_192) })
      child.on('error', reject)
      child.on('close', (code, signal) => {
        clearTimeout(timeout)
        try {
          if (code !== 0) {
            reject(new Error(signal === 'SIGKILL' ? 'Transcript audio assembly timed out' : stderr.trim() || `FFmpeg exited ${code}`))
            return
          }
          resolve(readFileSync(outputPath))
        } catch (error) {
          reject(error)
        } finally {
          rmSync(directory, { recursive: true, force: true })
        }
      })
    })
  }

  #cacheSession(key: string, opus: Buffer): void {
    const existing = this.#sessionCache.get(key)
    if (existing) this.#sessionCacheBytes -= existing.bytes
    this.#sessionCache.set(key, { opus, bytes: opus.length })
    this.#sessionCacheBytes += opus.length
    while (this.#sessionCacheBytes > MAX_SESSION_CACHE_BYTES && this.#sessionCache.size > 1) {
      const oldestKey = this.#sessionCache.keys().next().value as string
      const oldest = this.#sessionCache.get(oldestKey)!
      this.#sessionCache.delete(oldestKey)
      this.#sessionCacheBytes -= oldest.bytes
    }
  }

  #killChild(signal: NodeJS.Signals): void {
    const child = this.#child
    if (!child?.pid) return
    if (process.platform !== 'win32') {
      try {
        process.kill(-child.pid, signal)
        return
      } catch { /* process group already exited; fall back to the child */ }
    }
    child.kill(signal)
  }
}
