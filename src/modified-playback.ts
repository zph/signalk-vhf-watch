import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { accessSync, constants } from 'node:fs'
import path from 'node:path'
import type { Readable, Writable } from 'node:stream'

const HELPER = process.env.VHF_PLAYBACK_HELPER ?? '/usr/lib/vhf-playback/vhf-playback-denoiser'
const MODEL = process.env.VHF_PLAYBACK_MODEL ?? '/usr/share/vhf-playback/gtcrn_simple.onnx'
const SAMPLE_RATE = 16_000
const MAX_INPUT_BYTES = 20 * 1024 * 1024
const MAX_ACTIVE = 2
const MAX_WAITING = 8
const MAX_CACHE_BYTES = 32 * 1024 * 1024
const CACHE_TTL_MS = 5 * 60_000
const START_TIMEOUT_MS = 5_000

type HelperProcess = ChildProcessWithoutNullStreams & { stdio: [Writable, Readable, Readable, Readable] }

export class ModifiedPlaybackError extends Error {
  constructor(message: string, readonly status: 503 | 413 = 503) {
    super(message)
    this.name = 'ModifiedPlaybackError'
  }
}

export interface ModifiedPlaybackStream {
  readonly stdout: Readable
  readonly completion: Promise<{ code: number; stderr: string; error?: Error }>
  readonly bufferedBytes: number
  write(pcm: Buffer, discriminatorNoise?: number): boolean
  onDrain(callback: () => void): void
  end(): void
  close(): void
}

interface CacheEntry { pcm: Buffer; expiresAt: number }
export interface PlaybackQualitySpan { bytes: number; discriminatorNoise?: number }
interface InFlightEntry { promise: Promise<Buffer>; controller: AbortController; consumers: number }

function validatedQuietingIntensity(value: number | undefined): number {
  const intensity = value ?? 100
  if (!Number.isFinite(intensity) || intensity < 0 || intensity > 100) {
    throw new ModifiedPlaybackError('Between-transmission quieting must be between 0 and 100%')
  }
  return intensity
}

/** Isolated GTCRN playback worker; it is deliberately separate from transcription. */
export class ModifiedPlayback {
  readonly #helper: string
  readonly #model: string
  #active = 0
  #waiters: Array<() => void> = []
  #cache = new Map<string, CacheEntry>()
  #inflight = new Map<string, InFlightEntry>()
  #finished = new WeakMap<HelperProcess, Promise<{ code: number; stderr: string; error?: Error }>>()
  #workers = new Set<HelperProcess>()
  #cacheBytes = 0
  #closed = false

  constructor(helper = HELPER, model = MODEL) {
    this.#helper = helper
    this.#model = model
  }

