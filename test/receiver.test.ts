import assert from 'node:assert/strict'
import test from 'node:test'
import { channelById } from '../src/channels'
import { normalizeConfig } from '../src/config'
import { canChannelize, rtlSdrArgs } from '../src/receiver'

test('builds one receive-only wideband capture for voice and DSC', () => {
  const config = normalizeConfig({ receiverMode: 'rtl_sdr', deviceIndex: 1, squelch: 25, gainDb: 20 })
  const args = rtlSdrArgs(config)
  assert.deepEqual(args, [
    '-d', '1', '-f', '156750000', '-s', '2400000', '-g', '20', '-'
  ])
  assert.equal(args.some((arg) => /tx|transmit|ptt/i.test(arg)), false)
  assert.equal(canChannelize(channelById('16')!.frequencyHz), true)
  assert.equal(canChannelize(channelById('WX2')!.frequencyHz), false)
})
