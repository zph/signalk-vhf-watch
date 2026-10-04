import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { RollingReplay } from '../src/rolling-buffer'
import { TranscriptionManager } from '../src/transcription'
import { WhisperVadProbe } from '../src/whisper-vad'

function executable(file: string, lines: string[]): void {
  writeFileSync(file, `${lines.join('\n')}\n`)
  chmodSync(file, 0o755)
}

async function waitFor(done: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !done(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(done(), true, 'transcription should finish')
}

test('prechecks only new audio, preserves the original overlap for Base, and fails open on malformed output', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vhf-vad-overlap-'))
  const model = path.join(dir, 'vad.bin')
  const vad = path.join(dir, 'vad')
  const whisper = path.join(dir, 'whisper')
  const vadLog = path.join(dir, 'vad.log')
  const whisperLog = path.join(dir, 'whisper.log')
  writeFileSync(model, 'vad model')
  writeFileSync(path.join(dir, 'ggml-base.en-q5_1.bin'), 'base model')
  executable(vad, [
    '#!/bin/sh', 'set -eu',
    `printf '%s %s\\n' "$(wc -c < "$1" | tr -d ' ')" "$(od -An -tu1 -j44 -N1 "$1" | tr -d ' \\n')" >> '${vadLog}'`,
    `if test "$(wc -l < '${vadLog}')" -eq 1; then printf 'Detected 1 speech segments:\\nSpeech segment 0: start = 0.00, end = 1.00\\n'; else printf 'Detected 0 speech segments:\\nunexpected output\\n'; fi`
  ])
  executable(whisper, [
    '#!/bin/sh', 'set -eu',
    `printf '%s %s\\n' "$(wc -c < "$1" | tr -d ' ')" "$(od -An -tu1 -j44 -N1 "$1" | tr -d ' \\n')" >> '${whisperLog}'`,
    `printf 'coast guard call\\n'`
  ])

  const manager = new TranscriptionManager(path.join(dir, 'settings.json'), whisper, {
    batchSeconds: 4, overlapSeconds: 1, idleMs: 5, modelsDir: dir,
    vad: new WhisperVadProbe({ command: vad, model })
  })
  await manager.setEnabled(true)
  const replay = new RollingReplay(16_000, 2, 1, '16')
  const segments = [1, 2, 3].map((sample, index) => replay.append(
    Buffer.alloc(64_000, sample), Date.UTC(2026, 8, 29, 0, 0, index * 2), 0.1
  )[0]!)
  manager.enqueue(segments[0]!, 20)
  manager.enqueue(segments[1]!, 20)
  await waitFor(() => segments[1]!.transcription?.status === 'complete')
  manager.enqueue(segments[2]!, 20)
  await waitFor(() => segments[2]!.transcription?.status === 'complete')

  assert.deepEqual(readFileSync(vadLog, 'utf8').trim().split(/\r?\n/), ['128044 1', '64044 3'])
  assert.deepEqual(readFileSync(whisperLog, 'utf8').trim().split(/\r?\n/), ['128044 1', '96044 2'])
  assert.deepEqual(manager.status().speechGate, { mode: 'filter', checked: 1, wouldSkip: 0, skipped: 0, failOpen: 1 })
  manager.close()
})

