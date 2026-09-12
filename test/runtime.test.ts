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
    assert.equal(runtime.segments().length, 1)
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

test('wideband runtime keeps startup and tuning inside continuous DSC coverage', () => {
  const runtime = new VhfRuntime(normalizeConfig({
    enabled: false,
    receiverMode: 'rtl_sdr',
    initialChannel: 'WX2'
  }))
  assert.equal(runtime.status().channel.id, '16')
  assert.equal(runtime.tune('68').channel.id, '68')
  assert.throws(() => runtime.tune('WX2'), /continuous DSC Channel 70/)
})
