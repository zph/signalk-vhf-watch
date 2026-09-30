import assert from 'node:assert/strict'
import test from 'node:test'
import { SpectrumActivityLog } from '../src/activity-log'

test('coalesces consecutive channel activity and records exact start and end times', () => {
  const log = new SpectrumActivityLog(60, 10)
  log.update([{ channel: '16', frequencyHz: 156_800_000, score: 1.2 }], 1_000)
  log.update([{ channel: '16', frequencyHz: 156_800_000, score: 2.4 }], 2_000)
  log.update([], 6_000)
  assert.deepEqual(log.list(6_000), [{
    id: 1, channel: '16', frequencyHz: 156_800_000, score: 2.4,
    startedAt: new Date(1_000).toISOString(), endedAt: new Date(3_000).toISOString()
  }])
})

test('bounds closed spectrum history by age and count without dropping an open event', () => {
  const log = new SpectrumActivityLog(1, 2, 0)
  log.update([{ channel: '68', frequencyHz: 156_425_000, score: 1 }], 0)
  log.update([], 1_000)
  log.update([{ channel: '69', frequencyHz: 156_475_000, score: 1 }], 2_000)
  log.update([], 3_000)
  log.update([{ channel: '16', frequencyHz: 156_800_000, score: 1 }], 4_000)
  const bounded = log.list(4_000)
  assert.equal(bounded.length, 2)
  assert.equal(bounded.at(-1)?.channel, '16')
  assert.equal(bounded.at(-1)?.endedAt, undefined)
  assert.deepEqual(log.list(64_001).map((event) => event.channel), ['16'])
})
