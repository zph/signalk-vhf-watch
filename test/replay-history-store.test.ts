import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ReplayHistoryStore } from '../src/replay-history-store'
import { RollingReplay, type ReplaySegment } from '../src/rolling-buffer'

function segment(id: number, startedAt: number, bytes: number, slot: 'A' | 'B' = 'A'): ReplaySegment {
  return {
    id, slot, channel: '16', startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date(startedAt + 1_000).toISOString(), durationSeconds: 1, level: 0.1,
    wav: Buffer.concat([Buffer.alloc(44), Buffer.alloc(bytes, id)]), qualitySpans: [{ bytes, discriminatorNoise: 0.1 }],
    transcription: { status: 'queued', text: '' }
  }
}

function temporaryDirectory(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'vhf-history-'))
}

test('persists playable rolling recordings and restores stable IDs and RF activity checkpoints', async () => {
  const directory = temporaryDirectory()
  try {
    const store = new ReplayHistoryStore(directory, 60, 10_000, (error) => { throw error })
    const now = Date.now()
    const original = segment(1, now - 2_000, 3_200)
    store.schedule({
      segments: [original],
      activityEvents: [{ id: 1, channel: '68', frequencyHz: 156_425_000, score: 2, startedAt: new Date(now - 1_000).toISOString() }]
    })
    await store.flush()

    const loaded = new ReplayHistoryStore(directory, 60, 10_000).load(now)
    assert.equal(loaded.segments.length, 1)
    assert.deepEqual(loaded.segments[0]?.wav, original.wav)
    assert.deepEqual(loaded.segments[0]?.transcription, {
      status: 'skipped', text: '', error: 'Interrupted by Signal K restart'
    })
    const checkpoint = (JSON.parse(readFileSync(path.join(directory, 'manifest.json'), 'utf8')) as { savedAt: string }).savedAt
    assert.equal(loaded.activityEvents[0]?.endedAt, checkpoint)

    const replay = new RollingReplay(8_000, 1, 60, '16')
    replay.restore(loaded.segments)
    assert.equal(replay.get(1)?.wav.length, original.wav.length)
    replay.append(Buffer.alloc(16_000), now)
    assert.equal(replay.list()[0]?.id, 2)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('keeps persisted audio within its byte budget and applies replay TTL', async () => {
  const directory = temporaryDirectory()
  try {
    const now = Date.now()
    const store = new ReplayHistoryStore(directory, 1, 1_000, (error) => { throw error })
    store.schedule({
      segments: [segment(1, now - 120_000, 200), segment(3, now - 1_000, 600), segment(5, now, 600)],
      activityEvents: []
    })
    await store.flush()
    const loaded = new ReplayHistoryStore(directory, 1, 1_000).load(now)
    assert.deepEqual(loaded.segments.map((entry) => entry.id), [5])
    assert.ok(loaded.segments[0]!.wav.length <= 1_000)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