test('production skips Base for valid no-speech while preserving the raw replay audio', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vhf-vad-silence-'))
  const model = path.join(dir, 'vad.bin')
  const vad = path.join(dir, 'vad')
  const whisper = path.join(dir, 'whisper')
  const whisperLog = path.join(dir, 'whisper.log')
  writeFileSync(model, 'vad model')
  writeFileSync(path.join(dir, 'ggml-base.en-q5_1.bin'), 'base model')
  executable(vad, ['#!/bin/sh', `printf 'Detected 0 speech segments:\\n'`])
  executable(whisper, ['#!/bin/sh', `printf called >> '${whisperLog}'`, `printf 'coast guard call\\n'`])
  const manager = new TranscriptionManager(path.join(dir, 'settings.json'), whisper, {
    batchSeconds: 2, idleMs: 5, modelsDir: dir,
    vad: new WhisperVadProbe({ command: vad, model })
  })
  await manager.setEnabled(true)
  const replay = new RollingReplay(16_000, 2, 1, '16')
  const [segment] = replay.append(Buffer.alloc(64_000, 7), Date.UTC(2026, 8, 29), 0.1)
  const original = Buffer.from(segment!.wav)
  manager.enqueue(segment!, 20)
  await waitFor(() => segment!.transcription?.status === 'complete')
  assert.deepEqual(segment!.transcription, { status: 'complete', text: '' })
  assert.equal(existsSync(whisperLog), false, 'valid no-speech result skips the Whisper CLI')
  assert.deepEqual(segment!.wav, original)
  assert.deepEqual(manager.status().speechGate, { mode: 'filter', checked: 1, wouldSkip: 1, skipped: 1, failOpen: 0 })
  manager.close()
})

test('test-only observe mode still sends a valid no-speech batch to Base', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vhf-vad-filter-'))
  const model = path.join(dir, 'vad.bin')
  const vad = path.join(dir, 'vad')
  const whisper = path.join(dir, 'whisper')
  const whisperLog = path.join(dir, 'whisper.log')
  writeFileSync(model, 'vad model')
  writeFileSync(path.join(dir, 'ggml-base.en-q5_1.bin'), 'base model')
  executable(vad, ['#!/bin/sh', `printf 'Detected 0 speech segments:\\n'`])
  executable(whisper, ['#!/bin/sh', `printf called >> '${whisperLog}'`, `printf 'coast guard call\\n'`])
  const manager = new TranscriptionManager(path.join(dir, 'settings.json'), whisper, {
    batchSeconds: 2, idleMs: 5, modelsDir: dir,
    vad: new WhisperVadProbe({ command: vad, model }),
    vadMode: 'observe'
  })
  await manager.setEnabled(true)
  const replay = new RollingReplay(16_000, 2, 1, '16')
  const [segment] = replay.append(Buffer.alloc(64_000, 7), Date.UTC(2026, 8, 29), 0.1)
  const original = Buffer.from(segment!.wav)
  manager.enqueue(segment!, 20)
  await waitFor(() => segment!.transcription?.status === 'complete')
  assert.deepEqual(segment!.transcription, { status: 'complete', text: 'coast guard call' })
  assert.equal(existsSync(whisperLog), true)
  assert.deepEqual(segment!.wav, original)
  assert.deepEqual(manager.status().speechGate, { mode: 'observe', checked: 1, wouldSkip: 1, skipped: 0, failOpen: 0 })
  manager.close()
})

test('closing the manager while VAD is running does not start Base ASR', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vhf-vad-close-'))
  const model = path.join(dir, 'vad.bin')
  const vad = path.join(dir, 'vad')
  const started = path.join(dir, 'vad.started')
  const whisperLog = path.join(dir, 'whisper.log')
  const whisper = path.join(dir, 'whisper')
  writeFileSync(model, 'vad model')
  writeFileSync(path.join(dir, 'ggml-base.en-q5_1.bin'), 'base model')
  executable(vad, [
    '#!/usr/bin/env node',
    `require('node:fs').writeFileSync('${started}', 'started')`,
    'setTimeout(() => process.stdout.write("Detected 1 speech segments:\\nSpeech segment 0: start = 0.00, end = 1.00\\n"), 5000)'
  ])
  executable(whisper, ['#!/bin/sh', `printf called >> '${whisperLog}'`])
  const manager = new TranscriptionManager(path.join(dir, 'settings.json'), whisper, {
    batchSeconds: 2, idleMs: 5, modelsDir: dir,
    vad: new WhisperVadProbe({ command: vad, model })
  })
  await manager.setEnabled(true)
  const replay = new RollingReplay(16_000, 2, 1, '16')
  const [segment] = replay.append(Buffer.alloc(64_000, 7), Date.UTC(2026, 8, 29), 0.1)
  manager.enqueue(segment!, 20)
  await waitFor(() => existsSync(started))
  manager.close()
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(existsSync(whisperLog), false)
})
