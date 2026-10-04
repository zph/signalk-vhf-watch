import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { accessSync, constants } from 'node:fs'
import path from 'node:path'

export const DEFAULT_WHISPER_SERVER_COMMAND = '/usr/bin/vhf-whisper-server'
const READY_TIMEOUT_MS = 60_000
const REQUEST_BODY_LIMIT = 1024 * 1024

export class WhisperServerCancelledError extends Error {
  constructor() { super('Whisper server request cancelled') }
}

interface Worker {
  key: string
  port: number
  prefix: string
  child: ChildProcess
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  stopped: boolean
  exited: boolean
  stopPromise?: Promise<void>
  startError?: Error
}

export interface WhisperServerPoolOptions {
  command?: string
  modelsDir: string
  fetch?: typeof fetch
  spawn?: typeof spawn
  readyTimeoutMs?: number
  reservePort?: () => Promise<number>
}

/** Owns at most two loopback whisper.cpp servers, one resident context per model/thread pair. */
export class WhisperServerPool {
  readonly #command: string
  readonly #modelsDir: string
  readonly #fetch: typeof fetch
  readonly #spawn: typeof spawn
  readonly #readyTimeoutMs: number
  readonly #reservePort: () => Promise<number>
  readonly #workers = new Map<string, Worker>()
  readonly #stopping = new Set<Promise<void>>()
  #generation = 0

  constructor(options: WhisperServerPoolOptions) {
    this.#command = options.command ?? DEFAULT_WHISPER_SERVER_COMMAND
    this.#modelsDir = options.modelsDir
    this.#fetch = options.fetch ?? fetch
    this.#spawn = options.spawn ?? spawn
    this.#readyTimeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_MS
    this.#reservePort = options.reservePort ?? reserveLoopbackPort
  }

