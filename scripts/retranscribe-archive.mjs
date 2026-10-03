#!/usr/bin/env node

import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, renameSync } from 'node:fs'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { zstdDecompressSync } from 'node:zlib'

const require = createRequire(import.meta.url)
const { cleanWhisperOutput, transcriptionTimeoutMs, DEFAULT_TRANSCRIPTION_MODEL } = require('../dist/transcription.js')
const { parseVadSegments, VAD_TIMEOUT_MS } = require('../dist/whisper-vad.js')
const sqlite = await import('node:sqlite')
const { DatabaseSync } = sqlite

const DEFAULT_VAD_COMMAND = '/usr/bin/vhf-vad'
const DEFAULT_BASE_COMMAND = '/usr/bin/vhf-whisper'
const MAX_VAD_OUTPUT = 65_536
const MAX_BASE_OUTPUT = 1_048_576

process.umask(0o077)

function parseArguments(argv) {
  const positional = []
  const options = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (!value.startsWith('--')) {
      positional.push(value)
      continue
    }
    if (index + 1 >= argv.length || argv[index + 1].startsWith('--')) {
      throw new Error('invalid arguments')
    }
    options.set(value, argv[++index])
  }
  if (positional.length !== 1 || !options.has('--settings')) throw new Error('invalid arguments')
  const known = new Set(['--settings', '--vad-command', '--base-command', '--backup-path', '--progress-path', '--pause-file'])
  if ([...options.keys()].some((key) => !known.has(key))) throw new Error('invalid arguments')
  return {
    databasePath: path.resolve(positional[0]),
    settingsPath: path.resolve(options.get('--settings')),
    vadCommand: options.get('--vad-command') ?? DEFAULT_VAD_COMMAND,
    baseCommand: options.get('--base-command') ?? DEFAULT_BASE_COMMAND,
    backupPath: options.has('--backup-path') ? path.resolve(options.get('--backup-path')) : undefined,
    progressPath: options.has('--progress-path') ? path.resolve(options.get('--progress-path')) : undefined,
    pauseFile: options.has('--pause-file') ? path.resolve(options.get('--pause-file')) : undefined
  }
}

function readPersistedModel(settingsPath) {
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
  if (!settings || typeof settings !== 'object') {
    throw new Error('invalid transcription settings')
  }
  const model = typeof settings.model === 'string' ? settings.model : DEFAULT_TRANSCRIPTION_MODEL
  if (!/^[a-zA-Z0-9._-]+$/.test(model)) throw new Error('invalid transcription settings')
  return model
}

function writePrivateJson(filePath, value) {
  const temporary = `${filePath}.new-${process.pid}`
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 })
  chmodSync(temporary, 0o600)
  renameSync(temporary, filePath)
}

function emitProgress(progressPath, state) {
  const progress = {
    phase: state.phase,
    totalRecords: state.totalRecords,
    completed: state.completed,
    speechPositive: state.speechPositive,
    noSpeech: state.noSpeech,
    vadErrors: state.vadErrors,
    baseCompleted: state.baseCompleted,
    baseErrors: state.baseErrors,
    recordErrors: state.recordErrors,
    paused: state.paused ?? false,
    elapsedMs: Date.now() - state.startedAt
  }
  if (progressPath) writePrivateJson(progressPath, progress)
  process.stdout.write(`${JSON.stringify({ event: 'progress', ...progress })}\n`)
}

function makeBackupPath(databasePath) {
  const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
  return `${databasePath}.before-vad-retranscribe-${stamp}-${process.pid}.sqlite3`
}

async function createConsistentBackup(database, sourcePath, requestedPath, expectedIds) {
  const backupPath = requestedPath ?? makeBackupPath(sourcePath)
  if (path.resolve(backupPath) === sourcePath || existsSync(backupPath)) throw new Error('backup path is not available')
  if (typeof sqlite.backup === 'function') {
    await sqlite.backup(database, backupPath)
  } else {
    const escaped = backupPath.replaceAll("'", "''")
    database.exec(`VACUUM INTO '${escaped}'`)
  }
  chmodSync(backupPath, 0o600)
  const verify = new DatabaseSync(backupPath, { readOnly: true })
  try {
    const ids = verify.prepare('SELECT id FROM transcript_archive ORDER BY started_ms ASC, id ASC')
      .all().map((row) => Number(row.id))
    if (ids.length !== expectedIds.length || ids.some((id, index) => id !== expectedIds[index])) {
      throw new Error('backup does not match the source record snapshot')
    }
  } finally {
    verify.close()
  }
  return backupPath
}

