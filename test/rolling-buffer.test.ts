import assert from 'node:assert/strict'
import test from 'node:test'
import { RollingReplay } from '../src/rolling-buffer'

test('creates playable WAV segments and retains only the configured window', () => {
  const replay = new RollingReplay(8_000, 2, 0.05, '16')
  const pcm = Buffer.alloc(8_000 * 2 * 2)
  pcm.writeInt16LE(12_000, 0)
  replay.append(Buffer.concat([pcm, pcm, pcm]), Date.UTC(2026, 8, 12))
  const segments = replay.list()
  assert.equal(segments.length, 2)
  assert.equal(segments[0]?.channel, '16')
  assert.equal(segments[0]?.durationSeconds, 2)
  const wav = replay.get(segments[0]!.id)?.wav
  assert.equal(wav?.subarray(0, 4).toString(), 'RIFF')
  assert.equal(wav?.subarray(8, 12).toString(), 'WAVE')
})

test('flushes partial audio under its original channel before retuning', () => {
  const replay = new RollingReplay(8_000, 5, 1, '16')
  replay.append(Buffer.alloc(8_000))
  replay.setChannel('68')
  assert.equal(replay.list()[0]?.channel, '16')
  replay.append(Buffer.alloc(8_000))
  replay.flush()
  assert.equal(replay.list()[0]?.channel, '68')
})

test('caps retention by memory as well as time', () => {
  const segmentBytes = 8_000 * 2 * 2
  const replay = new RollingReplay(8_000, 2, 60, '16', segmentBytes + 44)
  replay.append(Buffer.alloc(segmentBytes * 3))
  assert.equal(replay.list().length, 1)
})

test('deletes one retained replay segment without clearing the others', () => {
  const replay = new RollingReplay(8_000, 2, 1, '16')
  replay.append(Buffer.alloc(8_000 * 2 * 2 * 3))
  const segments = replay.list()
  const deletedId = segments[1]!.id
  assert.equal(replay.delete(deletedId), true)
  assert.deepEqual(replay.list().map((segment) => segment.id), [segments[0]!.id, segments[2]!.id])
  assert.equal(replay.delete(deletedId), false)
})

test('preserves raw replay and applies selectable discriminator squelch on playback', () => {
  const replay = new RollingReplay(8_000, 2, 1, '16')
  const noisy = Buffer.alloc(16_000, 0)
  noisy.writeInt16LE(12_000, 0)
  const clear = Buffer.alloc(16_000, 0)
  clear.writeInt16LE(8_000, 0)
  replay.append(noisy, Date.UTC(2026, 8, 29), 0.52)
  replay.append(clear, Date.UTC(2026, 8, 29, 0, 0, 1), 0.20)
  const id = replay.list()[0]!.id
  assert.equal(replay.wavFor(id, 0)?.readInt16LE(44), 12_000)
  assert.equal(replay.wavFor(id, 20)?.readInt16LE(44), 0)
  assert.equal(replay.wavFor(id, 20)?.readInt16LE(44 + noisy.length), 8_000)
  assert.equal(replay.list()[0]?.minimumDiscriminatorNoise, 0.20)
  const activity = replay.list(20)[0]?.activity ?? []
  assert.ok(activity.slice(0, activity.length / 2).every((value) => value === 0))
  assert.ok(activity.slice(activity.length / 2).every((value) => value === 1))
})
