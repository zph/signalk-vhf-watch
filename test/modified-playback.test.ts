import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Writable } from 'node:stream'
import { ModifiedPlayback, ModifiedPlaybackError } from '../src/modified-playback'

const childProcess = require('node:child_process') as typeof import('node:child_process')

const helperSource = `#!/usr/bin/env node
const fs = require('node:fs')
const model = process.argv[process.argv.indexOf('--model') + 1]
const runFile = model + '.runs'
fs.appendFileSync(runFile, 'run\\n')
fs.appendFileSync(model + '.quieting', process.argv[process.argv.indexOf('--quieting') + 1] + '\\n')
fs.writeSync(3, 'R')
let pending = Buffer.alloc(0)
let pcm = []
process.stdin.on('data', (chunk) => {
  pending = Buffer.concat([pending, chunk])
  while (pending.length >= 8) {
    const bytes = pending.readUInt32LE(0)
    if (pending.length < 8 + bytes) break
    const noise = pending.readFloatLE(4)
    fs.appendFileSync(model + '.records', noise + ':' + bytes + '\\n')
    pcm.push(Buffer.from(pending.subarray(8, 8 + bytes)))
    pending = pending.subarray(8 + bytes)
  }
})
process.stdin.on('end', () => {
  const finish = () => process.stdout.write(Buffer.concat(pcm))
  if (fs.existsSync(model + '.slow')) setTimeout(finish, 100)
  else finish()
})
`

function fixture(t: { after(callback: () => void): void }) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'vhf-modified-playback-'))
  const helper = path.join(directory, 'helper.js')
  const model = path.join(directory, 'model.onnx')
  writeFileSync(helper, helperSource)
  writeFileSync(model, 'fixture')
  chmodSync(helper, 0o755)
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return { directory, helper, model, playback: new ModifiedPlayback(helper, model) }
}

test('finite processing preserves exact samples and forwards quality spans', async (t) => {
  const f = fixture(t)
  const source = Buffer.from([1, 0, 2, 0, 3, 0, 4, 0])
  const result = await f.playback.processPcm(source, 16_000, {
    qualitySpans: [{ bytes: 4, discriminatorNoise: 0.31 }, { bytes: 4 }]
  })
  assert.deepEqual(result, source)
  assert.equal(readFileSync(`${f.model}.records`, 'utf8'), '0.3100000023841858:4\nNaN:4\n')
})

test('identical finite requests coalesce and cache without sharing mutable buffers', async (t) => {
  const f = fixture(t)
  writeFileSync(`${f.model}.slow`, '')
  const source = Buffer.alloc(16_000, 7)
  const options = { cacheKey: 'archive:11', stillCurrent: () => true }
  const [first, second] = await Promise.all([
    f.playback.processPcm(source, 16_000, options),
    f.playback.processPcm(source, 16_000, options)
  ])
  assert.deepEqual(first, source)
  assert.deepEqual(second, source)
  first[0] = 99
  assert.equal(second[0], 7)
  assert.equal(readFileSync(`${f.model}.runs`, 'utf8').trim().split('\n').length, 1)
  const cached = await f.playback.processPcm(source, 16_000, options)
  assert.equal(cached[0], 7)
  assert.equal(readFileSync(`${f.model}.runs`, 'utf8').trim().split('\n').length, 1)
})

test('quieting intensity separates cached work and reaches finite and streaming helpers', async (t) => {
  const f = fixture(t)
  const source = Buffer.alloc(32, 7)
  await f.playback.processPcm(source, 16_000, { cacheKey: 'archive:same', quietingIntensity: 100 })
  await f.playback.processPcm(source, 16_000, { cacheKey: 'archive:same', quietingIntensity: 50 })
  const stream = await f.playback.openStream(16_000, undefined, 0)
  stream.end()
  await stream.completion
  assert.equal(readFileSync(`${f.model}.runs`, 'utf8').trim().split('\n').length, 3)
  assert.equal(readFileSync(`${f.model}.quieting`, 'utf8'), '100\n50\n0\n')
})