let stopRequested = false
let activeChild
let forcedKillTimer
function requestStop() {
  stopRequested = true
  if (!activeChild) return
  activeChild.kill('SIGTERM')
  forcedKillTimer = setTimeout(() => activeChild?.kill('SIGKILL'), 1_000)
  forcedKillTimer.unref?.()
}

process.on('SIGTERM', requestStop)
process.on('SIGINT', requestStop)

function runChild(command, args, timeoutMs, outputLimit) {
  return new Promise((resolve) => {
    let child
    let stdout = ''
    let outputOverflow = false
    let timedOut = false
    let settled = false
    let timeout
    let childKillTimer
    const finish = (result) => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      if (childKillTimer) clearTimeout(childKillTimer)
      if (forcedKillTimer) clearTimeout(forcedKillTimer)
      if (activeChild === child) activeChild = undefined
      resolve(result)
    }
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'] })
      activeChild = child
    } catch {
      finish({ ok: false, aborted: stopRequested, output: '' })
      return
    }
    timeout = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      childKillTimer = setTimeout(() => child.kill('SIGKILL'), 1_000)
      childKillTimer.unref?.()
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      if (stdout.length + chunk.length > outputLimit) {
        const remaining = Math.max(0, outputLimit - stdout.length)
        stdout += chunk.slice(0, remaining)
        outputOverflow = true
      } else {
        stdout += chunk
      }
    })
    child.on('error', () => finish({ ok: false, aborted: stopRequested, output: '' }))
    child.on('close', (code) => finish({
      ok: code === 0 && !timedOut && !outputOverflow && !stopRequested,
      aborted: stopRequested,
      output: stdout
    }))
    if (stopRequested) requestStop()
  })
}

function snapshotRecordIds(database) {
  const table = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'transcript_archive'").get()
  if (!table) throw new Error('archive table is missing')
  return database.prepare('SELECT id FROM transcript_archive ORDER BY started_ms ASC, id ASC')
    .all().map((row) => Number(row.id))
}

function isCanonicalArchiveWav(wav, record) {
  return wav.length >= 46 &&
    wav.toString('ascii', 0, 4) === 'RIFF' &&
    wav.readUInt32LE(4) === wav.length - 8 &&
    wav.toString('ascii', 8, 12) === 'WAVE' &&
    wav.toString('ascii', 12, 16) === 'fmt ' &&
    wav.readUInt32LE(16) === 16 &&
    wav.readUInt16LE(20) === 1 &&
    wav.readUInt16LE(22) === 1 &&
    wav.readUInt32LE(24) === 16_000 &&
    wav.readUInt32LE(28) === 32_000 &&
    wav.readUInt16LE(32) === 2 &&
    wav.readUInt16LE(34) === 16 &&
    wav.toString('ascii', 36, 40) === 'data' &&
    wav.readUInt32LE(40) === wav.length - 44 &&
    wav.length % 2 === 0 &&
    record.sample_rate === 16_000 &&
    Number.isFinite(record.duration_seconds) && record.duration_seconds > 0 &&
    Number.isSafeInteger(record.audio_bytes) && wav.length === record.audio_bytes
}

async function waitForResume(pauseFile, state, progressPath) {
  if (!pauseFile || !existsSync(pauseFile) || stopRequested) return
  state.paused = true
  emitProgress(progressPath, state)
  while (existsSync(pauseFile) && !stopRequested) await new Promise((resolve) => setTimeout(resolve, 1_000))
  state.paused = false
  emitProgress(progressPath, state)
}

