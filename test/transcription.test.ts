import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { RollingReplay } from '../src/rolling-buffer'
import { cleanWhisperOutput, reconcileTranscriptOverlap, transcriptionActiveSeconds, transcriptionTimeoutMs, TranscriptionManager } from '../src/transcription'
import { TranscriptArchive } from '../src/transcript-archive'
import { RnnoiseDenoiser } from '../src/rnnoise'
import { WhisperVadProbe } from '../src/whisper-vad'

test('backlog includes active, queued and pending clips without counting ASR overlap twice', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'vhf-backlog-'))
  const command = path.join(directory, 'fake-whisper')
  const release = `${command}.release`
  writeFileSync(command, '#!/bin/sh\nwhile [ ! -f "${0}.release" ]; do sleep 0.01; done\nprintf "channel one six test\\n"\n')
  chmodSync(command, 0o755)
  writeFileSync(path.join(directory, 'ggml-base.en-q5_1.bin'), 'test model')
  const manager = new TranscriptionManager(path.join(directory, 'settings.json'), command, {
    modelsDir: directory, batchSeconds: 2, overlapSeconds: 1, idleMs: 100
  })
  try {
    await manager.setEnabled(true)
    assert.deepEqual(manager.status().backlog, { clips: 0, seconds: 0, processingClips: 0 })
    const replay = new RollingReplay(8_000, 1, 1, '16')
    const segments = replay.append(Buffer.alloc(8_000 * 2 * 4.5), Date.now(), 0.1)
    segments.push(replay.flush()!)
    for (const segment of segments) manager.enqueue(segment, 20)
    assert.deepEqual(manager.status().backlog, { clips: 5, seconds: 4.5, processingClips: 2 })
    writeFileSync(release, '')
    const deadline = Date.now() + 5_000
    while (manager.status().backlog.clips > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.deepEqual(manager.status().backlog, { clips: 0, seconds: 0, processingClips: 0 })
    assert.ok(segments.every((segment) => segment.transcription?.status === 'complete'))
  } finally {
    manager.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('reconciles fuzzy text repeated by overlapping transcription windows', () => {
  const previous = 'Conditions improve Wednesday night with locally hazardous conditions across the northern outer waters likely to continue.'
  const current = 'With local hazardous conditions across northern outer waters likely to continue. Rough to very rough seas through Wednesday.'
  assert.equal(reconcileTranscriptOverlap(previous, current), 'Rough to very rough seas through Wednesday.')
})

test('reconciles a full minute repeated by a long overlap window', () => {
  const previous = [
    'In the morning then becoming sunny. Highs in the lower 80s by the bay to the lower 90s inland.',
    'Southeast winds up to five miles per hour becoming west in the afternoon. Thursday night mostly clear.',
    'Friday and Friday night partly cloudy. Highs from the lower 80s to mid 90s with lows near 60.',
    'Saturday through Sunday mostly clear. Monday mostly sunny in the morning then becoming sunny.',
    'San Jose 84 and 59, Mountain View 80 and 58, Morgan Hill 88 and 57.',
    'The weather overview for the Bay Area and central coast follows.'
  ].join(' ')
  const current = `${previous.replace('central coast follows', 'federal coast follows')} Elevated fire weather conditions continue through Wednesday.`
  assert.equal(reconcileTranscriptOverlap(previous, current), 'Elevated fire weather conditions continue through Wednesday.')
})

test('repairs long duplicate prefixes already stored in consecutive archive records', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'vhf-transcription-repair-'))
  const archive = new TranscriptArchive(path.join(directory, 'transcripts.sqlite3'))
  const previous = Array.from({ length: 80 }, (_value, index) => `forecast${index}`).join(' ')
  archive.add({
    startedAt: new Date(Date.UTC(2026, 8, 29, 20, 45, 26)).toISOString(),
    endedAt: new Date(Date.UTC(2026, 8, 29, 20, 46, 26)).toISOString(),
    channel: 'WX4',
    durationSeconds: 60,
    sampleRate: 16_000,
    transcript: previous,
    wav: Buffer.alloc(100)
  })
  archive.add({
    startedAt: new Date(Date.UTC(2026, 8, 29, 20, 46, 26)).toISOString(),
    endedAt: new Date(Date.UTC(2026, 8, 29, 20, 47, 26)).toISOString(),
    channel: 'WX4',
    durationSeconds: 60,
    sampleRate: 16_000,
    transcript: `${previous} elevated fire weather conditions continue`,
    wav: Buffer.alloc(100)
  })

  const manager = new TranscriptionManager(path.join(directory, 'settings.json'), path.join(directory, 'missing'), {
    archive,
    modelsDir: directory
  })
  assert.deepEqual(archive.list().slice().reverse().map((record) => record.transcript), [
    previous,
    'elevated fire weather conditions continue'
  ])
  manager.close()
})