  available(sampleRate: number): boolean {
    if (this.#closed) return false
    if (sampleRate !== SAMPLE_RATE) return false
    try {
      accessSync(this.#helper, constants.X_OK)
      accessSync(this.#model, constants.R_OK)
      return true
    } catch {
      return false
    }
  }

  shutdown(): void {
    if (this.#closed) return
    this.#closed = true
    this.#cache.clear()
    this.#cacheBytes = 0
    for (const entry of this.#inflight.values()) entry.controller.abort()
    // Wake queued acquisitions so they can observe the closed state and release
    // their reserved slots instead of surviving a plugin stop indefinitely.
    for (const wake of this.#waiters.splice(0)) wake()
    for (const worker of this.#workers) this.#terminate(worker)
  }

  async processPcm(
    pcm: Buffer,
    sampleRate: number,
    options: { discriminatorNoise?: number; qualitySpans?: PlaybackQualitySpan[]; quietingIntensity?: number; cacheKey?: string; stillCurrent?: () => boolean; signal?: AbortSignal } = {}
  ): Promise<Buffer> {
    const quietingIntensity = validatedQuietingIntensity(options.quietingIntensity)
    if (this.#closed) throw new ModifiedPlaybackError('Modified playback service is stopped; choose Raw')
    if (!this.available(sampleRate)) throw new ModifiedPlaybackError(
      sampleRate === SAMPLE_RATE
        ? 'Modified playback is unavailable; choose Raw or install vhf-playback-runtime'
        : 'Modified playback currently supports 16 kHz recordings only; choose Raw'
    )
    if (pcm.length > MAX_INPUT_BYTES) throw new ModifiedPlaybackError('Modified playback input exceeds the 20 MiB limit', 413)
    if (pcm.length % 2 !== 0) throw new ModifiedPlaybackError('Modified playback input must contain complete PCM16 samples')
    if (options.signal?.aborted) throw new ModifiedPlaybackError('Modified playback request was cancelled')
    const spans = options.qualitySpans?.length ? options.qualitySpans : [{ bytes: pcm.length, discriminatorNoise: options.discriminatorNoise }]
    if (spans.reduce((sum, span) => sum + span.bytes, 0) !== pcm.length || spans.some((span) => span.bytes < 0 || span.bytes % 2)) {
      throw new ModifiedPlaybackError('Modified playback quality metadata does not match the PCM source')
    }
    const keyHash = createHash('sha256').update(options.cacheKey ?? '').update(`quieting:${quietingIntensity};`).update(pcm)
    for (const span of spans) keyHash.update(String(span.bytes)).update(':').update(String(span.discriminatorNoise ?? 'unknown')).update(';')
    const key = options.cacheKey ? keyHash.digest('hex') : undefined
    if (key) {
      this.#pruneCache()
      const cached = this.#cache.get(key)
      if (cached && (!options.stillCurrent || options.stillCurrent())) return Buffer.from(cached.pcm)
      const inFlight = this.#inflight.get(key)
      if (inFlight) return this.#join(inFlight, options.signal, options.stillCurrent)
    }
    if (key) {
      const controller = new AbortController()
      const entry: InFlightEntry = { promise: Promise.resolve(Buffer.alloc(0)), controller, consumers: 0 }
      entry.promise = this.#process(pcm, key, { ...options, quietingIntensity, qualitySpans: spans, signal: controller.signal })
      this.#inflight.set(key, entry)
      void entry.promise.finally(() => { if (this.#inflight.get(key) === entry) this.#inflight.delete(key) }).catch(() => {})
      return this.#join(entry, options.signal, options.stillCurrent)
    }
    return this.#process(pcm, undefined, { ...options, quietingIntensity, qualitySpans: spans })
  }

  #join(entry: InFlightEntry, signal?: AbortSignal, stillCurrent?: () => boolean): Promise<Buffer> {
    if (signal?.aborted) return Promise.reject(new ModifiedPlaybackError('Modified playback request was cancelled'))
    entry.consumers += 1
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', abort)
        entry.consumers = Math.max(0, entry.consumers - 1)
      }
      const abort = (): void => {
        finish()
        if (entry.consumers === 0) entry.controller.abort()
        reject(new ModifiedPlaybackError('Modified playback request was cancelled'))
      }
      signal?.addEventListener('abort', abort, { once: true })
      entry.promise.then((pcm) => {
        if (settled) return
        finish()
        if (stillCurrent && !stillCurrent()) reject(new ModifiedPlaybackError('Replay source expired during Modified playback'))
        else resolve(Buffer.from(pcm))
      }, (error: unknown) => { if (!settled) { finish(); reject(error) } })
    })
  }

  async #process(
    pcm: Buffer,
    key: string | undefined,
    options: { qualitySpans: PlaybackQualitySpan[]; quietingIntensity: number; stillCurrent?: () => boolean; signal?: AbortSignal }
  ): Promise<Buffer> {
    const release = await this.#acquire(options.signal)
    try {
      const child = await this.#start(options.signal, options.quietingIntensity)
      const output: Buffer[] = []
      let outputBytes = 0
      let overflow = false
      child.stdout.on('data', (chunk: Buffer) => {
        outputBytes += chunk.length
        if (outputBytes > pcm.length) { overflow = true; child.kill('SIGTERM'); return }
        output.push(Buffer.from(chunk))
      })
      ;(child.stdio as unknown as Readable[])[3]!.resume()
      const finished = this.#finished.get(child)!
      const abort = (): void => this.#terminate(child)
      options.signal?.addEventListener('abort', abort, { once: true })
      try {
        let offset = 0
        for (const span of options.qualitySpans) {
          const part = pcm.subarray(offset, offset + span.bytes)
          await this.#writeRecord(child.stdin, part, span.discriminatorNoise, options.signal, finished)
          offset += span.bytes
        }
        child.stdin.end()
      } catch (error) {
        abort()
        await finished.catch(() => undefined)
        options.signal?.removeEventListener('abort', abort)
        throw error
      }
      const result = await finished
      options.signal?.removeEventListener('abort', abort)
      if (options.signal?.aborted) throw new ModifiedPlaybackError('Modified playback request was cancelled')
      if (overflow) throw new ModifiedPlaybackError('Modified playback helper exceeded the output size limit')
      if (result.code !== 0 || result.error) throw new ModifiedPlaybackError(result.stderr || result.error?.message || `GTCRN playback helper exited ${result.code}`)
      const denoised = Buffer.concat(output)
      if (denoised.length !== pcm.length) throw new ModifiedPlaybackError('Modified playback helper returned an unexpected sample count')
      if (options.stillCurrent && !options.stillCurrent()) throw new ModifiedPlaybackError('Replay source expired during Modified playback')
      if (key) this.#cachePut(key, denoised)
      return denoised
    } finally {
      release()
    }
  }

  async openStream(sampleRate: number, signal?: AbortSignal, quietingIntensity = 100): Promise<ModifiedPlaybackStream> {
    quietingIntensity = validatedQuietingIntensity(quietingIntensity)
    if (this.#closed) throw new ModifiedPlaybackError('Modified playback service is stopped; choose Raw')
    if (!this.available(sampleRate)) throw new ModifiedPlaybackError(
      sampleRate === SAMPLE_RATE
        ? 'Modified playback is unavailable; choose Raw or install vhf-playback-runtime'
        : 'Modified playback currently supports 16 kHz audio only; choose Raw'
    )
    const release = await this.#acquire(signal)
    let child: HelperProcess
    try { child = await this.#start(signal, quietingIntensity) } catch (error) { release(); throw error }
    let closed = false
    const finish = (): void => {
      if (closed) return
      closed = true
      signal?.removeEventListener('abort', close)
      release()
    }
    const close = (): void => {
      if (closed) return
      this.#terminate(child)
    }
    child.once('close', finish)
    const completion = this.#finished.get(child)!
    signal?.addEventListener('abort', close, { once: true })
    ;(child.stdio as unknown as Readable[])[3]!.resume()
    if (signal?.aborted) close()
    return {
      stdout: child.stdout,
      completion,
      get bufferedBytes() { return child.stdin.writableLength },
      write: (pcm, discriminatorNoise) => {
        if (closed) return false
        if (pcm.length === 0 || pcm.length % 2 !== 0 || pcm.length > SAMPLE_RATE * 2 * 2) {
          throw new ModifiedPlaybackError('Modified playback stream requires nonempty, even PCM16 chunks no larger than two seconds')
        }
        const packet = this.#record(pcm, discriminatorNoise)
        const writable = child.stdin.write(packet)
        // Only Writable.write()'s result guarantees whether a later `drain`
        // event will fire. A separate byte threshold can wait for an event
        // that Node will never emit when the stream is still below its HWM.
        return writable
      },
      onDrain: (callback) => child.stdin.once('drain', callback),
      end: () => child.stdin.end(),
      close
    }
  }

  #spawn(quietingIntensity: number): HelperProcess {
    if (this.#closed) throw new ModifiedPlaybackError('Modified playback service is stopped; choose Raw')
    const child = spawn(this.#helper, ['--model', this.#model, '--sample-rate', String(SAMPLE_RATE), '--quieting', String(quietingIntensity)], {
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      env: { ...process.env, LD_LIBRARY_PATH: path.join(path.dirname(this.#helper), 'lib') }
    }) as HelperProcess
    this.#workers.add(child)
    child.once('close', () => this.#workers.delete(child))
    this.#finished.set(child, this.#finish(child))
    return child
  }

  async #start(signal?: AbortSignal, quietingIntensity = 100): Promise<HelperProcess> {
    const child = this.#spawn(quietingIntensity)
    const ready = (child.stdio as unknown as Readable[])[3]!
    let stderr = ''
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-8_192) })
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => { cleanup(); reject(new ModifiedPlaybackError('GTCRN playback helper did not become ready')) }, START_TIMEOUT_MS)
        const abort = (): void => { cleanup(); reject(signal?.reason ?? new ModifiedPlaybackError('Modified playback request was cancelled')) }
        const onReady = (chunk: Buffer): void => {
          if (chunk.includes(0x52)) { cleanup(); resolve() }
        }
        const onClose = (code: number | null): void => { cleanup(); reject(new ModifiedPlaybackError(stderr.trim() || `GTCRN helper exited during startup (${code})`)) }
        const cleanup = (): void => {
          clearTimeout(timeout)
          ready.off('data', onReady)
          child.off('close', onClose)
          signal?.removeEventListener('abort', abort)
        }
        ready.on('data', onReady)
        child.once('close', onClose)
        signal?.addEventListener('abort', abort, { once: true })
        if (signal?.aborted) abort()
      })
      return child
    } catch (error) {
      child.kill('SIGTERM')
      if (child.exitCode === null) await new Promise<void>((resolve) => child.once('close', () => resolve()))
      throw error
    }
  }

  async #writeRecord(
    stdin: Writable,
    pcm: Buffer,
    discriminatorNoise: number | undefined,
    signal: AbortSignal | undefined,
    finished: Promise<{ code: number; stderr: string; error?: Error }>
  ): Promise<void> {
    const packet = this.#record(pcm, discriminatorNoise)
    if (packet.length === 0) return
    if (!stdin.write(packet)) await new Promise<void>((resolve, reject) => {
      let settled = false
      const cleanup = (): void => {
        stdin.off('drain', onDrain)
        stdin.off('error', onError)
        stdin.off('close', onClose)
        signal?.removeEventListener('abort', onAbort)
      }
      const finish = (error?: Error): void => {
        if (settled) return
        settled = true
        cleanup()
        if (error) reject(error)
        else resolve()
      }
      const onDrain = (): void => finish()
      const onError = (error: Error): void => finish(error)
      const onClose = (): void => finish(new ModifiedPlaybackError('GTCRN playback helper closed its input before draining'))
      const onAbort = (): void => finish(new ModifiedPlaybackError('Modified playback request was cancelled'))
      stdin.once('drain', onDrain)
      stdin.once('error', onError)
      stdin.once('close', onClose)
      signal?.addEventListener('abort', onAbort, { once: true })
      void finished.then((result) => {
        if (result.code !== 0 || result.error) finish(new ModifiedPlaybackError(result.stderr || result.error?.message || `GTCRN playback helper exited ${result.code}`))
      })
      if (signal?.aborted) onAbort()
    })
  }

  #record(pcm: Buffer, discriminatorNoise?: number): Buffer {
    if (pcm.length === 0 || pcm.length % 2 !== 0 || pcm.length > MAX_INPUT_BYTES) {
      throw new ModifiedPlaybackError('Modified playback input must be nonempty, even PCM16 and no larger than 20 MiB', pcm.length > MAX_INPUT_BYTES ? 413 : 503)
    }
    const header = Buffer.allocUnsafe(8)
    header.writeUInt32LE(pcm.length, 0)
    header.writeFloatLE(discriminatorNoise !== undefined && Number.isFinite(discriminatorNoise) ? discriminatorNoise : Number.NaN, 4)
    return Buffer.concat([header, pcm], header.length + pcm.length)
  }

  #finish(child: HelperProcess): Promise<{ code: number; stderr: string; error?: Error }> {
    let stderr = ''
    let processError: Error | undefined
    return new Promise((resolve) => {
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-8_192) })
      child.once('error', (error) => { processError = error })
      child.once('close', (code) => resolve({ code: code ?? 1, stderr: stderr.trim(), ...(processError ? { error: processError } : {}) }))
    })
  }

  async #acquire(signal?: AbortSignal): Promise<() => void> {
    if (this.#closed) throw new ModifiedPlaybackError('Modified playback service is stopped; choose Raw')
    if (signal?.aborted) throw new ModifiedPlaybackError('Modified playback request was cancelled')
    if (this.#active >= MAX_ACTIVE) {
      if (this.#waiters.length >= MAX_WAITING) throw new ModifiedPlaybackError('Modified playback is busy; try Raw or retry shortly')
      await new Promise<void>((resolve, reject) => {
        const ready = (): void => { signal?.removeEventListener('abort', abort); resolve() }
        const abort = (): void => {
          const index = this.#waiters.indexOf(ready)
          if (index >= 0) this.#waiters.splice(index, 1)
          reject(signal?.reason ?? new ModifiedPlaybackError('Modified playback request was cancelled'))
        }
        this.#waiters.push(ready)
        signal?.addEventListener('abort', abort, { once: true })
        if (signal?.aborted) abort()
      })
      if (this.#closed) {
        this.#active = Math.max(0, this.#active - 1)
        const next = this.#waiters.shift()
        if (next) { this.#active += 1; next() }
        throw new ModifiedPlaybackError('Modified playback service is stopped; choose Raw')
      }
    } else this.#active += 1
    let released = false
    return () => {
      if (released) return
      released = true
      this.#active = Math.max(0, this.#active - 1)
      const next = this.#waiters.shift()
      if (next) { this.#active += 1; next() }
    }
  }

  #terminate(child: HelperProcess): void {
    child.stdin.destroy()
    if (child.exitCode !== null || child.signalCode !== null) return
    child.kill('SIGTERM')
    const forceKill = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }, 1_000)
    forceKill.unref()
  }

  #cachePut(key: string, pcm: Buffer): void {
    if (pcm.length > MAX_CACHE_BYTES) return
    this.#pruneCache()
    const old = this.#cache.get(key)
    if (old) this.#cacheBytes -= old.pcm.length
    this.#cache.delete(key)
    while (this.#cacheBytes + pcm.length > MAX_CACHE_BYTES && this.#cache.size > 0) {
      const oldest = this.#cache.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.#cacheBytes -= this.#cache.get(oldest)!.pcm.length
      this.#cache.delete(oldest)
    }
    this.#cache.set(key, { pcm: Buffer.from(pcm), expiresAt: Date.now() + CACHE_TTL_MS })
    this.#cacheBytes += pcm.length
  }

  #pruneCache(): void {
    const now = Date.now()
    for (const [key, value] of this.#cache) {
      if (value.expiresAt <= now) { this.#cacheBytes -= value.pcm.length; this.#cache.delete(key) }
    }
  }
}
