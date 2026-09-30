import assert from 'node:assert/strict'
import test from 'node:test'
import { archivedPlaybackPcm, parseByteRange } from '../src/api'
import { pcmToWav } from '../src/wav'

test('parses browser byte ranges for seekable WAV playback', () => {
  assert.equal(parseByteRange(undefined, 1_000), undefined)
  assert.deepEqual(parseByteRange('bytes=0-99', 1_000), { start: 0, end: 99 })
  assert.deepEqual(parseByteRange('bytes=400-', 1_000), { start: 400, end: 999 })
  assert.deepEqual(parseByteRange('bytes=-100', 1_000), { start: 900, end: 999 })
  assert.deepEqual(parseByteRange('bytes=900-1200', 1_000), { start: 900, end: 999 })
})

test('rejects malformed or unsatisfiable WAV byte ranges', () => {
  assert.equal(parseByteRange('bytes=1000-', 1_000), null)
  assert.equal(parseByteRange('bytes=200-100', 1_000), null)
  assert.equal(parseByteRange('bytes=0-1,10-11', 1_000), null)
  assert.equal(parseByteRange('items=0-10', 1_000), null)
  assert.equal(parseByteRange('bytes=-0', 1_000), null)
})

test('presents only the padded activity slice without changing archived WAV bytes', () => {
  const pcm = Buffer.alloc(60 * 16_000 * 2, 1)
  const wav = pcmToWav(pcm, 16_000)
  const record = { sampleRate: 16_000, activityStartSeconds: 15, activityEndSeconds: 30 }
  assert.equal(archivedPlaybackPcm(record, wav, true).length, 15 * 16_000 * 2)
  assert.equal(archivedPlaybackPcm(record, wav, false).length, pcm.length)
  assert.equal(wav.length, pcm.length + 44)
})
