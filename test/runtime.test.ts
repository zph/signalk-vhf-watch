import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeConfig } from '../src/config'
import { VhfRuntime } from '../src/runtime'

test('demo runtime produces bounded replay audio and can retune', async () => {
  const runtime = new VhfRuntime(normalizeConfig({
    receiverMode: 'demo',
    sampleRate: 8_000,
    segmentSeconds: 2,
    replayMinutes: 1,
    maxBufferMiB: 16
  }))
  runtime.start()
  try {
    await new Promise((resolve) => setTimeout(resolve, 2_150))
    assert.equal(runtime.status().receiveOnly, true)
    assert.equal(runtime.status().slots.A.mode, 'fixed')
    assert.equal(runtime.status().slots.B.channel.id, '70')
    assert.ok(runtime.segments().length >= 1)
    assert.ok(runtime.segments().every((segment) => segment.channel === '16'))
    assert.equal(runtime.tune('WX2').channel.id, 'WX2')
    assert.equal(runtime.segments()[0]?.channel, '16')
    assert.equal(runtime.setRegion('CA').channelRegion, 'CA')
    assert.equal(runtime.tune('04A').channel.id, '04A')
    const usStatus = runtime.setRegion('US')
    assert.equal(usStatus.channelRegion, 'US')
    assert.equal(usStatus.channel.id, '16')
  } finally {
    runtime.stop()
  }
})

test('configures scan mode and independent receiver Slot B', () => {
  const runtime = new VhfRuntime(normalizeConfig({ enabled: false, receiverMode: 'rtl_sdr' }))
  const status = runtime.configureSlots('scan', '16', '68')
  assert.equal(status.slots.A.mode, 'scan')
  assert.equal(status.slots.B.channel.id, '68')
  assert.equal(status.slots.B.kind, 'voice')
  assert.equal(status.dscWatch.enabled, false)
  assert.throws(() => runtime.configureSlots('fixed', '68', '68'), /different channels/)
})

test('switches between marine wideband and distant single-frequency reception', () => {
  const runtime = new VhfRuntime(normalizeConfig({
    enabled: true,
    receiverMode: 'rtl_sdr',
    initialChannel: 'WX4',
    slotAMode: 'scan'
  }))
  const weather = runtime.status()
  assert.equal(weather.channel.id, 'WX4')
  assert.equal(weather.captureMode, 'single_frequency')
  assert.equal(weather.slots.A.mode, 'fixed')
  assert.equal(weather.slots.B.kind, 'paused')
  assert.equal(weather.dscWatch.enabled, false)
  assert.equal(weather.wideband?.centerHz, 162_425_000)
  assert.throws(() => runtime.configureSlots('scan', 'WX4', '70'), /requires Fixed mode/)

  const marine = runtime.configureSlots('fixed', '16', '70')
  assert.equal(marine.captureMode, 'wideband')
  assert.equal(marine.slots.B.kind, 'dsc')
  assert.equal(marine.dscWatch.enabled, true)
  assert.equal(marine.wideband?.centerHz, 156_750_000)
  assert.equal(runtime.tune('68').channel.id, '68')
  assert.equal(runtime.tune('WX2').captureMode, 'single_frequency')
})

test('tails a current WX4 timeline selection but not a previous channel', () => {
  const runtime = new VhfRuntime(normalizeConfig({
    enabled: true,
    receiverMode: 'rtl_sdr',
    initialChannel: 'WX4',
    sampleRate: 8_000,
    segmentSeconds: 1
  }))
  runtime.replay.append(Buffer.alloc(runtime.config.sampleRate * 2), Date.UTC(2026, 8, 29), 0.10)
  const wx4 = runtime.segments()[0]!
  assert.equal(wx4.channel, 'WX4')
  assert.equal(runtime.canTailReplay(wx4.id), true)
  runtime.tune('16')
  assert.equal(runtime.canTailReplay(wx4.id), false)
})
