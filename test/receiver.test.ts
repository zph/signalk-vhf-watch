import assert from 'node:assert/strict'
import test from 'node:test'
import { channelById } from '../src/channels'
import { normalizeConfig } from '../src/config'
import { rtlFmArgs } from '../src/receiver'

test('builds receive-only rtl_fm arguments for the selected marine channel', () => {
  const config = normalizeConfig({ receiverMode: 'rtl_fm', deviceIndex: 1, squelch: 25, gainDb: 20 })
  const args = rtlFmArgs(config, channelById('16')!)
  assert.deepEqual(args, [
    '-d', '1', '-f', '156800000', '-M', 'fm', '-s', '48000', '-r', '16000',
    '-l', '25', '-E', 'deemp', '-g', '20', '-'
  ])
  assert.equal(args.some((arg) => /tx|transmit|ptt/i.test(arg)), false)
})
