import assert from 'node:assert/strict'
import test from 'node:test'
import { channelById } from '../src/channels'
import { normalizeConfig } from '../src/config'
import { canChannelize, nativeSidecarArgs, parseSidecarFrames, rtlSdrArgs } from '../src/receiver'
import { discriminatorThreshold } from '../src/squelch'

test('builds one receive-only wideband capture for voice and DSC', () => {
  const config = normalizeConfig({ receiverMode: 'rtl_sdr', device: 'vhf-radio', ppm: -3, squelch: 25, gainDb: 20 })
  const args = rtlSdrArgs(config)
  assert.deepEqual(args, [
    '-d', 'vhf-radio', '-f', '156750000', '-s', '2400000', '-p', '-3', '-g', '20', '-'
  ])
  assert.equal(args.some((arg) => /tx|transmit|ptt/i.test(arg)), false)
  assert.equal(canChannelize(channelById('16')!.frequencyHz), true)
  assert.equal(canChannelize(channelById('WX2')!.frequencyHz), false)
})

test('builds native sidecar arguments without any transmit controls', () => {
  const config = normalizeConfig({ receiverMode: 'rtl_sdr', device: '00000001', ppm: 2, squelch: 15 })
  const args = nativeSidecarArgs(config, channelById('16')!)
  assert.deepEqual(args, [
    '--mode', 'stream', '--device', '00000001', '--sample-rate', '2400000',
    '--center', '156750000', '--voice', '156800000', '--dsc', '156525000',
    '--slot-b', '156525000',
    '--audio-rate', '16000', '--ppm', '2', '--squelch', '15'
  ])
  assert.equal(args.some((arg) => /tx|transmit|ptt/i.test(arg)), false)
})

test('parses complete sidecar frames and retains a partial frame', () => {
  const voice = Buffer.from([1, 2, 3, 4])
  const first = Buffer.alloc(5 + voice.length)
  first[0] = 1
  first.writeUInt32LE(voice.length, 1)
  voice.copy(first, 5)
  const partial = Buffer.from([2, 4, 0, 0, 0, 9])
  const parsed = parseSidecarFrames(Buffer.concat([first, partial]))
  assert.deepEqual(parsed.frames, [{ kind: 1, payload: voice }])
  assert.deepEqual(parsed.remaining, partial)
})

test('maps higher squelch settings to stricter discriminator-noise thresholds', () => {
  assert.equal(discriminatorThreshold(0), Number.POSITIVE_INFINITY)
  assert.equal(discriminatorThreshold(20), 0.35)
  assert.ok(discriminatorThreshold(30) < discriminatorThreshold(20))
})
