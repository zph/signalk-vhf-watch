import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { NarrationManager } from '../src/narration'
import { TranscriptArchive } from '../src/transcript-archive'
import { pcmToWav } from '../src/wav'

function addRecord(archive: TranscriptArchive, now: number): number {
  return archive.add({
    startedAt: new Date(now).toISOString(),
    endedAt: new Date(now + 1_000).toISOString(),
    channel: '16',
    durationSeconds: 1,
    sampleRate: 8_000,
    transcript: 'Coast Guard Sector San Francisco, this is sailing vessel test.',
    wav: pcmToWav(Buffer.alloc(16_000), 8_000)
  }, now)!.id
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail('timed out waiting for narration state')
}

test('generates durable Opus only after the idle gate opens', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'vhf-narration-'))
  const archive = new TranscriptArchive(path.join(directory, 'transcripts.sqlite3'))
  const id = addRecord(archive, Date.UTC(2026, 8, 29))
  const command = path.join(directory, 'fake-tts')
  writeFileSync(command, '#!/bin/sh\nprintf "OggSabcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789" > "$2"\n')
  chmodSync(command, 0o755)
  let idle = false
  const narrator = new NarrationManager(archive, command, { canRun: () => idle, ffmpegCommand: command })
  assert.equal(narrator.status().state, 'waiting')
  assert.equal(archive.record(id)?.narrationBytes, 0)
  idle = true
  narrator.resume()
  await waitFor(() => archive.record(id)!.narrationBytes > 0)
  assert.equal(archive.record(id)?.narrationVoice, 'af_sarah')
  assert.equal(archive.narrationOpus(id)?.subarray(0, 4).toString('ascii'), 'OggS')
  assert.equal((await narrator.sessionOpus([id]))?.subarray(0, 4).toString('ascii'), 'OggS')
  archive.updateTranscript(id, 'Corrected transcript')
  assert.equal(archive.record(id)?.narrationBytes, 0)
  narrator.close()
  archive.close()
})

test('pre-emption returns active Kokoro work to the queue', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'vhf-narration-preempt-'))
  const archive = new TranscriptArchive(path.join(directory, 'transcripts.sqlite3'))
  const id = addRecord(archive, Date.UTC(2026, 8, 29))
  const command = path.join(directory, 'slow-tts')
  writeFileSync(command, '#!/bin/sh\ntrap "exit 143" TERM\nsleep 2\nprintf "OggSabcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789" > "$2"\n')
  chmodSync(command, 0o755)
  let idle = true
  const narrator = new NarrationManager(archive, command, { canRun: () => idle, ffmpegCommand: command })
  await waitFor(() => narrator.status().state === 'generating')
  idle = false
  narrator.yield()
  await waitFor(() => narrator.status().state === 'waiting')
  assert.equal(narrator.status().queued, 1)
  assert.equal(archive.record(id)?.narrationError, undefined)
  assert.equal(archive.record(id)?.narrationBytes, 0)
  narrator.close()
  archive.close()
})