async function main() {
  let args
  try {
    args = parseArguments(process.argv.slice(2))
  } catch {
    process.stderr.write('usage: retranscribe-archive.mjs /path/to/transcripts.sqlite3 --settings /path/to/transcription-settings.json [--vad-command PATH] [--base-command PATH] [--backup-path PATH] [--progress-path PATH] [--pause-file PATH]\n')
    process.exitCode = 2
    return
  }

  let database
  let workDirectory
  const startedAt = Date.now()
  const state = {
    phase: 'starting', totalRecords: 0, completed: 0, speechPositive: 0, noSpeech: 0,
    vadErrors: 0, baseCompleted: 0, baseErrors: 0, recordErrors: 0, startedAt
  }
  try {
    if (!existsSync(args.databasePath)) throw new Error('archive database does not exist')
    const model = readPersistedModel(args.settingsPath)
    database = new DatabaseSync(args.databasePath)
    const ids = snapshotRecordIds(database)
    state.totalRecords = ids.length
    const outputPaths = [args.databasePath, args.settingsPath, args.backupPath, args.progressPath, args.pauseFile]
      .filter(Boolean).map((value) => path.resolve(value))
    if (new Set(outputPaths).size !== outputPaths.length) throw new Error('input and output paths must be distinct')
    const backupPath = await createConsistentBackup(database, args.databasePath, args.backupPath, ids)
    if (args.progressPath && path.resolve(args.progressPath) === backupPath) throw new Error('progress and backup paths must differ')
    const tempParent = mkdtempSync(path.join(os.tmpdir(), 'vhf-retranscribe-'))
    chmodSync(tempParent, 0o700)
    workDirectory = tempParent
    const readRecord = database.prepare('SELECT duration_seconds, sample_rate, audio_bytes, transcript, audio_zstd FROM transcript_archive WHERE id = ?')
    const updateTranscript = database.prepare('UPDATE transcript_archive SET transcript = ? WHERE id = ?')
    const speechIds = []
    state.phase = 'vad'
    emitProgress(args.progressPath, state)

    for (let index = 0; index < ids.length; index += 1) {
      await waitForResume(args.pauseFile, state, args.progressPath)
      if (stopRequested) break
      const id = ids[index]
      try {
        const record = readRecord.get(id)
        if (!record) throw new Error('record disappeared from snapshot')
        const wav = zstdDecompressSync(Buffer.from(record.audio_zstd))
        if (!isCanonicalArchiveWav(wav, record)) {
          state.vadErrors += 1
          state.recordErrors += 1
          state.completed += 1
          emitProgress(args.progressPath, state)
          continue
        }
        const wavPath = path.join(workDirectory, `record-${index}.wav`)
        writeFileSync(wavPath, wav, { mode: 0o600 })
        const vad = await runChild(args.vadCommand, [wavPath], VAD_TIMEOUT_MS, MAX_VAD_OUTPUT)
        if (vad.aborted || stopRequested) break
        const segments = vad.ok ? parseVadSegments(vad.output) : undefined
        if (segments === undefined) {
          state.vadErrors += 1
          state.recordErrors += 1
        } else if (segments === 0) {
          state.noSpeech += 1
          if (record.transcript !== '') {
            updateTranscript.run('', id)
            state.transcriptUpdates = (state.transcriptUpdates ?? 0) + 1
          }
        } else {
          state.speechPositive += 1
          speechIds.push(id)
        }
        rmSync(wavPath, { force: true })
      } catch {
        state.vadErrors += 1
        state.recordErrors += 1
      }
      state.completed += 1
      emitProgress(args.progressPath, state)
    }

    if (!stopRequested) {
      state.phase = 'base'
      state.completed = 0
      emitProgress(args.progressPath, state)
      for (let index = 0; index < speechIds.length; index += 1) {
        await waitForResume(args.pauseFile, state, args.progressPath)
        if (stopRequested) break
        const id = speechIds[index]
        const wavPath = path.join(workDirectory, `speech-${index}.wav`)
        try {
          const record = readRecord.get(id)
          if (!record) throw new Error('record disappeared from snapshot')
          const wav = zstdDecompressSync(Buffer.from(record.audio_zstd))
          if (!isCanonicalArchiveWav(wav, record)) {
            throw new Error('audio is invalid for Base transcription')
          }
          writeFileSync(wavPath, wav, { mode: 0o600 })
          const base = await runChild(args.baseCommand, [wavPath, model, '1'], transcriptionTimeoutMs(record.duration_seconds), MAX_BASE_OUTPUT)
          if (base.aborted || stopRequested) break
          if (!base.ok) {
            state.baseErrors += 1
            state.recordErrors += 1
          } else {
            updateTranscript.run(cleanWhisperOutput(base.output), id)
            state.baseCompleted += 1
          }
        } catch {
          state.baseErrors += 1
          state.recordErrors += 1
        } finally {
          rmSync(wavPath, { force: true })
        }
        state.completed += 1
        emitProgress(args.progressPath, state)
      }
    }
    state.phase = stopRequested ? 'cancelled' : state.recordErrors > 0 ? 'complete_with_errors' : 'complete'
    emitProgress(args.progressPath, state)
    process.stdout.write(`${JSON.stringify({ event: 'finished', backupCreated: Boolean(backupPath), ...state, startedAt: undefined })}\n`)
    if (stopRequested) process.exitCode = 130
    else if (state.recordErrors > 0) process.exitCode = 1
  } catch {
    process.stderr.write(`${JSON.stringify({ event: 'fatal', reason: 'archive reprocessing stopped before completion' })}\n`)
    process.exitCode = 1
  } finally {
    if (workDirectory) rmSync(workDirectory, { recursive: true, force: true })
    if (database) database.close()
    process.off('SIGTERM', requestStop)
    process.off('SIGINT', requestStop)
  }
}

await main()
