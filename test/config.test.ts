import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeConfig } from '../src/config'

test('normalizes safe defaults and rejects channel 70', () => {
  const config = normalizeConfig({ initialChannel: '70', replayMinutes: 999, segmentSeconds: 1 })
  assert.equal(config.receiverMode, 'demo')
  assert.equal(config.initialChannel, '16')
  assert.equal(config.replayMinutes, 120)
  assert.equal(config.segmentSeconds, 2)
  assert.equal(config.maxBufferMiB, 64)
})

test('accepts RTL-SDR settings without constructing shell input', () => {
  const config = normalizeConfig({ receiverMode: 'rtl_fm', initialChannel: 'wx2', deviceIndex: 2, gainDb: 27.4 })
  assert.equal(config.receiverMode, 'rtl_fm')
  assert.equal(config.initialChannel, 'WX2')
  assert.equal(config.deviceIndex, 2)
  assert.equal(config.gainDb, 27.4)
})
