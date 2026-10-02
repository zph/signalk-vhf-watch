import assert from 'node:assert/strict'
import test from 'node:test'
import { channelById } from '../src/channels'
import { normalizeConfig } from '../src/config'
import { canChannelize, nativeSidecarArgs, parseSidecarFrames, parseSpannedBackfillFrame, rtlSdrArgs } from '../src/receiver'
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
  assert.deepEqual(args.slice(0, 20), [
    '--mode', 'stream', '--device', '00000001', '--sample-rate', '2400000',
    '--center', '156750000', '--voice', '156800000', '--dsc', '156525000',
    '--slot-b', '156525000',
    '--audio-rate', '16000', '--ppm', '2', '--squelch', '15'
  ])
  assert.equal(args[20], '--scan-frequencies')
  assert.match(args[21]!, /156800000/)
  assert.equal(args.some((arg) => /tx|transmit|ptt/i.test(arg)), false)

  const weatherArgs = nativeSidecarArgs(config, channelById('WX4')!, '70', true)
  assert.deepEqual(weatherArgs, [
    '--mode', 'stream', '--device', '00000001', '--sample-rate', '2400000',
    '--center', '162425000', '--voice', '162425000', '--dsc', '162425000',
    '--slot-b', '162425000',
    '--audio-rate', '16000', '--ppm', '2', '--squelch', '15'
  ])
  assert.equal(weatherArgs.some((arg) => /tx|transmit|ptt/i.test(arg)), false)
  assert.equal(weatherArgs.includes('--scan-frequencies'), false)
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

test('validates quality-spanned backfill metadata and exact PCM coverage', () => {
  const payload = Buffer.alloc(20 + 2 * 12 + 8)
  payload.writeBigInt64LE(1_234n, 0)
  payload.writeBigInt64LE(156_800_000n, 8)
  payload.writeUInt32LE(2, 16)
  payload.writeUInt32LE(4, 20)
  payload.writeDoubleLE(0.1, 24)
  payload.writeUInt32LE(4, 32)
  payload.writeDoubleLE(0.5, 36)
  payload.fill(0x12, 44)
  const parsed = parseSpannedBackfillFrame(payload)
  assert.equal(parsed.capturedAt, 1_234)
  assert.equal(parsed.frequencyHz, 156_800_000)
  assert.equal(parsed.discriminatorNoise, 0.3)
  assert.deepEqual(parsed.qualitySpans, [
    { bytes: 4, discriminatorNoise: 0.1 },
    { bytes: 4, discriminatorNoise: 0.5 }
  ])
  assert.deepEqual(parsed.pcm, Buffer.alloc(8, 0x12))

  const mismatched = Buffer.from(payload)
  mismatched.writeUInt32LE(6, 20)
  assert.throws(() => parseSpannedBackfillFrame(mismatched), /Invalid quality span/)
  const nonFinite = Buffer.from(payload)
  nonFinite.writeDoubleLE(Number.NaN, 24)
  assert.throws(() => parseSpannedBackfillFrame(nonFinite), /Invalid quality span/)
})

test('maps higher squelch settings to stricter discriminator-noise thresholds', () => {
  assert.equal(discriminatorThreshold(0), Number.POSITIVE_INFINITY)
  assert.equal(discriminatorThreshold(20), 0.22)
  assert.ok(discriminatorThreshold(30) < discriminatorThreshold(20))
})
