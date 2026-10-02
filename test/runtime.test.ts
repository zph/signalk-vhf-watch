import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeConfig } from '../src/config'
import { mergeTimestampedScanPreRoll, ScanRecoveryWindow, selectAdaptiveScanChannel, VhfRuntime } from '../src/runtime'

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
  const status = runtime.configureSlots('scan', '16', 'fixed', '68')
  assert.equal(status.slots.A.mode, 'scan')
  assert.equal(status.slots.B.channel.id, '68')
  assert.equal(status.slots.B.kind, 'voice')
  assert.equal(status.dscWatch.enabled, false)
  assert.throws(() => runtime.configureSlots('fixed', '68', 'fixed', '68'), /different channels/)
})

test('Slot B adaptive scan favors recent voice without starving quiet channels', () => {
  const runtime = new VhfRuntime(normalizeConfig({ enabled: false, receiverMode: 'rtl_sdr' }))
  const status = runtime.configureSlots('fixed', '16', 'scan', '70')
  assert.equal(status.slots.B.mode, 'scan')
  assert.equal(status.slots.B.configuredChannel.id, '68')
  assert.equal(status.slots.B.state, 'scanning')
  assert.equal(status.dscWatch.enabled, false)

  const channels = runtime.channels().filter((channel) => ['68', '69'].includes(channel.id))
  const now = 100_000
  assert.equal(selectAdaptiveScanChannel(channels, new Map([['68', 4]]), new Map([['68', 98_000], ['69', 98_000]]), now)?.id, '68')
  assert.equal(selectAdaptiveScanChannel(channels, new Map([['68', 4]]), new Map([['68', 99_900], ['69', 1_000]]), now)?.id, '69')
})

test('scan recovery rejects late slices and stale same-frequency backfill', () => {
  const recovery = new ScanRecoveryWindow()
  const sampleRate = 8_000
  recovery.reset(10_000)
  recovery.target(11_000)
  recovery.beginCall()
  const twoSecondSliceBytes = sampleRate * 2 * 2
  assert.equal(recovery.canPrepend(9_000, twoSecondSliceBytes, sampleRate, 156_800_000, 156_800_000), true)
  recovery.markStored()
  assert.equal(recovery.canPrepend(9_000, twoSecondSliceBytes, sampleRate, 156_800_000, 156_800_000), false)
  recovery.endCall(12_000)
  assert.equal(recovery.accepts(9_000, twoSecondSliceBytes, sampleRate, 156_800_000, 156_800_000), false)
  assert.equal(recovery.accepts(11_000, twoSecondSliceBytes, sampleRate, 156_800_000, 156_800_000), true)
  assert.equal(recovery.accepts(11_000, twoSecondSliceBytes, sampleRate, 156_800_000, 156_425_000), false)
})

test('scan pre-roll trims timestamped live overlap and its quality metadata', () => {
  const preRoll: Parameters<typeof mergeTimestampedScanPreRoll>[0] = []
  mergeTimestampedScanPreRoll(preRoll, {
    chunk: Buffer.alloc(16_000 * 6, 1), discriminatorNoise: 0.35, at: 0, recovered: true,
    qualitySpans: [
      { bytes: 16_000 * 3, discriminatorNoise: 0.6 },
      { bytes: 16_000 * 3, discriminatorNoise: 0.1 }
    ]
  }, 8_000, 10)
  mergeTimestampedScanPreRoll(preRoll, {
    chunk: Buffer.alloc(16_000 * 2, 2), discriminatorNoise: 0.3, at: 5_000, recovered: false,
    qualitySpans: [
      { bytes: 16_000, discriminatorNoise: 0.5 },
      { bytes: 16_000, discriminatorNoise: 0.1 }
    ]
  }, 8_000, 10)
  mergeTimestampedScanPreRoll(preRoll, {
    chunk: Buffer.alloc(16_000, 3), discriminatorNoise: 0.4, at: 5_000, recovered: false,
    qualitySpans: [{ bytes: 16_000, discriminatorNoise: 0.4 }]
  }, 8_000, 10)
  assert.equal(preRoll.length, 3)
  assert.equal(preRoll[0]?.chunk.length, 16_000 * 5)
  assert.deepEqual(preRoll[0]?.qualitySpans, [
    { bytes: 16_000 * 3, discriminatorNoise: 0.6 },
    { bytes: 16_000 * 2, discriminatorNoise: 0.1 }
  ])
  assert.equal(preRoll[1]?.chunk.length, 16_000 * 2)
  assert.equal(preRoll[1]?.chunk[0], 2)
  assert.equal(preRoll[1]?.at, 5_000)
  assert.equal(preRoll[2]?.chunk.length, 16_000)
  assert.equal(preRoll[2]?.chunk[0], 3)
  assert.equal(preRoll[2]?.at, 7_000)
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
  assert.throws(() => runtime.configureSlots('scan', 'WX4', 'fixed', '70'), /requires Fixed mode/)
  assert.throws(() => runtime.configureSlots('fixed', 'WX4', 'scan', '68'), /requires Fixed mode/)

  const marine = runtime.configureSlots('fixed', '16', 'fixed', '70')
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
