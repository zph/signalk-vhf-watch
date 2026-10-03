import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { normalizeConfig } from '../src/config'
import { VhfRuntime } from '../src/runtime'
import { TuningSettingsStore } from '../src/tuning-settings'

test('persists receiver channel choices atomically for the next page or plugin start', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'vhf-tuning-settings-'))
  const settingsPath = path.join(directory, 'nested', 'tuning-settings.json')
  const store = new TuningSettingsStore(settingsPath)
  const runtime = new VhfRuntime(
    normalizeConfig({ enabled: false, receiverMode: 'rtl_sdr' }),
    undefined,
    undefined,
    (settings) => store.save(settings)
  )

  runtime.configureSlots('scan', '16', 'scan', '68')
  assert.deepEqual(store.load(), {
    channelRegion: 'US_CA',
    slotAMode: 'scan',
    slotAChannel: '16',
    slotBMode: 'scan',
    slotBChannel: '68'
  })
  assert.equal(JSON.parse(readFileSync(settingsPath, 'utf8')).slotBChannel, '68')

  runtime.setRegion('CA')
  assert.equal(store.load().channelRegion, 'CA')
  runtime.tune('04A')
  assert.deepEqual(store.load(), {
    channelRegion: 'CA',
    slotAMode: 'fixed',
    slotAChannel: '04A',
    slotBMode: 'scan',
    slotBChannel: '68'
  })
})

test('ignores missing and malformed tuning settings', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'vhf-tuning-settings-'))
  const store = new TuningSettingsStore(path.join(directory, 'missing.json'))
  assert.deepEqual(store.load(), {})
})
