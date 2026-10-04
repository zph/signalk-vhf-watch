import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { WhisperServerPool } from '../src/whisper-server-pool'

function mockServer(options: { blockInference?: boolean; killDelayMs?: number; requests: Record<string, unknown>[]; starts: string[]; kills: string[] }) {
  const spawn = ((_: string, args: readonly string[]) => {
    const argument = (name: string): string => args[args.indexOf(name) + 1]!
    options.starts.push(`${argument('--model')}|${argument('--threads')}|${args.includes('--no-gpu')}`)
    const child = new EventEmitter() as ChildProcess
    Object.assign(child, { exitCode: null, signalCode: null })
    child.kill = ((signal?: NodeJS.Signals | number) => {
      options.kills.push(String(signal))
      Object.assign(child, { exitCode: 0, signalCode: typeof signal === 'string' ? signal : 'SIGTERM' })
      setTimeout(() => child.emit('close', 0, typeof signal === 'string' ? signal : 'SIGTERM'), options.killDelayMs ?? 0)
      return true
    }) as ChildProcess['kill']
    return child
  }) as never

  const fetchMock = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    if (url.endsWith('/health')) return new Response('{"status":"ok"}', { status: 200 })
    assert.ok(url.includes('/vhf-') && url.endsWith('/inference'), 'requests use their unguessable private route')
    const form = init?.body as FormData
    const file = form.get('file') as File
    options.requests.push({
      filename: file.name,
      type: file.type,
      language: form.get('language'),
      responseFormat: form.get('response_format'),
      tokenTimestamps: form.get('token_timestamps'),
      beamSize: form.get('beam_size'),
      bestOf: form.get('best_of'),
      temperature: form.get('temperature'),
      temperatureInc: form.get('temperature_inc')
    })
    if (options.blockInference) {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      })
    }
    return new Response('{"text":"test marine words"}', { status: 200 })
  }) as typeof fetch
  return { spawn, fetch: fetchMock }
}

test('keeps one CPU-only server warm per model and sends CLI-matched decode settings', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'vhf-server-pool-'))
  const wav = path.join(directory, 'input.wav')
  writeFileSync(wav, Buffer.alloc(128, 7))
  const state = { requests: [] as Record<string, unknown>[], starts: [] as string[], kills: [] as string[] }
  const mock = mockServer(state)
  const pool = new WhisperServerPool({
    modelsDir: directory,
    spawn: mock.spawn,
    fetch: mock.fetch,
    reservePort: async () => 49123,
    readyTimeoutMs: 2_000
  })
  const signal = new AbortController().signal
  try {
    assert.equal(await pool.transcribe('tiny.en-q5_1', 1, wav, signal, 2_000), 'test marine words')
    assert.equal(await pool.transcribe('tiny.en-q5_1', 1, wav, signal, 2_000), 'test marine words')
    assert.equal(state.starts.length, 1, 'the model is loaded once and reused')
    assert.equal(pool.residentModels.length, 1)
    assert.deepEqual(state.requests[0], {
      filename: 'recording.wav', type: 'audio/wav', language: 'en', responseFormat: 'json',
      tokenTimestamps: 'false', beamSize: '5', bestOf: '5', temperature: '0', temperatureInc: '0.2'
    })
    assert.deepEqual(state.starts, [`${path.join(directory, 'ggml-tiny.en-q5_1.bin')}|1|true`])
  } finally {
    await pool.closeAll()
    rmSync(directory, { recursive: true, force: true })
  }
  assert.deepEqual(state.kills, ['SIGTERM'])
})

