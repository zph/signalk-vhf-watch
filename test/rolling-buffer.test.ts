import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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

test('inserts retrospectively demodulated audio before newer live audio', () => {
  const replay = new RollingReplay(8_000, 60, 60, '68')
  const now = Date.now()
  replay.append(Buffer.alloc(8_000 * 2), now, 0.1)
  const liveId = replay.list()[0]!.id
  const backfill = replay.insert(Buffer.alloc(8_000 * 2), now - 5_000, 0.1)
  assert.ok(backfill)
  const ordered = replay.list().slice().reverse()
  assert.equal(Date.parse(ordered[0]!.startedAt), now - 5_000)
  assert.equal(Date.parse(ordered[1]!.startedAt), now)
  assert.equal(ordered[1]!.id, liveId)
})

test('joins consecutive replay PCM without WAV boundaries and stops at a retune', async () => {
  const replay = new RollingReplay(8_000, 1, 1, 'WX4')
  const first = Buffer.alloc(16_000, 1)
  const second = Buffer.alloc(16_000, 2)
  replay.append(Buffer.concat([first, second]), Date.UTC(2026, 8, 29), 0.10)
  const wx4 = replay.list().slice().reverse()
  replay.setChannel('16')
  replay.append(Buffer.alloc(16_000, 3), Date.UTC(2026, 8, 29, 0, 0, 2), 0.10)

  const pcm: Buffer[] = []
  for await (const chunk of replay.pcmFrom(wx4[0]!.id, 20)) pcm.push(chunk)
  assert.deepEqual(pcm.map((chunk) => chunk.length), [first.length, second.length])
  assert.equal(Buffer.concat(pcm).includes(Buffer.from('RIFF')), false)
  assert.equal(pcm[0]?.readUInt8(0), 1)
  assert.equal(pcm[1]?.readUInt8(0), 2)
})

test('playback cursor reads bounded chronological slices and stops at the first channel change', async () => {
  const replay = new RollingReplay(8_000, 1, 60, '16')
  const first = Buffer.alloc(16_000, 0x11)
  const second = Buffer.alloc(16_000, 0x22)
  const startedAt = Date.UTC(2026, 9, 2)
  replay.append(Buffer.concat([first, second]), startedAt, 0.31)
  const firstId = replay.list().slice().reverse()[0]!.id
  replay.setChannel('WX4')
  replay.append(Buffer.alloc(16_000, 0x33), startedAt + 2_000, 0.32)
  let cursor = replay.playbackCursor(firstId)!
  let payload
  const output: Buffer[] = []
  for (;;) {
    const read = await replay.readPlaybackCursor(cursor, 6_000, payload)
    if (read.kind === 'chunk') {
      output.push(read.pcm)
      cursor = read.cursor
      payload = read.payload
      if (read.after?.kind === 'advance') { cursor = read.after.cursor; payload = undefined }
      else if (read.after?.kind === 'channel-change') break
      continue
    }
    if (read.kind === 'advance') { cursor = read.cursor; payload = undefined; continue }
    if (read.kind === 'edge') break
    assert.equal(read.reason, 'channel-change')
    break
  }
  assert.deepEqual(Buffer.concat(output), Buffer.concat([first, second]))
  assert.equal(output.every((part) => part.length <= 6_000), true)
})

test('cursor preserves unread suffix when a pending segment becomes stored', async () => {
  const replay = new RollingReplay(8_000, 1, 60, '16')
  const first = Buffer.alloc(8_000, 0x41)
  const suffix = Buffer.alloc(8_000, 0x42)
  const startedAt = Date.UTC(2026, 9, 2)
  replay.append(first, startedAt, 0.21)
  const cursor = replay.playbackCursor(replay.list()[0]!.id)!
  const initial = await replay.readPlaybackCursor(cursor, 6_000)
  assert.equal(initial.kind, 'chunk')
  if (initial.kind !== 'chunk') return
  replay.append(suffix, startedAt + 500, 0.42)
  const continuation = await replay.readPlaybackCursor(initial.cursor, 20_000, initial.payload)
  assert.equal(continuation.kind, 'chunk')
  if (continuation.kind !== 'chunk') return
  assert.deepEqual(continuation.pcm, Buffer.concat([first, suffix]).subarray(6_000))
  assert.equal(continuation.qualitySpans?.reduce((sum, span) => sum + span.bytes, 0), continuation.pcm.length)
  assert.equal(continuation.after?.kind, 'edge')
})

test('cursor detects deletion and retroactive prepend identity changes', async () => {
  const deleted = new RollingReplay(8_000, 1, 60, '16')
  deleted.append(Buffer.alloc(16_000), Date.UTC(2026, 9, 2))
  const cursor = deleted.playbackCursor(deleted.list()[0]!.id)!
  assert.equal(deleted.delete(cursor.id), true)
  assert.deepEqual(await deleted.readPlaybackCursor(cursor), { kind: 'end', reason: 'retired' })

  const prepended = new RollingReplay(8_000, 60, 60, '68')
  const startedAt = Date.UTC(2026, 9, 2)
  prepended.append(Buffer.alloc(8_000), startedAt, 0.1)
  const pending = prepended.playbackCursor(prepended.list()[0]!.id)!
  prepended.prepend(Buffer.alloc(4_000), startedAt - 250, 0.2)
  assert.deepEqual(await prepended.readPlaybackCursor(pending), { kind: 'end', reason: 'retired' })
})

