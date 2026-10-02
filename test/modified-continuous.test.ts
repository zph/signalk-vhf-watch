import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import test from 'node:test'
import type { PluginRouter } from '@signalk/server-api'
import { registerRoutes } from '../src/api'
import type { ModifiedPlaybackStream } from '../src/modified-playback'
import type { ReplayPlaybackCursor, ReplayPlaybackPayload, ReplayPlaybackRead } from '../src/rolling-buffer'

type Handler = (request: any, response: any) => unknown

class RouteHarness {
  readonly handlers = new Map<string, Handler>()
  readonly router = {
    access: () => ({ get: (path: string, handler: Handler) => this.handlers.set(path, handler), post: () => undefined, put: () => undefined, delete: () => undefined })
  } as unknown as PluginRouter

  handler(path: string): Handler {
    const handler = this.handlers.get(path)
    assert.ok(handler, `route registered: ${path}`)
    return handler
  }
}

class FakeResponse extends EventEmitter {
  statusCode = 200
  headers: Record<string, string> = {}
  writes: Buffer[] = []
  destroyed = false
  writableEnded = false
  error?: Error
  status(code: number): this { this.statusCode = code; return this }
  set(headers: Record<string, string>): this { Object.assign(this.headers, headers); return this }
  flushHeaders(): void {}
  write(value: Buffer): boolean { this.writes.push(Buffer.from(value)); return true }
  end(): void { this.writableEnded = true; this.emit('close') }
  destroy(error?: Error): void { this.destroyed = true; this.error = error; this.emit('close') }
  json(_value: unknown): this { this.writableEnded = true; return this }
  send(_value: Buffer): this { this.writableEnded = true; return this }
}

