import assert from 'node:assert/strict'
import test from 'node:test'
import { channelById, channelPlan } from '../src/channels'

test('provides distinct US, Canadian, and combined receive plans', () => {
  const us = channelPlan('US')
  const canada = channelPlan('CA')
  const combined = channelPlan('US_CA')
  assert.ok(us.length >= 50)
  assert.ok(canada.length >= 60)
  assert.ok(combined.length >= canada.length)
  assert.equal(us.some((channel) => channel.id === '04A'), false)
  assert.equal(canada.some((channel) => channel.id === '04A'), true)
  assert.deepEqual(channelById('16', 'US_CA')?.countries, ['US', 'CA'])
})

test('never exposes DSC or AIS channels through the analog voice tuner', () => {
  for (const region of ['US', 'CA', 'US_CA'] as const) {
    const ids = channelPlan(region).map((channel) => channel.id)
    assert.equal(ids.includes('70'), false)
    assert.equal(ids.some((id) => id.startsWith('AIS')), false)
    assert.equal(ids.includes('87B'), false)
    assert.equal(ids.includes('88B'), false)
  }
})

test('uses coast receive frequencies for Canadian duplex channels', () => {
  assert.equal(channelById('20', 'CA')?.frequencyHz, 161_600_000)
  assert.equal(channelById('84', 'CA')?.frequencyHz, 161_825_000)
})