test('openStream preserves Writable backpressure and drain semantics', async (t) => {
  const f = fixture(t)
  const originalSpawn = childProcess.spawn
  let child: import('node:child_process').ChildProcessWithoutNullStreams | undefined
  t.mock.method(childProcess, 'spawn', (...args: Parameters<typeof childProcess.spawn>) => {
    const spawned = originalSpawn(...args)
    child = spawned as import('node:child_process').ChildProcessWithoutNullStreams
    return spawned
  })
  const stream = await f.playback.openStream(16_000)
  let releaseFirstWrite: (() => void) | undefined
  let writes = 0
  const controlledInput = new Writable({
    highWaterMark: 65_536,
    write(_chunk, _encoding, callback) {
      writes += 1
      if (writes === 1) releaseFirstWrite = callback
      else callback()
    }
  })
  const runningChild = child!
  runningChild.stdin = controlledInput

  // The first framed 2-second PCM packet is 64,008 bytes. Node's pipe HWM is
  // 65,536, so write() returns true and does not promise a later drain event.
  assert.equal(stream.write(Buffer.alloc(64_000)), true)
  assert.equal(stream.bufferedBytes, 64_008)

  const drained = new Promise<void>((resolve) => stream.onDrain(resolve))
  assert.equal(stream.write(Buffer.alloc(64_000)), false)
  releaseFirstWrite!()
  let drainTimeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      drained,
      new Promise<never>((_, reject) => { drainTimeout = setTimeout(() => reject(new Error('stream never drained')), 2_000) })
    ])
  } finally {
    if (drainTimeout) clearTimeout(drainTimeout)
  }
  assert.equal(writes, 2)

  stream.close()
  await stream.completion
})

test('cancelling one coalesced caller leaves the other caller alive', async (t) => {
  const f = fixture(t)
  writeFileSync(`${f.model}.slow`, '')
  const controller = new AbortController()
  const source = Buffer.alloc(16_000, 9)
  const options = { cacheKey: 'replay:12', stillCurrent: () => true }
  const cancelled = f.playback.processPcm(source, 16_000, { ...options, signal: controller.signal })
  const retained = f.playback.processPcm(source, 16_000, options)
  controller.abort()
  await assert.rejects(cancelled, /cancelled/)
  assert.deepEqual(await retained, source)
})

test('all coalesced callers cancelling releases the helper slot for later work', async (t) => {
  const f = fixture(t)
  writeFileSync(`${f.model}.slow`, '')
  const source = Buffer.alloc(16_000, 4)
  const controller = new AbortController()
  const request = f.playback.processPcm(source, 16_000, { cacheKey: 'archive:13', signal: controller.signal })
  controller.abort()
  await assert.rejects(request, /cancelled/)
  rmSync(`${f.model}.slow`)
  assert.deepEqual(await f.playback.processPcm(source, 16_000), source)
})

test('helper startup failures reject with stderr rather than hanging', async (t) => {
  const f = fixture(t)
  writeFileSync(f.helper, '#!/usr/bin/env node\nprocess.stderr.write("startup failed\\n"); process.exit(7)\n')
  chmodSync(f.helper, 0o755)
  await assert.rejects(f.playback.processPcm(Buffer.alloc(2), 16_000), /startup failed/)
})

test('helper exit while a large input is backpressured rejects instead of waiting forever', async (t) => {
  const f = fixture(t)
  writeFileSync(f.helper, '#!/usr/bin/env node\nrequire("node:fs").writeSync(3, "R"); process.stderr.write("stopped\\n"); process.exit(8)\n')
  chmodSync(f.helper, 0o755)
  const outcome = f.playback.processPcm(Buffer.alloc(1024 * 1024), 16_000)
  const result = await Promise.race([
    outcome.then(() => 'unexpected-success', (error: Error) => error.message),
    new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 2_000))
  ])
  assert.match(result, /stopped|closed its input|EPIPE/)
  assert.notEqual(result, 'timeout')
})

test('shutdown stops active helpers and releases queued finite work', async (t) => {
  const f = fixture(t)
  const first = await f.playback.openStream(16_000)
  const second = await f.playback.openStream(16_000)
  const queued = f.playback.processPcm(Buffer.alloc(2), 16_000)
  f.playback.shutdown()
  await assert.rejects(queued, /cancelled|stopped/)
  const exits = await Promise.all([first.completion, second.completion])
  assert.ok(exits.every((exit) => exit.code !== 0))
  await assert.rejects(f.playback.openStream(16_000), /stopped/)
})

test('unsupported rates and malformed quality spans fail before spawning', async (t) => {
  const f = fixture(t)
  await assert.rejects(f.playback.processPcm(Buffer.alloc(4), 8_000), /16 kHz/)
  await assert.rejects(f.playback.processPcm(Buffer.alloc(4), 16_000, {
    qualitySpans: [{ bytes: 2 }, { bytes: 4 }]
  }), ModifiedPlaybackError)
  await assert.rejects(f.playback.processPcm(Buffer.alloc(3), 16_000), /complete PCM16/)
  await assert.rejects(f.playback.processPcm(Buffer.alloc(4), 16_000, { quietingIntensity: Number.NaN }), /between 0 and 100%/)
  await assert.rejects(f.playback.openStream(16_000, undefined, 101), /between 0 and 100%/)
  assert.equal(requireRuns(f.model), 0)
})

function requireRuns(model: string): number {
  try { return (require('node:fs').readFileSync(`${model}.runs`, 'utf8') as string).trim().split('\n').length }
  catch { return 0 }
}