  get available(): boolean {
    try { accessSync(this.#command, constants.X_OK); return true } catch { return false }
  }

  get residentModels(): string[] {
    return [...this.#workers.values()]
      .filter((worker) => !worker.stopped && !worker.exited)
      .map((worker) => worker.key.slice(0, worker.key.lastIndexOf(':')))
  }

  async transcribe(
    model: string,
    threads: number,
    wavPath: string,
    signal: AbortSignal,
    timeoutMs: number,
    onWorker?: (child: ChildProcess | undefined) => void
  ): Promise<string> {
    if (signal.aborted) throw new WhisperServerCancelledError()
    const generation = this.#generation
    const key = `${model}:${threads}`
    let worker = this.#workers.get(key)
    if (worker?.stopped) {
      await worker.stopPromise
      worker = undefined
    }
    if (!worker) {
      if (!worker && this.#workers.size >= 2) {
        const oldest = this.#workers.values().next().value as Worker | undefined
        if (oldest) await this.#stopWorker(oldest)
      }
      worker = await this.#startWorker(model, threads, key, signal, generation)
      if (generation !== this.#generation) {
        await this.#stopWorker(worker)
        throw new WhisperServerCancelledError()
      }
      this.#workers.set(key, worker)
    }
    onWorker?.(worker.child)
    try { return await this.#request(worker, wavPath, signal, timeoutMs) }
    finally { onWorker?.(undefined) }
  }

  async closeAll(): Promise<void> {
    this.#generation += 1
    await Promise.all([
      ...[...this.#workers.values()].map((worker) => this.#stopWorker(worker)),
      ...this.#stopping
    ])
  }

  async #startWorker(model: string, threads: number, key: string, signal: AbortSignal, generation: number): Promise<Worker> {
    let lastError: Error | undefined
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (signal.aborted || generation !== this.#generation) throw new WhisperServerCancelledError()
      const port = await this.#reservePort()
      if (signal.aborted || generation !== this.#generation) throw new WhisperServerCancelledError()
      const prefix = `/vhf-${randomBytes(12).toString('hex')}`
      const modelPath = path.join(this.#modelsDir, `ggml-${model}.bin`)
      const child = this.#spawn(this.#command, [
        '--model', modelPath, '--language', 'en', '--threads', String(threads),
        '--beam-size', '5', '--best-of', '5', '--no-gpu',
        '--host', '127.0.0.1', '--port', String(port), '--request-path', prefix
      ], { stdio: 'ignore' })
      let resolveExit!: (result: { code: number | null; signal: NodeJS.Signals | null }) => void
      const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => { resolveExit = resolve })
      child.once('close', (code, childSignal) => resolveExit({ code, signal: childSignal }))
      child.once('error', () => resolveExit({ code: null, signal: null }))
      const worker: Worker = { key, port, prefix, child, exit, stopped: false, exited: false }
      child.once('error', (error) => { worker.startError = error })
      child.once('close', () => {
        worker.exited = true
        if (this.#workers.get(key) === worker) this.#workers.delete(key)
      })
      this.#workers.set(key, worker)
      try {
        await this.#waitReady(worker, signal)
        if (worker.stopped || signal.aborted || generation !== this.#generation) throw new WhisperServerCancelledError()
        return worker
      } catch (error) {
        lastError = error instanceof Error ? error : new Error('Whisper server failed to start')
        await this.#stopWorker(worker)
        if (signal.aborted || generation !== this.#generation) throw new WhisperServerCancelledError()
      }
    }
    throw new Error(lastError instanceof WhisperServerCancelledError ? 'Whisper server start cancelled' : 'Whisper server failed readiness checks')
  }

  async #waitReady(worker: Worker, signal: AbortSignal): Promise<void> {
    const deadline = Date.now() + this.#readyTimeoutMs
    while (Date.now() < deadline) {
      if (signal.aborted) throw new WhisperServerCancelledError()
      if (worker.startError || worker.exited || worker.child.exitCode !== null || worker.child.signalCode !== null) {
        throw new Error('Whisper server exited during startup')
      }
      const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(500)])
      try {
        const response = await this.#fetch(this.#url(worker, '/health'), { signal: requestSignal })
        if (response.ok) {
          const body = JSON.parse(await readBoundedText(response, 4_096)) as { status?: unknown }
          if (body.status === 'ok') return
        }
      } catch {
        if (signal.aborted) throw new WhisperServerCancelledError()
      }
      await delay(200, signal)
    }
    throw new Error('Whisper server readiness timed out')
  }

  async #request(worker: Worker, wavPath: string, signal: AbortSignal, timeoutMs: number): Promise<string> {
    const timer = AbortSignal.timeout(timeoutMs)
    const requestSignal = AbortSignal.any([signal, timer])
    try {
      const wav = await readFile(wavPath)
      if (signal.aborted) throw new WhisperServerCancelledError()
      const form = new FormData()
      form.set('file', new Blob([wav], { type: 'audio/wav' }), 'recording.wav')
      form.set('language', 'en')
      form.set('response_format', 'json')
      form.set('token_timestamps', 'false')
      form.set('beam_size', '5')
      form.set('best_of', '5')
      form.set('temperature', '0')
      form.set('temperature_inc', '0.2')
      const response = await this.#fetch(this.#url(worker, '/inference'), { method: 'POST', body: form, signal: requestSignal })
      const text = await readBoundedText(response, REQUEST_BODY_LIMIT)
      if (!response.ok) throw new Error('Whisper server inference failed')
      let parsed: unknown
      try { parsed = JSON.parse(text) } catch { throw new Error('Whisper server returned invalid output') }
      if (!parsed || typeof parsed !== 'object' || !('text' in parsed) || typeof parsed.text !== 'string') {
        throw new Error('Whisper server returned invalid output')
      }
      return parsed.text
    } catch (error) {
      if (signal.aborted) {
        await this.#stopWorker(worker)
        throw new WhisperServerCancelledError()
      }
      if (timer.aborted) {
        await this.#stopWorker(worker)
        throw new Error('Transcription timed out')
      }
      if (error instanceof WhisperServerCancelledError) throw error
      if (error instanceof TypeError || requestSignal.aborted) await this.#stopWorker(worker)
      throw error instanceof Error && error.message.startsWith('Whisper server')
        ? error
        : new Error('Whisper server request failed')
    }
  }

  #url(worker: Worker, suffix: string): string {
    return `http://127.0.0.1:${worker.port}${worker.prefix}${suffix}`
  }

  async #stopWorker(worker: Worker): Promise<void> {
    if (worker.stopPromise) return worker.stopPromise
    worker.stopped = true
    worker.stopPromise = (async () => {
      if (!worker.exited && worker.child.exitCode === null && worker.child.signalCode === null) {
        worker.child.kill('SIGTERM')
        const exited = await Promise.race([worker.exit.then(() => true), delay(1_500).then(() => false)])
        if (!exited && !worker.exited && worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill('SIGKILL')
      }
      await worker.exit
      if (this.#workers.get(worker.key) === worker) this.#workers.delete(worker.key)
    })()
    this.#stopping.add(worker.stopPromise)
    void worker.stopPromise.then(
      () => this.#stopping.delete(worker.stopPromise!),
      () => this.#stopping.delete(worker.stopPromise!)
    )
    return worker.stopPromise
  }
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Unable to reserve a loopback port')
  const port = address.port
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return port
}

async function readBoundedText(response: Response, maximumBytes: number): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    bytes += value.byteLength
    if (bytes > maximumBytes) {
      await reader.cancel()
      throw new Error('Whisper server response exceeded limit')
    }
    chunks.push(value)
  }
  const result = new Uint8Array(bytes)
  let offset = 0
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength }
  return new TextDecoder().decode(result)
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new WhisperServerCancelledError()); return }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, milliseconds)
    const abort = (): void => { clearTimeout(timer); reject(new WhisperServerCancelledError()) }
    signal?.addEventListener('abort', abort, { once: true })
  })
}
