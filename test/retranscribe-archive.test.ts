import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import test from 'node:test'
import { pcmToWav } from '../src/wav'

const scriptPath = path.resolve('scripts/retranscribe-archive.mjs')

function makeDatabase(directory: string, records: Array<{ sample: number; transcript: string }>): {
  databasePath: string
  audioById: Map<number, Buffer>
  wavById: Map<number, Buffer>
} {
  const databasePath = path.join(directory, 'archive.sqlite3')
  const database = new DatabaseSync(databasePath)
  database.exec(`CREATE TABLE transcript_archive (
    id INTEGER PRIMARY KEY, started_ms INTEGER NOT NULL, duration_seconds REAL NOT NULL,
    sample_rate INTEGER NOT NULL, audio_bytes INTEGER NOT NULL, transcript TEXT NOT NULL, audio_zstd BLOB NOT NULL,
    narration_opus BLOB, narration_bytes INTEGER NOT NULL DEFAULT 0, narration_voice TEXT,
    narration_error TEXT, activity_start_seconds REAL, activity_end_seconds REAL
  )`)
  const insert = database.prepare(`INSERT INTO transcript_archive (
    started_ms, duration_seconds, sample_rate, audio_bytes, transcript, audio_zstd
  ) VALUES (?, ?, ?, ?, ?, ?)`)
  const audioById = new Map<number, Buffer>()
  const wavById = new Map<number, Buffer>()
  records.forEach((record, index) => {
    const pcm = Buffer.alloc(3_200)
    pcm[0] = record.sample
    const wav = pcmToWav(pcm, 16_000)
    const compressed = zstdCompressSync(wav)
    const result = insert.run(index + 1, 0.1, 16_000, wav.length, record.transcript, compressed)
    audioById.set(Number(result.lastInsertRowid), compressed)
    wavById.set(Number(result.lastInsertRowid), wav)
  })
  database.close()
  return { databasePath, audioById, wavById }
}

function writeExecutable(filePath: string, contents: string): void {
  writeFileSync(filePath, `#!/bin/sh\nset -eu\n${contents}`, { mode: 0o700 })
  chmodSync(filePath, 0o700)
}

function runBatch(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: 'utf8', timeout: 120_000, maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, ...env }
  })
}

function lastEvent(stdout: string, name: string): Record<string, unknown> {
  const row = stdout.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
    .reverse().find((event) => event.event === name)
  assert.ok(row, `missing ${name} progress row`)
  return row
}

