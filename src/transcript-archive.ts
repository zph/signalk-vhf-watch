import { chmodSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'

export const DEFAULT_ARCHIVE_RETENTION_DAYS = 30
export const DEFAULT_ARCHIVE_MAX_BYTES = 100 * 1024 * 1024

export interface TranscriptArchiveRecordInput {
  startedAt: string
  endedAt: string
  channel: string
  durationSeconds: number
  sampleRate: number
  minimumDiscriminatorNoise?: number
  activityStartSeconds?: number
  activityEndSeconds?: number
  transcript: string
  wav: Buffer
}

export interface TranscriptArchiveRecord {
  id: number
  startedAt: string
  endedAt: string
  channel: string
  durationSeconds: number
  sampleRate: number
  minimumDiscriminatorNoise?: number
  activityStartSeconds?: number
  activityEndSeconds?: number
  transcript: string
  audioBytes: number
  compressedBytes: number
  narrationBytes: number
  narrationVoice?: string
  narrationError?: string
}

export interface TranscriptArchiveStatus {
  records: number
  compressedBytes: number
  databaseBytes: number
  maxBytes: number
  retentionDays: number
  narrationBytes: number
  narratedRecords: number
}

interface ArchiveOptions {
  retentionDays?: number
  maxBytes?: number
}

interface ArchiveRow {
  id: number
  started_ms: number
  ended_ms: number
  channel: string
  duration_seconds: number
  sample_rate: number
  minimum_discriminator_noise: number | null
  activity_start_seconds: number | null
  activity_end_seconds: number | null
  transcript: string
  audio_bytes: number
  compressed_bytes: number
  narration_bytes: number
  narration_voice: string | null
  narration_error: string | null
}

export class TranscriptArchive {
  readonly #database: DatabaseSync
  readonly #retentionMs: number
  readonly #retentionDays: number
  readonly #maxBytes: number

  constructor(databasePath: string, options: ArchiveOptions = {}) {
    this.#retentionDays = options.retentionDays ?? DEFAULT_ARCHIVE_RETENTION_DAYS
    this.#retentionMs = this.#retentionDays * 24 * 60 * 60 * 1_000
    this.#maxBytes = options.maxBytes ?? DEFAULT_ARCHIVE_MAX_BYTES
    mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 })
    this.#database = new DatabaseSync(databasePath)
    chmodSync(databasePath, 0o600)
    this.#database.exec(`
      PRAGMA auto_vacuum = INCREMENTAL;
      PRAGMA journal_mode = DELETE;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS transcript_archive (
        id INTEGER PRIMARY KEY,
        started_ms INTEGER NOT NULL,
        ended_ms INTEGER NOT NULL,
        channel TEXT NOT NULL,
        duration_seconds REAL NOT NULL,
        sample_rate INTEGER NOT NULL,
        minimum_discriminator_noise REAL,
        transcript TEXT NOT NULL,
        audio_zstd BLOB NOT NULL,
        audio_bytes INTEGER NOT NULL,
        compressed_bytes INTEGER NOT NULL,
        created_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS transcript_archive_started ON transcript_archive(started_ms);
    `)
    const columns = new Set((this.#database.prepare('PRAGMA table_info(transcript_archive)').all() as unknown as { name: string }[]).map((column) => column.name))
    if (!columns.has('narration_opus')) this.#database.exec('ALTER TABLE transcript_archive ADD COLUMN narration_opus BLOB')
    if (!columns.has('narration_bytes')) this.#database.exec('ALTER TABLE transcript_archive ADD COLUMN narration_bytes INTEGER NOT NULL DEFAULT 0')
    if (!columns.has('narration_voice')) this.#database.exec('ALTER TABLE transcript_archive ADD COLUMN narration_voice TEXT')
    if (!columns.has('narration_error')) this.#database.exec('ALTER TABLE transcript_archive ADD COLUMN narration_error TEXT')
    if (!columns.has('activity_start_seconds')) this.#database.exec('ALTER TABLE transcript_archive ADD COLUMN activity_start_seconds REAL')
    if (!columns.has('activity_end_seconds')) this.#database.exec('ALTER TABLE transcript_archive ADD COLUMN activity_end_seconds REAL')
    this.prune()
  }

  add(record: TranscriptArchiveRecordInput, now = Date.now()): TranscriptArchiveRecord | undefined {
    const startedMs = Date.parse(record.startedAt)
    const endedMs = Date.parse(record.endedAt)
    if (!Number.isFinite(startedMs) || !Number.isFinite(endedMs)) throw new Error('Archive record has an invalid timestamp')
    const compressed = zstdCompressSync(record.wav)
    if (compressed.length > this.#maxBytes) return undefined
    const result = this.#database.prepare(`
      INSERT INTO transcript_archive (
        started_ms, ended_ms, channel, duration_seconds, sample_rate,
        minimum_discriminator_noise, activity_start_seconds, activity_end_seconds,
        transcript, audio_zstd, audio_bytes, compressed_bytes, created_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      startedMs,
      endedMs,
      record.channel,
      record.durationSeconds,
      record.sampleRate,
      record.minimumDiscriminatorNoise ?? null,
      record.activityStartSeconds ?? null,
      record.activityEndSeconds ?? null,
      record.transcript,
      compressed,
      record.wav.length,
      compressed.length,
      now
    )
    this.prune(now)
    return this.record(Number(result.lastInsertRowid))
  }

  list(limit = 500): TranscriptArchiveRecord[] {
    const rows = this.#database.prepare(`
      SELECT id, started_ms, ended_ms, channel, duration_seconds, sample_rate,
             minimum_discriminator_noise, activity_start_seconds, activity_end_seconds,
             transcript, audio_bytes, compressed_bytes,
             narration_bytes, narration_voice, narration_error
      FROM transcript_archive
      ORDER BY started_ms DESC, id DESC
      LIMIT ?
    `).all(Math.min(2_000, Math.max(1, Math.floor(limit)))) as unknown as ArchiveRow[]
    return rows.map((row) => this.#summary(row))
  }

  record(id: number): TranscriptArchiveRecord | undefined {
    const row = this.#database.prepare(`
      SELECT id, started_ms, ended_ms, channel, duration_seconds, sample_rate,
             minimum_discriminator_noise, activity_start_seconds, activity_end_seconds,
             transcript, audio_bytes, compressed_bytes,
             narration_bytes, narration_voice, narration_error
      FROM transcript_archive WHERE id = ?
    `).get(id) as unknown as ArchiveRow | undefined
    return row ? this.#summary(row) : undefined
  }

  wav(id: number): Buffer | undefined {
    const row = this.#database.prepare('SELECT audio_zstd FROM transcript_archive WHERE id = ?').get(id) as unknown as { audio_zstd: Uint8Array } | undefined
    return row ? zstdDecompressSync(row.audio_zstd) : undefined
  }

  updateTranscript(id: number, transcript: string): TranscriptArchiveRecord | undefined {
    const result = this.#database.prepare(
      `UPDATE transcript_archive
       SET transcript = ?, narration_opus = NULL, narration_bytes = 0,
           narration_voice = NULL, narration_error = NULL
       WHERE id = ?`
    ).run(transcript, id)
    return Number(result.changes) === 0 ? undefined : this.record(id)
  }

  narrationOpus(id: number): Buffer | undefined {
    const row = this.#database.prepare('SELECT narration_opus FROM transcript_archive WHERE id = ?').get(id) as unknown as { narration_opus: Uint8Array | null } | undefined
    return row?.narration_opus ? Buffer.from(row.narration_opus) : undefined
  }

  setNarration(id: number, opus: Buffer, voice: string): TranscriptArchiveRecord | undefined {
    const result = this.#database.prepare(`
      UPDATE transcript_archive
      SET narration_opus = ?, narration_bytes = ?, narration_voice = ?, narration_error = NULL
      WHERE id = ?
    `).run(opus, opus.length, voice, id)
    if (Number(result.changes) === 0) return undefined
    this.prune()
    return this.record(id)
  }

  setNarrationError(id: number, error: string): TranscriptArchiveRecord | undefined {
    const result = this.#database.prepare(`
      UPDATE transcript_archive
      SET narration_opus = NULL, narration_bytes = 0, narration_voice = NULL, narration_error = ?
      WHERE id = ?
    `).run(error.slice(0, 1_000), id)
    return Number(result.changes) === 0 ? undefined : this.record(id)
  }

  recordsNeedingNarration(limit = 500): TranscriptArchiveRecord[] {
    const rows = this.#database.prepare(`
      SELECT id, started_ms, ended_ms, channel, duration_seconds, sample_rate,
             minimum_discriminator_noise, activity_start_seconds, activity_end_seconds,
             transcript, audio_bytes, compressed_bytes,
             narration_bytes, narration_voice, narration_error
      FROM transcript_archive
      WHERE transcript <> '' AND narration_opus IS NULL AND narration_error IS NULL
      ORDER BY started_ms DESC, id DESC
      LIMIT ?
    `).all(Math.min(2_000, Math.max(1, Math.floor(limit)))) as unknown as ArchiveRow[]
    return rows.map((row) => this.#summary(row))
  }

  status(): TranscriptArchiveStatus {
    const row = this.#database.prepare(`
      SELECT COUNT(*) AS records, COALESCE(SUM(compressed_bytes), 0) AS compressed_bytes,
             COALESCE(SUM(narration_bytes), 0) AS narration_bytes,
             COALESCE(SUM(CASE WHEN narration_bytes > 0 THEN 1 ELSE 0 END), 0) AS narrated_records
      FROM transcript_archive
    `).get() as unknown as { records: number; compressed_bytes: number; narration_bytes: number; narrated_records: number }
    return {
      records: row.records,
      compressedBytes: row.compressed_bytes,
      databaseBytes: this.#databaseBytes(),
      maxBytes: this.#maxBytes,
      retentionDays: this.#retentionDays,
      narrationBytes: row.narration_bytes,
      narratedRecords: row.narrated_records
    }
  }

  prune(now = Date.now()): void {
    this.#database.prepare('DELETE FROM transcript_archive WHERE started_ms < ?').run(now - this.#retentionMs)
    const total = (): number => (this.#database.prepare(
      'SELECT COALESCE(SUM(compressed_bytes + narration_bytes), 0) AS bytes FROM transcript_archive'
    ).get() as unknown as { bytes: number }).bytes
    while (total() > this.#maxBytes || this.#databaseBytes() > this.#maxBytes) {
      const removed = this.#database.prepare(`
        DELETE FROM transcript_archive WHERE id IN (
          SELECT id FROM transcript_archive ORDER BY started_ms ASC, id ASC LIMIT 1
        )
      `).run()
      if (Number(removed.changes) === 0) break
      this.#database.exec('PRAGMA incremental_vacuum')
    }
  }

  close(): void {
    this.#database.close()
  }

  #summary(row: ArchiveRow): TranscriptArchiveRecord {
    return {
      id: row.id,
      startedAt: new Date(row.started_ms).toISOString(),
      endedAt: new Date(row.ended_ms).toISOString(),
      channel: row.channel,
      durationSeconds: row.duration_seconds,
      sampleRate: row.sample_rate,
      ...(row.minimum_discriminator_noise === null ? {} : { minimumDiscriminatorNoise: row.minimum_discriminator_noise }),
      ...(row.activity_start_seconds === null ? {} : { activityStartSeconds: row.activity_start_seconds }),
      ...(row.activity_end_seconds === null ? {} : { activityEndSeconds: row.activity_end_seconds }),
      transcript: row.transcript,
      audioBytes: row.audio_bytes,
      compressedBytes: row.compressed_bytes,
      narrationBytes: row.narration_bytes,
      ...(row.narration_voice === null ? {} : { narrationVoice: row.narration_voice }),
      ...(row.narration_error === null ? {} : { narrationError: row.narration_error })
    }
  }

  #databaseBytes(): number {
    const pages = this.#database.prepare('PRAGMA page_count').get() as unknown as { page_count: number }
    const pageSize = this.#database.prepare('PRAGMA page_size').get() as unknown as { page_size: number }
    return pages.page_count * pageSize.page_size
  }
}
