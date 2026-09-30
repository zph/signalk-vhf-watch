import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { DscMessageCache } from '../src/dsc-cache'
import type { DscMessage } from '../src/dsc'

function call(receivedAt: string): DscMessage {
  return {
    id: 0,
    receivedAt,
    format: 'individual',
    category: 'routine',
    selfMmsi: '247365000',
    targetMmsi: '247365000',
    eos: 117,
    validCharacters: true,
    rawSymbols: [120, 120, 24, 73, 65, 0, 0, 100, 24, 73, 65, 0, 0, 117]
  }
}

test('persists DSC calls with TTL, count, and byte bounds', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vhf-dsc-cache-'))
  const file = path.join(directory, 'calls.json')
  const now = Date.now()
  try {
    const cache = new DscMessageCache(file, { ttlHours: 24, maxMessages: 2, maxBytes: 2_048 })
    cache.add([call(new Date(now).toISOString())], now)
    cache.add([call(new Date(now + 1).toISOString())], now + 1)
    cache.add([call(new Date(now + 2).toISOString())], now + 2)
    assert.equal(cache.list(now + 2).length, 2)
    assert.ok(fs.statSync(file).size <= 2_048)
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)

    const restored = new DscMessageCache(file, { ttlHours: 24, maxMessages: 2, maxBytes: 2_048 })
    assert.equal(restored.list(now + 2).length, 2)
    assert.equal(restored.list(now + 25 * 60 * 60 * 1000).length, 0)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