test('joins recovered and live audio in one stable recording without duplicating overlap', () => {
  const replay = new RollingReplay(8_000, 60, 60, '68')
  const now = Date.now()
  replay.append(Buffer.alloc(16_000, 2), now, 0.1)
  const id = replay.list()[0]!.id
  // Six recovered seconds overlap the first live second by one second.
  assert.deepEqual(replay.prepend(Buffer.alloc(96_000, 1), now - 5_000, 0.2), [])
  replay.append(Buffer.alloc(16_000, 3), now + 1_000, 0.1)
  const segment = replay.flush()!
  assert.equal(segment.id, id)
  assert.equal(replay.list().length, 1)
  assert.equal(segment.durationSeconds, 7)
  assert.deepEqual(segment.wav.subarray(44), Buffer.concat([
    Buffer.alloc(80_000, 1), Buffer.alloc(16_000, 2), Buffer.alloc(16_000, 3)
  ]))
  assert.deepEqual(segment.qualitySpans.map((span) => span.bytes), [80_000, 16_000, 16_000])
})

test('trims recovered quality spans at the exact live overlap boundary', () => {
  const replay = new RollingReplay(8_000, 60, 60, '68')
  const now = Date.now()
  const live = Buffer.alloc(16_000 * 2, 2)
  replay.append(live, now, 0.1)
  const backfill = Buffer.alloc(16_000 * 6, 1)
  const recovered = replay.prepend(backfill, now - 5_000, 0.35, [
    { bytes: 16_000 * 3, discriminatorNoise: 0.6 },
    { bytes: 16_000 * 3, discriminatorNoise: 0.1 }
  ])
  assert.deepEqual(recovered, [])
  const segment = replay.flush()!
  assert.equal(segment.durationSeconds, 7)
  assert.deepEqual(segment.wav.subarray(44), Buffer.concat([
    Buffer.alloc(16_000 * 3, 1),
    Buffer.alloc(16_000 * 2, 1),
    live
  ]))
  assert.deepEqual(segment.qualitySpans, [
    { bytes: 16_000 * 3, discriminatorNoise: 0.6 },
    { bytes: 16_000 * 2, discriminatorNoise: 0.1 },
    { bytes: live.length, discriminatorNoise: 0.1 }
  ])
})

test('keeps recovered speech playable while gating a later noisy span', async () => {
  const replay = new RollingReplay(8_000, 2, 1, '16')
  const pcm = Buffer.alloc(16_000 * 2)
  pcm.fill(0x30, 0, 16_000)
  pcm.fill(0x40, 16_000)
  replay.append(pcm, Date.UTC(2026, 8, 29), 0.35, [
    { bytes: 16_000, discriminatorNoise: 0.1 },
    { bytes: 16_000, discriminatorNoise: 0.6 }
  ])
  const segment = replay.list(20)[0]!
  assert.deepEqual(segment.activity?.slice(0, 24), Array(24).fill(1))
  assert.deepEqual(segment.activity?.slice(24), Array(24).fill(0))
  const wav = await replay.wavFor(segment.id, 20)
  assert.equal(wav?.subarray(44, 44 + 16_000).every((byte) => byte === 0x30), true)
  assert.equal(wav?.subarray(44 + 16_000, 44 + 32_000).every((byte) => byte === 0), true)
})

test('exposes a growing storage slice immediately with a stable playable id', async () => {
  const replay = new RollingReplay(8_000, 60, 120, 'WX4')
  replay.append(Buffer.alloc(16_000, 1), Date.UTC(2026, 8, 29), 0.10)
  const first = replay.list(20)[0]!
  assert.equal(first.durationSeconds, 1)
  assert.equal((await replay.wavFor(first.id, 20))?.subarray(0, 4).toString(), 'RIFF')

  replay.append(Buffer.alloc(16_000, 2), Date.UTC(2026, 8, 29, 0, 0, 1), 0.10)
  const growing = replay.list(20)[0]!
  assert.equal(growing.id, first.id)
  assert.equal(growing.durationSeconds, 2)
})

test('ends a growing session after six seconds of squelched silence', () => {
  const replay = new RollingReplay(8_000, 60, 120, 'WX4', Number.POSITIVE_INFINITY, 'A', 0, 1, 20)
  const signal = Buffer.alloc(8_000 * 2 * 10, 1)
  const quietSecond = Buffer.alloc(8_000 * 2, 0)
  assert.equal(replay.append(signal, Date.UTC(2026, 8, 29), 0.10).length, 0)
  let completed: ReturnType<RollingReplay['append']> = []
  for (let second = 0; second < 6; second += 1) {
    completed = replay.append(quietSecond, Date.UTC(2026, 8, 29, 0, 0, 10 + second), 0.60)
  }
  assert.equal(completed.length, 1)
  assert.equal(completed[0]?.durationSeconds, 16)
})