class FakeStream implements ModifiedPlaybackStream {
  readonly stdout = new Readable({ read() {} })
  readonly writes: { pcm: Buffer; noise?: number }[] = []
  readonly completion: Promise<{ code: number; stderr: string }>
  #resolve!: (value: { code: number; stderr: string }) => void
  #drain: Array<() => void> = []
  #writeResults: boolean[]
  ended = false
  closeCount = 0
  constructor(writeResults: boolean[] = []) {
    this.#writeResults = [...writeResults]
    this.completion = new Promise((resolve) => { this.#resolve = resolve })
  }
  get bufferedBytes(): number { return 0 }
  write(pcm: Buffer, noise?: number): boolean {
    this.writes.push({ pcm: Buffer.from(pcm), noise })
    const result = this.#writeResults.shift() ?? true
    this.stdout.push(Buffer.from(pcm))
    return result
  }
  onDrain(callback: () => void): void { this.#drain.push(callback) }
  drain(): void { for (const callback of this.#drain.splice(0)) callback() }
  end(): void {
    if (this.ended) return
    this.ended = true
    this.stdout.push(null)
    this.#resolve({ code: 0, stderr: '' })
  }
  close(): void {
    this.closeCount += 1
    if (!this.ended) {
      this.stdout.destroy()
      this.#resolve({ code: 0, stderr: '' })
    }
  }
}

const pcm = (value: number, bytes = 4) => Buffer.alloc(bytes, value)

function cursor(channel = '16', id = 1): ReplayPlaybackCursor {
  return { id, slot: 'A', channel, startedAt: `2026-10-02T00:00:0${id}.000Z`, consumedBytes: 0 }
}

function payload(c: ReplayPlaybackCursor, data: Buffer): ReplayPlaybackPayload {
  return { id: c.id, slot: c.slot, channel: c.channel, startedAt: c.startedAt, pcm: data, qualitySpans: [{ bytes: data.length, discriminatorNoise: 0.2 }] }
}

function fixture(options: {
  reads: Array<ReplayPlaybackRead | (() => Promise<ReplayPlaybackRead>)>
  tail?: () => boolean
  writes?: boolean[]
  playback?: FakeStream
  channel?: string
}) {
  const routes = new RouteHarness()
  const stream = options.playback ?? new FakeStream(options.writes)
  const listeners = new Map<string, Set<(...args: any[]) => void>>()
  const counts = { joined: 0, left: 0 }
  const initial = cursor(options.channel)
  let index = 0
  let durableReads = 0
  const runtime = {
    config: { sampleRate: 16_000, enabled: true },
    replaySegment: () => ({ id: 1, slot: 'A', channel: initial.channel, startedAt: initial.startedAt }),
    replayPlaybackCursorFrom: () => initial,
    replayPlaybackCursorRead: async (_cursor: ReplayPlaybackCursor, _max: number, _payload?: ReplayPlaybackPayload) => {
      const item = options.reads[index++]
      if (item === undefined) throw new Error('unexpected cursor read')
      if (durableReads > 0) durableReads -= 1
      return typeof item === 'function' ? item() : item
    },
    replayPlaybackCursorHasData: () => durableReads > 0,
    replayPlaybackCursorSuccessor: () => undefined,
    canTailPlaybackCursor: options.tail ?? (() => true),
    listenerJoined: () => { counts.joined += 1 },
    listenerLeft: () => { counts.left += 1 },
    on: (event: string, listener: (...args: any[]) => void) => {
      const set = listeners.get(event) ?? new Set()
      set.add(listener); listeners.set(event, set)
    },
    off: (event: string, listener: (...args: any[]) => void) => listeners.get(event)?.delete(listener)
  }
  const playback = { openStream: async () => stream }
  registerRoutes(routes.router, () => runtime as any, () => playback as any)
  const response = new FakeResponse()
  const handler = routes.handler('/api/replay/:id/continuous.wav')
  const done = Promise.resolve(handler({ params: { id: '1' }, query: {}, headers: {} }, response))
  return {
    stream, response, done, counts, listeners,
    appendDurableRead(item: ReplayPlaybackRead) { options.reads.push(item); durableReads += 1 },
    emit(event: string, data: Buffer, noise = 0.1) { for (const listener of listeners.get(event) ?? []) listener(data, noise) }
  }
}

function historyRead(c: ReplayPlaybackCursor, data: Buffer, after?: ReplayPlaybackRead extends infer _ ? { kind: 'edge' } | { kind: 'advance'; cursor: ReplayPlaybackCursor } | { kind: 'channel-change' } : never): ReplayPlaybackRead {
  return { kind: 'chunk', cursor: { ...c, consumedBytes: c.consumedBytes + data.length }, payload: payload(c, data), pcm: data, after }
}

test('plays an old channel history through EOF without joining the current live channel', async () => {
  const old = cursor('16')
  const f = fixture({ channel: 'WX2', tail: () => false, reads: [historyRead(old, pcm(1)), { kind: 'end', reason: 'channel-change' }] })
  await f.done
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(f.stream.writes.map((write) => write.pcm), [pcm(1)])
  assert.equal(f.stream.ended, true)
  assert.equal(f.stream.closeCount, 1)
  assert.equal(f.counts.joined, 0)
})

test('does not join live audio while a historical prefix read is still pending', async () => {
  const old = cursor()
  let release!: (value: ReplayPlaybackRead) => void
  const f = fixture({ reads: [() => new Promise<ReplayPlaybackRead>((resolve) => { release = resolve })] })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(f.counts.joined, 0)
  assert.equal(f.listeners.get('rawAudio')?.size ?? 0, 0)
  release({ kind: 'edge', cursor: old })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(f.counts.joined, 1)
  assert.equal(f.listeners.get('rawAudio')?.size, 1)
  f.response.destroy()
  await f.done
})

test('drains a blocked final history write before queued live audio and EOF', async () => {
  const old = cursor()
  const f = fixture({ writes: [false, true, true], reads: [historyRead(old, pcm(1), { kind: 'edge' })] })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(f.counts.joined, 1)
  f.emit('rawAudio', pcm(2))
  assert.deepEqual(f.stream.writes.map((write) => write.pcm), [pcm(1)])
  f.stream.drain()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(f.stream.writes.map((write) => write.pcm), [pcm(1), pcm(2)])
  assert.equal(f.stream.ended, false)
  f.response.destroy()
  await f.done
  assert.equal(f.stream.closeCount, 1)
})

test('replays durable audio appended during backpressure before switching to live tail', async () => {
  const old = cursor()
  const next = { ...old, consumedBytes: 4 }
  const f = fixture({
    writes: [false, true, true],
    reads: [historyRead(old, pcm(1), { kind: 'advance', cursor: next })]
  })
  await new Promise((resolve) => setImmediate(resolve))
  f.appendDurableRead(historyRead(next, pcm(2), { kind: 'edge' }))
  f.stream.drain()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(f.stream.writes.map((write) => write.pcm), [pcm(1), pcm(2)])
  f.response.destroy()
  await f.done
})

test('retune flushes queued old-channel live audio before ending helper input', async () => {
  const old = cursor()
  let tail = true
  const f = fixture({ tail: () => tail, writes: [false, true, true], reads: [historyRead(old, pcm(1), { kind: 'edge' })] })
  await new Promise((resolve) => setImmediate(resolve))
  f.emit('rawAudio', pcm(2))
  tail = false
  f.emit('rawAudio', pcm(3))
  f.stream.drain()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(f.stream.writes.map((write) => write.pcm), [pcm(1), pcm(2)])
  assert.equal(f.stream.ended, true)
  assert.equal(f.counts.left, 1)
  await f.done
})
