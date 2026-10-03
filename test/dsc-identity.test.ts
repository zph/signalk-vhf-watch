import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { DscMessage } from '../src/dsc'
import { normalizeConfig } from '../src/config'
import { DscMessageCache } from '../src/dsc-cache'
import { enrichDscMessages, findDscCallerIdentity } from '../src/dsc-identity'
import { VhfRuntime } from '../src/runtime'

const message: DscMessage = {
  id: 12,
  receivedAt: '2026-10-02T12:00:00.000Z',
  format: 'distress',
  category: 'distress',
  selfMmsi: '367123456',
  eos: 117,
  validCharacters: true,
  rawSymbols: [112, 0, 0, 0, 0, 0, 0, 0, 0, 0, 117]
}

test('resolves the transmitting MMSI from current Signal K vessel name and VHF callsign', () => {
  const vessels = {
    'urn:mrn:imo:mmsi:367123456': {
      name: { value: 'Sea Test' },
      communication: { callsignVhf: { value: 'WXYZ' } }
    }
  }
  assert.deepEqual(findDscCallerIdentity(vessels, '367123456'), { name: 'Sea Test', callsign: 'WXYZ' })
  assert.equal(findDscCallerIdentity(vessels, '000000000'), undefined)
})

test('enriches copies on each read and drops identity fields when AIS identity disappears', () => {
  const enriched = enrichDscMessages([message], () => ({ name: 'Sea Test', callsign: 'WXYZ' }))
  assert.deepEqual(enriched[0], { ...message, callerName: 'Sea Test', callerCallsign: 'WXYZ' })
  assert.equal(message.callerName, undefined)

  const noLongerKnown = enrichDscMessages(enriched, () => undefined)
  assert.deepEqual(noLongerKnown[0], message)

  assert.deepEqual(enrichDscMessages([message], () => { throw new Error('AIS temporarily unavailable') })[0], message)
})

test('refreshes identity for calls loaded from the persistent DSC cache', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vhf-dsc-identity-'))
  const cachePath = path.join(directory, 'calls.json')
  const cache = new DscMessageCache(cachePath, { ttlHours: 168, maxMessages: 100, maxBytes: 256 * 1024 })
  cache.add([message])
  let vessels: unknown = undefined
  let unavailable = false
  const runtime = new VhfRuntime(
    normalizeConfig({ enabled: false }),
    new DscMessageCache(cachePath, { ttlHours: 168, maxMessages: 100, maxBytes: 256 * 1024 }),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    () => {
      if (unavailable) throw new Error('Signal K data tree unavailable')
      return vessels
    }
  )
  try {
    runtime.start()
    assert.equal(runtime.dscMessages()[0]?.callerName, undefined)
    vessels = { 'urn:mrn:imo:mmsi:367123456': { name: 'Sea Test' } }
    assert.equal(runtime.dscMessages()[0]?.callerName, 'Sea Test')
    vessels = { 'urn:mrn:imo:mmsi:367123456': { communication: { callsignVhf: 'WXYZ' } } }
    assert.equal(runtime.dscMessages()[0]?.callerCallsign, 'WXYZ')
    unavailable = true
    const withoutAis = runtime.dscMessages()[0]
    assert.equal(withoutAis?.selfMmsi, message.selfMmsi)
    assert.equal(withoutAis?.callerCallsign, undefined)
    runtime.clearDscMessages()
    assert.deepEqual(runtime.dscMessages(), [])
  } finally {
    runtime.stop()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('refreshes retained identities every ten minutes and clears the timer on stop', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  let lookups = 0
  const runtime = new VhfRuntime(
    normalizeConfig({ enabled: false }),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    () => { lookups += 1; return undefined }
  )
  runtime.start()
  const startedLookups = lookups
  t.mock.timers.tick(10 * 60 * 1000)
  assert.equal(lookups, startedLookups + 1)
  runtime.stop()
  const stoppedLookups = lookups
  t.mock.timers.tick(20 * 60 * 1000)
  assert.equal(lookups, stoppedLookups)
})
