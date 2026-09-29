#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { TranscriptArchive } = require('../dist/transcript-archive.js')
const { cleanWhisperOutput, transcriptionTimeoutMs } = require('../dist/transcription.js')

const [databasePath, command = '/usr/bin/vhf-whisper'] = process.argv.slice(2)
if (!databasePath) {
  console.error('usage: retranscribe-archive.mjs /path/to/transcripts.sqlite3 [/path/to/vhf-whisper]')
  process.exit(2)
}

const work = mkdtempSync(path.join(os.tmpdir(), 'vhf-retranscribe-'))
const archive = new TranscriptArchive(databasePath)
let rebuilt = 0
try {
  for (const record of archive.list(2_000).reverse()) {
    const wav = archive.wav(record.id)
    if (!wav) continue
    const wavPath = path.join(work, `${record.id}.wav`)
    writeFileSync(wavPath, wav, { mode: 0o600 })
    const output = execFileSync(command, [wavPath], {
      encoding: 'utf8',
      timeout: transcriptionTimeoutMs(record.durationSeconds),
      stdio: ['ignore', 'pipe', 'inherit']
    })
    const transcript = cleanWhisperOutput(output)
    archive.updateTranscript(record.id, transcript)
    rebuilt += 1
    process.stdout.write(`${record.id}\t${record.channel}\t${record.durationSeconds.toFixed(1)}s\t${transcript}\n`)
  }
} finally {
  archive.close()
  rmSync(work, { recursive: true, force: true })
}
process.stderr.write(`Rebuilt ${rebuilt} archived transcript${rebuilt === 1 ? '' : 's'}.\n`)
