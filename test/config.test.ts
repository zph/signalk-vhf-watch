import assert from 'node:assert/strict'
import test from 'node:test'
import { defaultSidecarPath, normalizeConfig } from '../src/config'

test('normalizes safe defaults and rejects channel 70', () => {
  const config = normalizeConfig({ initialChannel: '70', replayMinutes: 999, segmentSeconds: 1 })
  assert.equal(config.receiverMode, 'demo')
  assert.equal(config.channelRegion, 'US_CA')
  assert.equal(config.initialChannel, '16')
  assert.equal(config.replayMinutes, 120)
  assert.equal(config.segmentSeconds, 2)
  assert.equal(config.maxBufferMiB, 64)
  assert.equal(config.sidecarPath, defaultSidecarPath())
})

test('selects a prebuilt sidecar by host platform and architecture', () => {
  assert.match(defaultSidecarPath('linux', 'arm64'), /bin\/linux-arm64\/vhf-watch-sidecar$/)
})

test('validates the startup channel against its regional plan', () => {
  assert.equal(normalizeConfig({ channelRegion: 'CA', initialChannel: '04A' }).initialChannel, '04A')
  assert.equal(normalizeConfig({ channelRegion: 'US', initialChannel: '04A' }).initialChannel, '16')
})

test('accepts RTL-SDR settings and migrates legacy mode and device index', () => {
  const config = normalizeConfig({ receiverMode: 'rtl_fm', initialChannel: 'wx2', deviceIndex: 2, gainDb: 27.4 })
  assert.equal(config.receiverMode, 'rtl_sdr')
  assert.equal(config.initialChannel, 'WX2')
  assert.equal(config.device, '2')
  assert.equal(config.gainDb, 27.4)
})

test('accepts a stable RTL-SDR serial and clamps frequency correction', () => {
  const config = normalizeConfig({ device: '00000001', ppm: 999 })
  assert.equal(config.device, '00000001')
  assert.equal(config.ppm, 150)
})
