import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const [databasePath, sidecarPath, ...requestedIds] = process.argv.slice(2)
if (!databasePath || !sidecarPath || requestedIds.length === 0) {
  process.stderr.write('Usage: node eval-whisper.mjs ARCHIVE_DB GO_SIDECAR ID [ID ...]\n')
  process.exit(2)
}

const outputDir = mkdtempSync(path.join(tmpdir(), 'vhf-go-eval-'))
chmodSync(outputDir, 0o700)
const database = new DatabaseSync(databasePath, { readOnly: true })
const select = database.prepare('SELECT id, channel, sample_rate, minimum_discriminator_noise, transcript, audio_zstd FROM transcript_archive WHERE id = ?')
const results = []

function run(command, args, input, timeout = 180_000) {
  const result = spawnSync(command, args, { input, timeout, maxBuffer: 24 * 1024 * 1024 })
  if (result.error || result.status !== 0) {
    throw new Error(`${command} failed: ${result.error?.message ?? result.stderr?.toString().slice(-1000)}`)
  }
  return result.stdout
}

function transcriptFrom(output) {
  return [...output.matchAll(/^\[[^\]]+-->[^\]]+\]\s*(.*)$/gm)]
    .map((match) => match[1].trim())
    .filter(Boolean)
    .join(' ')
}

for (const requestedId of requestedIds) {
  const id = Number(requestedId)
  const record = select.get(id)
  if (!record) throw new Error(`Archive record ${requestedId} not found`)
  const rawWav = zstdDecompressSync(record.audio_zstd)
  if (rawWav.toString('ascii', 0, 4) !== 'RIFF' || rawWav.toString('ascii', 8, 12) !== 'WAVE' || rawWav.toString('ascii', 36, 40) !== 'data') {
    throw new Error(`Archive record ${id} is not a canonical WAV`)
  }
  const sampleRate = rawWav.readUInt32LE(24)
  if (sampleRate !== record.sample_rate || rawWav.readUInt16LE(22) !== 1 || rawWav.readUInt16LE(34) !== 16) {
    throw new Error(`Archive record ${id} has an unsupported PCM format`)
  }
  const pcm = rawWav.subarray(44)
  const payload = Buffer.allocUnsafe(8 + pcm.length)
  payload.writeDoubleLE(record.minimum_discriminator_noise ?? 0.05, 0)
  pcm.copy(payload, 8)
  const framed = Buffer.allocUnsafe(5 + payload.length)
  framed.writeUInt8(1, 0)
  framed.writeUInt32LE(payload.length, 1)
  payload.copy(framed, 5)
  const filteredFrame = run(sidecarPath, ['--audio-rate', String(sampleRate), '--squelch', '0', '--hiss', 'adaptive'], framed, 30_000)
  if (filteredFrame.length !== framed.length || filteredFrame.readUInt8(0) !== 1 || filteredFrame.readUInt32LE(1) !== payload.length) {
    throw new Error(`Go sidecar returned an invalid frame for ${id}`)
  }
  const size = 2 ** Math.ceil(Math.log2(sampleRate * 0.032))
  const latencyBytes = (size - 1) * 2
  const filteredWav = Buffer.from(rawWav)
  filteredFrame.copy(filteredWav, 44, 13 + latencyBytes, filteredFrame.length)
  filteredWav.fill(0, filteredWav.length - latencyBytes)
  const rawPath = path.join(outputDir, `${id}-raw.wav`)
  const filteredPath = path.join(outputDir, `${id}-filtered.wav`)
  writeFileSync(rawPath, rawWav, { mode: 0o600 })
  writeFileSync(filteredPath, filteredWav, { mode: 0o600 })
  const rawOutput = run('/usr/bin/nice', ['-n', '15', '/usr/bin/vhf-whisper', rawPath, 'base.en-q5_1', '2']).toString('utf8')
  const filteredOutput = run('/usr/bin/nice', ['-n', '15', '/usr/bin/vhf-whisper', filteredPath, 'base.en-q5_1', '2']).toString('utf8')
  writeFileSync(path.join(outputDir, `${id}-raw.txt`), rawOutput, { mode: 0o600 })
  writeFileSync(path.join(outputDir, `${id}-filtered.txt`), filteredOutput, { mode: 0o600 })
  results.push({
    id,
    channel: record.channel,
    sampleRate,
    discriminatorNoise: record.minimum_discriminator_noise,
    archiveTranscript: record.transcript,
    rawTranscript: transcriptFrom(rawOutput),
    filteredTranscript: transcriptFrom(filteredOutput)
  })
  process.stderr.write(`Completed ${id}\n`)
}

writeFileSync(path.join(outputDir, 'results.json'), JSON.stringify(results, null, 2), { mode: 0o600 })
process.stdout.write(`${outputDir}\n`)