test('archive rebuild classifies all records before Base and preserves original audio and a private backup', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'vhf-retranscribe-test-'))
  const tempRoot = path.join(directory, 'temp')
  const workRoot = path.join(tempRoot, 'work')
  const settingsPath = path.join(directory, 'transcription-settings.json')
    const backupPath = path.join(directory, 'before.sqlite3')
    const progressPath = path.join(directory, 'progress.json')
    const orderPath = path.join(directory, 'phase-order.txt')
  const helperDirectory = path.join(directory, 'helpers')
  try {
    for (const folder of [tempRoot, workRoot, helperDirectory]) mkdirSync(folder, { mode: 0o700 })
    writeFileSync(settingsPath, JSON.stringify({ enabled: true, model: 'small.en-q5_1', threads: 1 }), { mode: 0o600 })
    const { databasePath, audioById, wavById } = makeDatabase(directory, [
      { sample: 1, transcript: 'old speech transcript' },
      { sample: 0, transcript: 'old noise transcript' },
      { sample: 2, transcript: 'malformed VAD transcript' },
      { sample: 4, transcript: 'failed VAD transcript' },
      { sample: 5, transcript: 'base failure transcript' }
    ])
    const vad = path.join(helperDirectory, 'vad')
    const base = path.join(helperDirectory, 'base')
    writeExecutable(vad, `
sample=$(dd if="$1" bs=1 skip=44 count=1 2>/dev/null | od -An -tu1 | tr -d ' ')
printf 'vad %s\\n' "$sample" >> "$VHF_TEST_ORDER_FILE"
case "$sample" in
  1|5) printf 'Detected 1 speech segments:\\nSpeech segment 0: start = 0.00, end = 0.10\\n' ;;
  2) printf 'Detected 0 speech segments: unexpected output\\n' ;;
  4) exit 7 ;;
  *) printf 'Detected 0 speech segments:\\n' ;;
esac
`)
    writeExecutable(base, `
printf '%s %s\\n' "$2" "$3" >> "$VHF_TEST_BASE_CALLS"
sample=$(dd if="$1" bs=1 skip=44 count=1 2>/dev/null | od -An -tu1 | tr -d ' ')
printf 'base %s\\n' "$sample" >> "$VHF_TEST_ORDER_FILE"
if [ "$sample" = 5 ]; then exit 8; fi
printf 'Fresh radio speech.\\n'
`)

    const result = runBatch([databasePath, '--settings', settingsPath, '--vad-command', vad,
      '--base-command', base, '--backup-path', backupPath, '--progress-path', progressPath], {
      TMPDIR: workRoot,
      VHF_TEST_BASE_CALLS: path.join(directory, 'base-calls.txt'),
      VHF_TEST_ORDER_FILE: orderPath
    })
    assert.equal(result.status, 1, result.stderr)
    assert.equal(result.stdout.includes('old speech transcript'), false)
    assert.equal(result.stdout.includes('Fresh radio speech.'), false)
    const summary = lastEvent(result.stdout, 'finished')
    assert.equal(summary.totalRecords, 5)
    assert.equal(summary.speechPositive, 2)
    assert.equal(summary.noSpeech, 1)
    assert.equal(summary.vadErrors, 2)
    assert.equal(summary.baseCompleted, 1)
    assert.equal(summary.baseErrors, 1)
    assert.equal(summary.phase, 'complete_with_errors')

    const database = new DatabaseSync(databasePath, { readOnly: true })
    const original = new DatabaseSync(backupPath, { readOnly: true })
    try {
      const after = database.prepare('SELECT id, transcript, audio_zstd FROM transcript_archive ORDER BY id').all() as Array<{ id: number; transcript: string; audio_zstd: Uint8Array }>
      const saved = original.prepare('SELECT id, transcript, audio_zstd FROM transcript_archive ORDER BY id').all() as Array<{ id: number; transcript: string; audio_zstd: Uint8Array }>
      assert.deepEqual(after.map((row) => row.transcript), [
        'Fresh radio speech.', '', 'malformed VAD transcript', 'failed VAD transcript', 'base failure transcript'
      ])
      assert.deepEqual(saved.map((row) => row.transcript), [
        'old speech transcript', 'old noise transcript', 'malformed VAD transcript', 'failed VAD transcript', 'base failure transcript'
      ])
      after.forEach((row) => assert.deepEqual(Buffer.from(row.audio_zstd), audioById.get(row.id)))
      after.forEach((row) => assert.deepEqual(zstdDecompressSync(row.audio_zstd), wavById.get(row.id)))
      assert.deepEqual(after.map((row) => Object.keys(row)), saved.map((row) => Object.keys(row)))
      assert.deepEqual(database.prepare('PRAGMA table_info(transcript_archive)').all(), original.prepare('PRAGMA table_info(transcript_archive)').all())
    } finally {
      database.close()
      original.close()
    }
    assert.equal(readFileSync(path.join(directory, 'base-calls.txt'), 'utf8'), 'small.en-q5_1 1\nsmall.en-q5_1 1\n')
    const order = readFileSync(orderPath, 'utf8').trim().split('\n')
    assert.deepEqual(order.slice(0, 5), ['vad 1', 'vad 0', 'vad 2', 'vad 4', 'vad 5'])
    assert.deepEqual(order.slice(5), ['base 1', 'base 5'], 'Base starts only after all VAD checks complete')
    assert.equal((readdirSync(workRoot).length), 0, 'temporary WAV directory is removed')
    assert.equal(statSync(backupPath).mode & 0o777, 0o600, 'backup is private')
    assert.equal(statSync(progressPath).mode & 0o777, 0o600, 'progress is private')
    assert.equal((readFileSync(progressPath, 'utf8').includes('transcript')), false, 'progress contains no transcript text')
    assert.equal((readFileSync(progressPath, 'utf8').includes('id')), false, 'progress contains no record identifiers')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('archive rebuild uses the default Base model when persisted settings omit it', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'vhf-retranscribe-default-'))
  const helpers = path.join(directory, 'helpers')
  const settingsPath = path.join(directory, 'settings.json')
  try {
    mkdirSync(helpers, { mode: 0o700 })
    writeFileSync(settingsPath, JSON.stringify({ enabled: true, threads: 1 }), { mode: 0o600 })
    const { databasePath } = makeDatabase(directory, [{ sample: 1, transcript: 'previous text' }])
    const vad = path.join(helpers, 'vad')
    const base = path.join(helpers, 'base')
    writeExecutable(vad, `printf 'Detected 1 speech segments:\\nSpeech segment 0: start = 0.00, end = 0.10\\n'\n`)
    writeExecutable(base, `printf '%s %s\\n' "$2" "$3" > "$VHF_TEST_BASE_CALLS"\nprintf 'recognized words\\n'\n`)
    const result = runBatch([databasePath, '--settings', settingsPath, '--vad-command', vad, '--base-command', base,
      '--backup-path', path.join(directory, 'before.sqlite3')], {
      VHF_TEST_BASE_CALLS: path.join(directory, 'base-calls.txt')
    })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(readFileSync(path.join(directory, 'base-calls.txt'), 'utf8'), 'base.en-q5_1 1\n')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('archive rebuild snapshots and visits more than 2000 existing records', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'vhf-retranscribe-large-'))
  const helperDirectory = path.join(directory, 'helpers')
  const settingsPath = path.join(directory, 'settings.json')
  const backupPath = path.join(directory, 'before.sqlite3')
  try {
    mkdirSync(helperDirectory, { mode: 0o700 })
    writeFileSync(settingsPath, JSON.stringify({ model: 'base.en-q5_1' }), { mode: 0o600 })
    const records = Array.from({ length: 2_001 }, () => ({ sample: 0, transcript: 'old transcript' }))
    const { databasePath } = makeDatabase(directory, records)
    const vad = path.join(helperDirectory, 'vad-no-speech')
    const base = path.join(helperDirectory, 'base-must-not-run')
    writeExecutable(vad, `printf 'Detected 0 speech segments:\\n'\n`)
    writeExecutable(base, 'exit 99\n')
    const result = runBatch([databasePath, '--settings', settingsPath, '--vad-command', vad,
      '--base-command', base, '--backup-path', backupPath], { TMPDIR: directory })
    assert.equal(result.status, 0, result.stderr)
    const summary = lastEvent(result.stdout, 'finished')
    assert.equal(summary.totalRecords, 2_001)
    assert.equal(summary.noSpeech, 2_001)
    assert.equal(summary.baseCompleted, 0)
    const database = new DatabaseSync(databasePath, { readOnly: true })
    try {
      assert.equal((database.prepare("SELECT COUNT(*) AS count FROM transcript_archive WHERE transcript = ''").get() as { count: number }).count, 2_001)
    } finally {
      database.close()
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('SIGTERM reaps an active VAD child and removes temporary WAVs without updating the record', { timeout: 10_000 }, async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'vhf-retranscribe-cancel-'))
  const tempRoot = path.join(directory, 'temp')
  const helpers = path.join(directory, 'helpers')
  const settingsPath = path.join(directory, 'settings.json')
  const backupPath = path.join(directory, 'before.sqlite3')
  const startedPath = path.join(directory, 'vad-started')
  try {
    mkdirSync(tempRoot, { mode: 0o700 })
    mkdirSync(helpers, { mode: 0o700 })
    writeFileSync(settingsPath, JSON.stringify({ model: 'base.en-q5_1' }), { mode: 0o600 })
    const { databasePath } = makeDatabase(directory, [{ sample: 1, transcript: 'keep until VAD completes' }])
    const vad = path.join(helpers, 'slow-vad')
    writeFileSync(vad, `#!/usr/bin/env node\nimport fs from 'node:fs';\nfs.writeFileSync(process.env.VHF_VAD_STARTED, 'ready', { mode: 0o600 });\nsetInterval(() => {}, 1000);\n`, { mode: 0o700 })
    chmodSync(vad, 0o700)
    const base = path.join(helpers, 'base-must-not-run')
    writeExecutable(base, 'exit 99\n')
    const child = spawn(process.execPath, [scriptPath, databasePath, '--settings', settingsPath,
      '--vad-command', vad, '--base-command', base, '--backup-path', backupPath], {
      stdio: ['ignore', 'ignore', 'ignore'],
      env: { ...process.env, TMPDIR: tempRoot, VHF_VAD_STARTED: startedPath }
    })
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => resolve({ code, signal }))
    })
    const deadline = Date.now() + 5_000
    while (!readFileSyncSafeExists(startedPath) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal(readFileSyncSafeExists(startedPath), true, 'VAD helper started before cancellation')
    child.kill('SIGTERM')
    const result = await closed
    assert.equal(result.code, 130)
    assert.equal(readdirSync(tempRoot).length, 0, 'temporary directory is removed after cancellation')
    const database = new DatabaseSync(databasePath, { readOnly: true })
    try {
      assert.equal((database.prepare('SELECT transcript FROM transcript_archive WHERE id = 1').get() as { transcript: string }).transcript,
        'keep until VAD completes')
    } finally {
      database.close()
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

function readFileSyncSafeExists(filePath: string): boolean {
  try { readFileSync(filePath); return true } catch { return false }
}