test('allows decoding to run longer than its one-minute audio window', () => {
  assert.equal(transcriptionTimeoutMs(15), 90_000)
  assert.equal(transcriptionTimeoutMs(60), 120_000)
  assert.equal(transcriptionTimeoutMs(75), 150_000)
})

test('requires measured carrier activity while preserving a short strong transmission', () => {
  const replay = new RollingReplay(8_000, 2, 1, '16')
  const [segment] = replay.append(Buffer.alloc(32_000), Date.UTC(2026, 8, 29), 0.3)
  assert.ok(segment)
  segment.qualitySpans = [{ bytes: 25_600 }, { bytes: 6_400, discriminatorNoise: 0.06 }]
  assert.equal(transcriptionActiveSeconds(segment, 20), 0.4)
  segment.qualitySpans = [{ bytes: 32_000 }]
  assert.equal(transcriptionActiveSeconds(segment, 20), 0)
})

test('removes Whisper timestamps without discarding decoded speech', () => {
  assert.equal(cleanWhisperOutput([
    '[00:00:00.000 --> 00:00:07.440]   miles per hour becoming southwest',
    '[00:00:07.440 --> 00:00:14.560]   mostly sunny in the morning',
    '[BLANK_AUDIO]'
  ].join('\n')), 'miles per hour becoming southwest mostly sunny in the morning')
})

test('cleans exact non-speech annotations while preserving recognized and bracketed words', () => {
  assert.equal(cleanWhisperOutput('(machine whirring) ♩ ♪ ♫ ♬'), '')
  assert.equal(cleanWhisperOutput('[MUSIC] [ static ] [NOISE] [SILENCE]'), '')
  assert.equal(cleanWhisperOutput('(machine whirring) Coast Guard, channel one six. ♫'), 'Coast Guard, channel one six.')
  assert.equal(cleanWhisperOutput('[Coast Guard] says no, no, no.'), '[Coast Guard] says no, no, no.')
  assert.equal(cleanWhisperOutput('(motor running) Proceed north.'), 'Proceed north.')
})

