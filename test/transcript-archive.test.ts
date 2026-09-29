import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { TranscriptArchive } from '../src/transcript-archive'
import { pcmToWav } from '../src/wav'

function record(startedMs: number, channel: string, wav = pcmToWav(randomBytes(4_000), 8_000)) {
  return {
    startedAt: new Date(startedMs).toISOString(),
    endedAt: new Date(startedMs + 250).toISOString(),
    channel,
    durationSeconds: 0.25,
    sampleRate: 8_000,
    minimumDiscriminatorNoise: 0.12,
    transcript: `voice on ${channel}`,
    wav
  }
}

test('stores playable zstd audio and transcript metadata in a private SQLite database', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'vhf-archive-'))
  const databasePath = path.join(directory, 'transcripts.sqlite3')
  const archive = new TranscriptArchive(databasePath)
  const input = record(Date.UTC(2026, 8, 29), '16')
  const stored = archive.add(input, Date.UTC(2026, 8, 29))!
  assert.equal(stored.channel, '16')
  assert.equal(stored.transcript, 'voice on 16')
  assert.equal(stored.minimumDiscriminatorNoise, 0.12)
  assert.deepEqual(archive.wav(stored.id), input.wav)
  assert.equal(archive.status().records, 1)
  assert.equal(statSync(databasePath).mode & 0o777, 0o600)
  archive.close()
})

test('prunes transcripts by age and compressed-byte limit', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'vhf-archive-prune-'))
  const now = Date.UTC(2026, 8, 29)
  const archive = new TranscriptArchive(path.join(directory, 'transcripts.sqlite3'), {
    retentionDays: 30,
    maxBytes: 32_768
  })
  archive.add(record(now - 31 * 24 * 60 * 60 * 1_000, '09'), now)
  for (let index = 0; index < 8; index += 1) archive.add(record(now - 8_000 + index * 1_000, String(10 + index)), now)
  assert.equal(archive.list().some((entry) => entry.channel === '09'), false)
  assert.equal(archive.list()[0]?.channel, '17')
  assert.ok(archive.status().compressedBytes <= 32_768)
  assert.ok(archive.status().databaseBytes <= 32_768)
  archive.close()
})