test('aborted inference reaps its worker before returning', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'vhf-server-cancel-'))
  const wav = path.join(directory, 'input.wav')
  writeFileSync(wav, Buffer.alloc(128, 7))
  const state = { requests: [] as Record<string, unknown>[], starts: [] as string[], kills: [] as string[] }
  const mock = mockServer({ ...state, blockInference: true })
  const pool = new WhisperServerPool({
    modelsDir: directory,
    spawn: mock.spawn,
    fetch: mock.fetch,
    reservePort: async () => 49124,
    readyTimeoutMs: 2_000
  })
  const controller = new AbortController()
  try {
    const task = pool.transcribe('base.en-q5_1', 2, wav, controller.signal, 5_000)
    const until = Date.now() + 2_000
    while (state.requests.length === 0 && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal(state.requests.length, 1)
    controller.abort()
    await assert.rejects(task, /cancelled/i)
    assert.equal(pool.residentModels.length, 0)
  } finally {
    await pool.closeAll()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('closeAll waits for a worker already being reaped after request abort', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'vhf-server-double-stop-'))
  const wav = path.join(directory, 'input.wav')
  writeFileSync(wav, Buffer.alloc(128, 7))
  const state = { requests: [] as Record<string, unknown>[], starts: [] as string[], kills: [] as string[] }
  const mock = mockServer({ ...state, blockInference: true, killDelayMs: 80 })
  const pool = new WhisperServerPool({
    modelsDir: directory, spawn: mock.spawn, fetch: mock.fetch,
    reservePort: async () => 49127, readyTimeoutMs: 2_000
  })
  const controller = new AbortController()
  try {
    const task = pool.transcribe('base.en-q5_1', 2, wav, controller.signal, 5_000)
    const until = Date.now() + 2_000
    while (state.requests.length === 0 && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 5))
    controller.abort()
    while (state.kills.length === 0 && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 1))
    assert.deepEqual(state.kills, ['SIGTERM'])
    let finished = false
    const closing = pool.closeAll().then(() => { finished = true })
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(finished, false, 'closeAll waits for the already-started reap operation')
    await closing
    await assert.rejects(task, /cancelled/i)
    assert.equal(pool.residentModels.length, 0)
  } finally {
    await pool.closeAll()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('closeAll reaps a worker that has not finished readiness and prevents late registration', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'vhf-server-start-close-'))
  const wav = path.join(directory, 'input.wav')
  writeFileSync(wav, Buffer.alloc(128, 7))
  const state = { requests: [] as Record<string, unknown>[], starts: [] as string[], kills: [] as string[] }
  const mock = mockServer(state)
  const delayedHealth = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (String(input).endsWith('/health')) {
      await new Promise((resolve) => setTimeout(resolve, 40))
      return new Response('{"status":"ok"}', { status: 200 })
    }
    return mock.fetch(input, init)
  }) as typeof fetch
  const pool = new WhisperServerPool({
    modelsDir: directory, spawn: mock.spawn, fetch: delayedHealth,
    reservePort: async () => 49125, readyTimeoutMs: 2_000
  })
  try {
    const task = pool.transcribe('base.en-q5_1', 2, wav, new AbortController().signal, 2_000)
    while (state.starts.length === 0) await new Promise((resolve) => setTimeout(resolve, 1))
    await pool.closeAll()
    await assert.rejects(task, /cancelled/i)
    assert.equal(pool.residentModels.length, 0)
    assert.equal(state.starts.length, 1, 'a closed startup is not retried as a new server')
    assert.deepEqual(state.kills, ['SIGTERM'])
  } finally {
    await pool.closeAll()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('shutdown during port reservation cannot launch a late worker', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'vhf-server-port-race-'))
  const wav = path.join(directory, 'input.wav')
  writeFileSync(wav, Buffer.alloc(128, 7))
  const state = { requests: [] as Record<string, unknown>[], starts: [] as string[], kills: [] as string[] }
  const mock = mockServer(state)
  let releasePort!: (port: number) => void
  const reservedPort = new Promise<number>((resolve) => { releasePort = resolve })
  const pool = new WhisperServerPool({
    modelsDir: directory, spawn: mock.spawn, fetch: mock.fetch,
    reservePort: () => reservedPort, readyTimeoutMs: 2_000
  })
  try {
    const task = pool.transcribe('base.en-q5_1', 2, wav, new AbortController().signal, 2_000)
    await pool.closeAll()
    releasePort(49128)
    await assert.rejects(task, /cancelled/i)
    assert.equal(state.starts.length, 0)
    assert.equal(pool.residentModels.length, 0)
  } finally {
    await pool.closeAll()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('server spawn failures are bounded and fail readiness quickly', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'vhf-server-spawn-failure-'))
  const wav = path.join(directory, 'input.wav')
  writeFileSync(wav, Buffer.alloc(128, 7))
  let attempts = 0
  const failedSpawn = (() => {
    attempts += 1
    const child = new EventEmitter() as ChildProcess
    Object.assign(child, { exitCode: 1, signalCode: null })
    queueMicrotask(() => { child.emit('error', new Error('spawn denied')); child.emit('close', 1, null) })
    return child
  }) as never
  const neverReady = (async () => new Response('{"status":"loading model"}', { status: 503 })) as typeof fetch
  const pool = new WhisperServerPool({
    modelsDir: directory, spawn: failedSpawn, fetch: neverReady,
    reservePort: async () => 49126, readyTimeoutMs: 2_000
  })
  const started = Date.now()
  try {
    await assert.rejects(
      pool.transcribe('tiny.en-q5_1', 1, wav, new AbortController().signal, 2_000),
      /readiness checks/
    )
    assert.equal(attempts, 2)
    assert.ok(Date.now() - started < 1_500, 'spawn errors do not wait the full readiness timeout')
    assert.equal(pool.residentModels.length, 0)
  } finally {
    await pool.closeAll()
    rmSync(directory, { recursive: true, force: true })
  }
})
