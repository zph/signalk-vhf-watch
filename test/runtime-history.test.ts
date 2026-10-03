import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { normalizeConfig } from '../src/config'
import { ReplayHistoryStore } from '../src/replay-history-store'
import { VhfRuntime } from '../src/runtime'

test('runtime reloads retained audio across restart and persists replay deletion and clearing', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'vhf-runtime-history-'))
  try {
    const config = normalizeConfig({ enabled: false, receiverMode: 'rtl_sdr', sampleRate: 8_000, segmentSeconds: 2, replayMinutes: 1 })
    const firstStore = new ReplayHistoryStore(directory, config.replayMinutes, config.maxBufferMiB * 1024 * 1024)
    const first = new VhfRuntime(config, undefined, undefined, undefined, undefined, undefined, undefined, firstStore)
    first.start()
    first.replay.append(Buffer.alloc(64_000, 1), Date.now() - 4_000)
    const originalIds = first.segments().map((entry) => entry.id).sort((left, right) => left - right)
    assert.deepEqual(originalIds, [1, 3])
    await first.stop()

    const secondStore = new ReplayHistoryStore(directory, config.replayMinutes, config.maxBufferMiB * 1024 * 1024)
    const second = new VhfRuntime(config, undefined, undefined, undefined, undefined, undefined, undefined, secondStore)
    second.start()
    assert.deepEqual(second.segments().map((entry) => entry.id).sort((left, right) => left - right), originalIds)
    assert.ok((await second.replayWavFor(1, 0))?.length)
    assert.equal(second.deleteReplay(3), true)
    await second.stop()
    assert.deepEqual(new ReplayHistoryStore(directory, config.replayMinutes, config.maxBufferMiB * 1024 * 1024)
      .load().segments.map((entry) => entry.id), [1])

    const third = new VhfRuntime(config, undefined, undefined, undefined, undefined, undefined, undefined,
      new ReplayHistoryStore(directory, config.replayMinutes, config.maxBufferMiB * 1024 * 1024))
    third.start()
    third.clearReplay()
    await third.stop()
    assert.deepEqual(new ReplayHistoryStore(directory, config.replayMinutes, config.maxBufferMiB * 1024 * 1024).load().segments, [])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