test('does not archive successful empty or annotation-only Whisper output', async () => {
  const whisperScripts = [
    '#!/bin/sh\nprintf ""\n',
    '#!/bin/sh\nprintf "[BLANK_AUDIO]\\n"\n',
    '#!/bin/sh\nprintf "(machine whirring)\\n♪ ♪ ♪ ♪\\n"\n'
  ]
  for (const [index, script] of whisperScripts.entries()) {
    const directory = mkdtempSync(path.join(os.tmpdir(), `vhf-transcription-noise-${index}-`))
    const command = path.join(directory, 'fake-whisper')
    writeFileSync(path.join(directory, 'ggml-base.en-q5_1.bin'), 'base model')
    writeFileSync(command, script)
    chmodSync(command, 0o755)
    const archive = new TranscriptArchive(path.join(directory, 'transcripts.sqlite3'))
    const manager = new TranscriptionManager(path.join(directory, 'settings.json'), command, {
      archive,
      batchSeconds: 2,
      idleMs: 10,
      modelsDir: directory
    })
    await manager.setEnabled(true)
    const replay = new RollingReplay(8_000, 2, 1, '16')
    const [segment] = replay.append(Buffer.alloc(32_000, 1), Date.UTC(2026, 8, 29), 0.1)
    manager.enqueue(segment!, 20)
    for (let attempt = 0; attempt < 100 && segment!.transcription?.status !== 'complete'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.deepEqual(segment!.transcription, { status: 'complete', text: '' })
    assert.equal(archive.status().records, 0)
    assert.equal((await replay.wavFor(segment!.id, 20))?.length, 32_044)
    manager.close()
  }
})

test('transcription defaults off, requires its runtime, and persists explicit activation', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'vhf-transcription-'))
  const settings = path.join(directory, 'settings.json')
  writeFileSync(path.join(directory, 'ggml-base.en-q5_1.bin'), 'base model')
  writeFileSync(path.join(directory, 'ggml-small.en-q5_1.bin'), 'small model')
  const missing = new TranscriptionManager(settings, path.join(directory, 'missing'))
  assert.equal(missing.status().enabled, false)
  await assert.rejects(() => missing.setEnabled(true), /Install the vhf-whisper-runtime package/)

  const command = path.join(directory, 'fake-whisper')
  writeFileSync(command, '#!/bin/sh\nprintf "channel one six test\\n"\n')
  chmodSync(command, 0o755)
  const manager = new TranscriptionManager(settings, command, { batchSeconds: 2, idleMs: 10, modelsDir: directory })
  await manager.setEnabled(true)
  await manager.configure('small.en-q5_1', 4)
  assert.deepEqual(JSON.parse(readFileSync(settings, 'utf8')), {
    enabled: true,
    model: 'small.en-q5_1',
    threads: 4
  })
  assert.deepEqual(manager.status().availableModels.map((model) => model.id), ['base.en-q5_1', 'small.en-q5_1'])
  const exposedModels = manager.availableModels()
  exposedModels[0]!.bytes = -1
  assert.ok(manager.status().availableModels.every((model) => model.bytes > 0), 'callers cannot mutate cached inventory')
  writeFileSync(path.join(directory, 'ggml-tiny.en-q5_1.bin'), 'tiny model')
  assert.equal(manager.status().availableModels.some((model) => model.id === 'tiny.en-q5_1'), false,
    'periodic status uses cached inventory')
  await manager.configure('tiny.en-q5_1', 1)
  assert.equal(manager.status().availableModels.some((model) => model.id === 'tiny.en-q5_1'), true,
    'explicit configuration refresh detects an externally installed model')
  writeFileSync(path.join(directory, 'ggml-external.en-q5_1.bin'), 'external model')
  const realNow = Date.now
  try {
    Date.now = () => realNow() + 30_001
    assert.equal(manager.status().availableModels.some((model) => model.id === 'external.en-q5_1'), true,
      'periodic inventory refresh detects models installed outside the app')
  } finally {
    Date.now = realNow
  }
  assert.equal(new TranscriptionManager(settings, command, { modelsDir: directory }).status().enabled, true)

  const brief = new RollingReplay(8_000, 2, 1, '16')
  brief.append(Buffer.alloc(30_400), Date.UTC(2026, 8, 29), 0.5)
  const [briefSegment] = brief.append(Buffer.alloc(1_600, 1), Date.UTC(2026, 8, 29, 0, 0, 1), 0.1)
  manager.enqueue(briefSegment!, 20)
  assert.deepEqual(briefSegment!.transcription, { status: 'skipped', text: '' })

  const replay = new RollingReplay(8_000, 2, 1, '16')
  const [segment] = replay.append(Buffer.alloc(32_000, 1), Date.UTC(2026, 8, 29), 0.1)
  manager.enqueue(segment!, 20)
  for (let attempt = 0; attempt < 100 && segment!.transcription?.status !== 'complete'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.deepEqual(segment!.transcription, { status: 'complete', text: 'channel one six test' })
  manager.close()
})

