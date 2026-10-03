import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { parseVadSegments, WhisperVadProbe } from '../src/whisper-vad'

test('parses a strict whisper.cpp VAD summary and contiguous segments', () => {
  assert.equal(parseVadSegments('\nDetected 0 speech segments:\n'), 0)
  assert.equal(parseVadSegments('Detected 2 speech segments:\nSpeech segment 0: start = 0.08, end = 0.42\nSpeech segment 1: start = 1.20, end = 2.70'), 2)
})

test('rejects malformed, contradictory, duplicate, or incomplete VAD output', () => {
  for (const output of [
    '',
    'Detected 0 speech segments:\nwarning: no model',
    'Detected 1 speech segments:\nSpeech segment 1: start = 0.1, end = 0.2',
    'Detected 1 speech segments:\nSpeech segment 0: start = 0.2, end = 0.1',
    'Detected 2 speech segments:\nSpeech segment 0: start = 0.1, end = 0.2',
    'Detected 0 speech segments:\nDetected 0 speech segments:',
    'Detected 10001 speech segments:'
  ]) assert.equal(parseVadSegments(output), undefined, output)
})

test('fails open on helper timeout and removes its private temporary WAV', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'vhf-vad-timeout-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const command = path.join(directory, 'fake-vad')
  const model = path.join(directory, 'model.bin')
  const inputPathFile = path.join(directory, 'input-path')
  writeFileSync(model, 'model')
  writeFileSync(command, `#!/bin/sh\nprintf '%s' "$1" > '${inputPathFile}'\nexec sleep 5\n`)
  chmodSync(command, 0o755)
  const probe = new WhisperVadProbe({ command, model, timeoutMs: 3_000 })
  const result = await probe.detect(Buffer.alloc(32_000), 16_000)
  assert.deepEqual(result, { outcome: 'error' })
  const inputPath = readFileSync(inputPathFile, 'utf8')
  assert.equal(existsSync(inputPath), false)
  assert.equal(existsSync(path.dirname(inputPath)), false)
})

test('aborts and reaps the VAD helper before cleaning its temporary input', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'vhf-vad-abort-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const command = path.join(directory, 'fake-vad')
  const model = path.join(directory, 'model.bin')
  const inputPathFile = path.join(directory, 'input-path')
  writeFileSync(model, 'model')
  writeFileSync(command, `#!/bin/sh\nprintf '%s' "$1" > '${inputPathFile}'\nexec sleep 5\n`)
  chmodSync(command, 0o755)
  const probe = new WhisperVadProbe({ command, model })
  const controller = new AbortController()
  const pending = probe.detect(Buffer.alloc(32_000), 16_000, controller.signal)
  for (let attempt = 0; attempt < 100 && !existsSync(inputPathFile); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(existsSync(inputPathFile), true, 'fake VAD helper should start')
  const inputPath = readFileSync(inputPathFile, 'utf8')
  controller.abort()
  assert.deepEqual(await pending, { outcome: 'aborted' })
  assert.equal(existsSync(inputPath), false)
  assert.equal(existsSync(path.dirname(inputPath)), false)
})
