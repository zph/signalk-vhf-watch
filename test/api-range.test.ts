import assert from 'node:assert/strict'
import test from 'node:test'
import { parseByteRange } from '../src/api'

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