test('feeds the half-wet RNNoise output to Whisper without modifying archived source audio', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'vhf-transcription-rnnoise-'))
  const model = path.join(directory, 'speech.rnnn')
  const denoiseCommand = path.join(directory, 'fake-ffmpeg')
  const whisperCommand = path.join(directory, 'fake-whisper')
  writeFileSync(path.join(directory, 'ggml-base.en-q5_1.bin'), 'base model')
  writeFileSync(model, 'fake model')
  writeFileSync(denoiseCommand, '#!/bin/sh\ntr "\\001" "\\002"\n')
  writeFileSync(whisperCommand, '#!/bin/sh\nod -An -tu1 -j 44 -N 1 "$1" | tr -d " \\n"\n')
  chmodSync(denoiseCommand, 0o755)
  chmodSync(whisperCommand, 0o755)
  const archive = new TranscriptArchive(path.join(directory, 'transcripts.sqlite3'))
  const manager = new TranscriptionManager(path.join(directory, 'settings.json'), whisperCommand, {
    archive,
    batchSeconds: 2,
    idleMs: 10,
    modelsDir: directory,
    denoiser: new RnnoiseDenoiser(denoiseCommand, model)
  })
  await manager.setEnabled(true)
  const replay = new RollingReplay(8_000, 2, 1, '16')
  const [segment] = replay.append(Buffer.alloc(32_000, 1), Date.UTC(2026, 8, 29), 0.1)
  try {
    manager.enqueue(segment!, 20)
    const deadline = Date.now() + 5_000
    while (segment!.transcription?.status !== 'complete' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal(segment!.transcription?.text, '2')
    assert.equal(manager.archiveWav(archive.list()[0]!.id)?.subarray(44, 45)[0], 1)
  } finally {
    manager.close()
  }
})

test('batches adjacent replay slices into a longer radio-speech window', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'vhf-transcription-batch-'))
  const settings = path.join(directory, 'settings.json')
  const command = path.join(directory, 'fake-whisper')
  writeFileSync(path.join(directory, 'ggml-base.en-q5_1.bin'), 'base model')
  writeFileSync(command, '#!/bin/sh\nwc -c < "$1" | tr -d " "\n')
  chmodSync(command, 0o755)
  const archive = new TranscriptArchive(path.join(directory, 'transcripts.sqlite3'))
  const manager = new TranscriptionManager(settings, command, { batchSeconds: 6, idleMs: 10, archive, modelsDir: directory })
  await manager.setEnabled(true)
  const replay = new RollingReplay(8_000, 2, 1, '16')
  const segments = [0, 1, 2].map((index) => replay.append(
    Buffer.alloc(32_000, index + 1),
    Date.UTC(2026, 8, 29, 0, 0, index * 2),
    0.1
  )[0]!)
  for (const segment of segments) manager.enqueue(segment, 20)
  for (let attempt = 0; attempt < 100 && segments[2]!.transcription?.status !== 'complete'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.deepEqual(segments.slice(0, 2).map((segment) => segment.transcription), [
    { status: 'complete', text: '' },
    { status: 'complete', text: '' }
  ])
  assert.deepEqual(segments[2]!.transcription, { status: 'complete', text: '96044' })
  assert.equal(manager.status().archive?.records, 1)
  assert.equal(archive.list()[0]?.transcript, '96044')
  assert.equal(archive.list()[0]?.channel, '16')
  assert.equal(archive.wav(archive.list()[0]!.id)?.length, 96_044)
  manager.close()
})