test('caps retention by memory as well as time', () => {
  const segmentBytes = 8_000 * 2 * 2
  const replay = new RollingReplay(8_000, 2, 60, '16', segmentBytes + 44)
  replay.append(Buffer.alloc(segmentBytes * 3))
  assert.equal(replay.list().length, 1)
})

test('compacts completed replay to Opus and decodes it for playback', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'vhf-replay-opus-'))
  const command = path.join(directory, 'fake-ffmpeg')
  writeFileSync(command, '#!/bin/sh\ncase "$*" in *libopus*) gzip -c ;; *) gzip -dc ;; esac\n')
  chmodSync(command, 0o755)
  const replay = new RollingReplay(8_000, 1, 1_440, '16', 1024 * 1024, 'A', 0, 1, 20, command)
  replay.append(Buffer.alloc(16_000, 1), Date.now(), 0.1)
  const id = replay.list()[0]!.id
  for (let attempt = 0; attempt < 100 && replay.list()[0]!.bytes >= 16_044; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.ok(replay.list()[0]!.bytes < 16_044)
  const wav = await replay.wavFor(id, 0)
  assert.equal(wav?.length, 16_044)
  assert.equal(wav?.subarray(44).every((value) => value === 1), true)
})

test('retains two wall-clock hours when quiet gaps create short storage slices', () => {
  const replay = new RollingReplay(1, 3_600, 120, 'WX4')
  const tenMinutes = Buffer.alloc(1 * 2 * 10 * 60)
  const startedAt = Date.now()
  for (let index = 0; index < 13; index += 1) {
    replay.append(tenMinutes, startedAt + index * 10 * 60_000, 0.10)
    replay.flush()
  }

  const retained = replay.list().slice().reverse()
  assert.equal(retained.length, 12)
  assert.equal(Date.parse(retained[0]!.startedAt), startedAt + 10 * 60_000)
  assert.equal(Date.parse(retained.at(-1)!.endedAt), startedAt + 130 * 60_000)
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

test('preserves raw replay and applies selectable discriminator squelch on playback', async () => {
  const replay = new RollingReplay(8_000, 2, 1, '16')
  const noisy = Buffer.alloc(16_000, 0)
  noisy.writeInt16LE(12_000, 0)
  const clear = Buffer.alloc(16_000, 0)
  clear.writeInt16LE(8_000, 0)
  replay.append(noisy, Date.UTC(2026, 8, 29), 0.52)
  replay.append(clear, Date.UTC(2026, 8, 29, 0, 0, 1), 0.20)
  const id = replay.list()[0]!.id
  assert.equal((await replay.wavFor(id, 0))?.readInt16LE(44), 12_000)
  assert.equal((await replay.wavFor(id, 20))?.readInt16LE(44), 0)
  assert.equal((await replay.wavFor(id, 20))?.readInt16LE(44 + noisy.length), 8_000)
  assert.equal(replay.list()[0]?.minimumDiscriminatorNoise, 0.20)
  const activity = replay.list(20)[0]?.activity ?? []
  assert.ok(activity.slice(0, activity.length / 2).every((value) => value === 0))
  assert.ok(activity.slice(activity.length / 2).every((value) => value === 1))
})

test('rejects brief noise bursts but retains sustained radio activity', async () => {
  const replay = new RollingReplay(8_000, 2, 1, '16')
  const brief = Buffer.alloc(8_000 * 2 / 10, 1)
  const quietRemainder = Buffer.alloc(8_000 * 2 * 19 / 10, 1)
  replay.append(brief, Date.UTC(2026, 8, 29), 0.20)
  replay.append(quietRemainder, Date.UTC(2026, 8, 29, 0, 0, 0, 100), 0.52)
  const briefSegment = replay.list(10)[0]!
  assert.ok(briefSegment.activity?.every((value) => value === 0))
  assert.equal((await replay.wavFor(briefSegment.id, 10))?.readInt16LE(44), 0)

  const sustained = Buffer.alloc(8_000 * 2 / 4, 1)
  const remaining = Buffer.alloc(8_000 * 2 * 7 / 4, 1)
  replay.append(sustained, Date.UTC(2026, 8, 29, 0, 0, 2), 0.20)
  replay.append(remaining, Date.UTC(2026, 8, 29, 0, 0, 2, 250), 0.52)
  const sustainedSegment = replay.list(10)[0]!
  assert.ok(sustainedSegment.activity?.some((value) => value > 0))
  assert.notEqual((await replay.wavFor(sustainedSegment.id, 10))?.readInt16LE(44), 0)
})
