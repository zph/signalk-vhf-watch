import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { RollingReplay } from '../src/rolling-buffer'
import { TranscriptionManager } from '../src/transcription'

test('transcription defaults off, requires its runtime, and persists explicit activation', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'vhf-transcription-'))
  const settings = path.join(directory, 'settings.json')
  const missing = new TranscriptionManager(settings, path.join(directory, 'missing'))
  assert.equal(missing.status().enabled, false)
  await assert.rejects(() => missing.setEnabled(true), /Install the vhf-whisper-runtime package/)

  const command = path.join(directory, 'fake-whisper')
  writeFileSync(command, '#!/bin/sh\nprintf "channel one six test\\n"\n')
  chmodSync(command, 0o755)
  const manager = new TranscriptionManager(settings, command)
  await manager.setEnabled(true)
  assert.equal(JSON.parse(readFileSync(settings, 'utf8')).enabled, true)
  assert.equal(new TranscriptionManager(settings, command).status().enabled, true)

  const brief = new RollingReplay(8_000, 2, 1, '16')
  brief.append(Buffer.alloc(30_400), Date.UTC(2026, 8, 29), 0.5)
  const [briefSegment] = brief.append(Buffer.alloc(1_600, 1), Date.UTC(2026, 8, 29, 0, 0, 1), 0.1)
  manager.enqueue(briefSegment!, 20)
  assert.deepEqual(briefSegment!.transcription, { status: 'skipped', text: '' })

  const replay = new RollingReplay(8_000, 2, 1, '16')
  const [segment] = replay.append(Buffer.alloc(32_000, 1), Date.UTC(2026, 8, 29), 0.1)
  manager.enqueue(segment!, 20)
  for (let attempt = 0; attempt < 50 && segment!.transcription?.status !== 'complete'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.deepEqual(segment!.transcription, { status: 'complete', text: 'channel one six test' })
  manager.stop()
})