test('keeps raw WAV audio available for transcription overlap after Opus compaction', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'vhf-transcription-compaction-'))
  const settings = path.join(directory, 'settings.json')
  const whisper = path.join(directory, 'fake-whisper')
  const encoder = path.join(directory, 'fake-opus-encoder')
  writeFileSync(path.join(directory, 'ggml-base.en-q5_1.bin'), 'base model')
  writeFileSync(whisper, [
    '#!/bin/sh',
    'state="$0.state"',
    'bytes=$(wc -c < "$1" | tr -d " ")',
    'if test -e "$state"; then printf "later %s\\n" "$bytes"; else : > "$state"; printf "first %s\\n" "$bytes"; fi'
  ].join('\n'))
  writeFileSync(encoder, '#!/bin/sh\ncat >/dev/null\nprintf x\n')
  chmodSync(whisper, 0o755)
  chmodSync(encoder, 0o755)
  const archive = new TranscriptArchive(path.join(directory, 'transcripts.sqlite3'))
  const manager = new TranscriptionManager(settings, whisper, {
    batchSeconds: 4,
    overlapSeconds: 2,
    idleMs: 5_000,
    archive,
    modelsDir: directory
  })
  const replay = new RollingReplay(8_000, 2, 5, '16', Number.POSITIVE_INFINITY, 'A', 0, 1, undefined, encoder)
  try {
    await manager.setEnabled(true)
    const startedAt = Date.now() - 4_000
    const [first] = replay.append(Buffer.alloc(32_000, 1), startedAt, 0.1)
    const [overlap] = replay.append(Buffer.alloc(32_000, 2), startedAt + 2_000, 0.1)
    manager.enqueue(first!, 20)
    manager.enqueue(overlap!, 20)

    const firstDeadline = Date.now() + 5_000
    while (overlap!.transcription?.status !== 'complete' && Date.now() < firstDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const encoderDeadline = Date.now() + 5_000
    while (!overlap!.opus && Date.now() < encoderDeadline) await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(overlap!.transcription?.status, 'complete')
    assert.ok(overlap!.opus)
    replay.list()
    assert.equal(overlap!.wav.length, 0, 'production replay compaction releases its raw WAV')

    const [next] = replay.append(Buffer.alloc(32_000, 3), startedAt + 4_000, 0.1)
    const originalNextWav = Buffer.from(next!.wav)
    manager.enqueue(next!, 20)
    const secondDeadline = Date.now() + 5_000
    while (next!.transcription?.status !== 'complete' && next!.transcription?.status !== 'error' && Date.now() < secondDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }

    assert.deepEqual(next!.transcription, { status: 'complete', text: 'later 64044' })
    const records = archive.list().slice().reverse()
    assert.equal(records.length, 2)
    assert.deepEqual(archive.wav(records[1]!.id), originalNextWav,
      'overlap is supplied to Whisper but only new, original audio is archived')
  } finally {
    manager.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('archives overlap-only recognition when raw Whisper output contains speech', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'vhf-transcription-overlap-only-'))
  const command = path.join(directory, 'fake-whisper')
  writeFileSync(path.join(directory, 'ggml-base.en-q5_1.bin'), 'base model')
  writeFileSync(command, '#!/bin/sh\nprintf "alpha bravo charlie delta\\n"\n')
  chmodSync(command, 0o755)
  const archive = new TranscriptArchive(path.join(directory, 'transcripts.sqlite3'))
  const manager = new TranscriptionManager(path.join(directory, 'settings.json'), command, {
    archive,
    batchSeconds: 4,
    overlapSeconds: 1,
    idleMs: 10,
    modelsDir: directory
  })
  await manager.setEnabled(true)
  const replay = new RollingReplay(8_000, 2, 1, '16')
  const segments = [0, 1, 2, 3].map((index) => replay.append(
    Buffer.alloc(32_000, index + 1),
    Date.UTC(2026, 8, 29, 0, 0, index * 2),
    0.1
  )[0]!)
  for (const segment of segments) manager.enqueue(segment, 20)
  for (let attempt = 0; attempt < 100 && segments[3]!.transcription?.status !== 'complete'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(segments[3]!.transcription?.text, '')
  assert.equal(archive.status().records, 2)
  assert.deepEqual(archive.list().slice().reverse().map((record) => record.transcript), [
    'alpha bravo charlie delta',
    ''
  ])
  manager.close()
})

test('archives the full source and marks activity with one second of padding on each side', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'vhf-transcription-trim-'))
  const command = path.join(directory, 'fake-whisper')
  writeFileSync(path.join(directory, 'ggml-base.en-q5_1.bin'), 'base model')
  writeFileSync(command, '#!/bin/sh\nprintf "brief channel one six call\\n"\n')
  chmodSync(command, 0o755)
  const archive = new TranscriptArchive(path.join(directory, 'transcripts.sqlite3'))
  const manager = new TranscriptionManager(path.join(directory, 'settings.json'), command, {
    batchSeconds: 60,
    idleMs: 10,
    archive,
    modelsDir: directory
  })
  await manager.setEnabled(true)
  const replay = new RollingReplay(16_000, 60, 120, '16')
  const startedAt = Date.UTC(2026, 8, 29, 20, 0, 0)
  const [segment] = replay.append(Buffer.alloc(1_920_000, 1), startedAt, 0.3)
  assert.ok(segment)
  segment.qualitySpans = [
    { bytes: 640_000, discriminatorNoise: 0.3 },
    { bytes: 160_000, discriminatorNoise: 0.06 },
    { bytes: 1_120_000, discriminatorNoise: 0.3 }
  ]
  manager.enqueue(segment, 20)
  for (let attempt = 0; attempt < 100 && segment.transcription?.status !== 'complete'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  const [record] = archive.list()
  assert.equal(record?.startedAt, new Date(startedAt).toISOString())
  assert.equal(record?.durationSeconds, 60)
  assert.equal(record?.audioBytes, 1_920_044)
  assert.equal(record?.activityStartSeconds, 19)
  assert.equal(record?.activityEndSeconds, 26)
  manager.close()
})

test('reuses audio overlap between windows without duplicating text or archived audio', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'vhf-transcription-overlap-'))
  const settings = path.join(directory, 'settings.json')
  const command = path.join(directory, 'fake-whisper')
  writeFileSync(path.join(directory, 'ggml-base.en-q5_1.bin'), 'base model')
  writeFileSync(command, [
    '#!/bin/sh',
    'state="$0.state"',
    'if test -e "$state"; then',
    '  printf "echo foxtrot golf hotel india juliet\\n"',
    'else',
    '  : > "$state"',
    '  printf "alpha bravo charlie delta echo foxtrot golf hotel\\n"',
    'fi'
  ].join('\n'))
  chmodSync(command, 0o755)
  const archive = new TranscriptArchive(path.join(directory, 'transcripts.sqlite3'))
  const manager = new TranscriptionManager(settings, command, {
    batchSeconds: 6,
    overlapSeconds: 2,
    idleMs: 1_000,
    archive,
    modelsDir: directory
  })
  await manager.setEnabled(true)
  const replay = new RollingReplay(8_000, 2, 1, '16')
  const segments = [0, 1, 2, 3, 4].map((index) => replay.append(
    Buffer.alloc(32_000, index + 1),
    Date.UTC(2026, 8, 29, 0, 0, index * 2),
    0.1
  )[0]!)
  for (const segment of segments) manager.enqueue(segment, 20)
  for (let attempt = 0; attempt < 100 && segments[4]!.transcription?.status !== 'complete'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.deepEqual(segments[2]!.transcription, {
    status: 'complete',
    text: 'alpha bravo charlie delta echo foxtrot golf hotel'
  })
  assert.deepEqual(segments[4]!.transcription, { status: 'complete', text: 'india juliet' })
  const records = archive.list().slice().reverse()
  assert.equal(records.length, 2)
  assert.deepEqual(records.map((record) => record.durationSeconds), [6, 4])
  assert.deepEqual(records.map((record) => record.transcript), [
    'alpha bravo charlie delta echo foxtrot golf hotel',
    'india juliet'
  ])
  manager.close()
})

test('trims overlap audio to ten seconds when replay slices are a full minute', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'vhf-transcription-long-slices-'))
  const settings = path.join(directory, 'settings.json')
  const command = path.join(directory, 'fake-whisper')
  writeFileSync(path.join(directory, 'ggml-base.en-q5_1.bin'), 'base model')
  writeFileSync(command, '#!/bin/sh\nwc -c < "$1" | tr -d " "\n')
  chmodSync(command, 0o755)
  const archive = new TranscriptArchive(path.join(directory, 'transcripts.sqlite3'))
  const manager = new TranscriptionManager(settings, command, {
    batchSeconds: 60,
    overlapSeconds: 10,
    idleMs: 1_000,
    archive,
    modelsDir: directory
  })
  await manager.setEnabled(true)
  const replay = new RollingReplay(16_000, 60, 120, 'WX4')
  const first = replay.append(Buffer.alloc(1_920_000, 1), Date.UTC(2026, 8, 29, 20, 45, 26), 0.05)[0]!
  const second = replay.append(Buffer.alloc(1_920_000, 2), Date.UTC(2026, 8, 29, 20, 46, 26), 0.05)[0]!
  manager.enqueue(first, 20)
  for (let attempt = 0; attempt < 100 && first.transcription?.status !== 'complete'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  manager.enqueue(second, 20)
  for (let attempt = 0; attempt < 100 && second.transcription?.status !== 'complete'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }

  assert.equal(first.transcription?.text, '1920044')
  assert.equal(second.transcription?.text, '2240044')
  assert.deepEqual(archive.list().slice().reverse().map((record) => record.durationSeconds), [60, 60])
  manager.close()
})
