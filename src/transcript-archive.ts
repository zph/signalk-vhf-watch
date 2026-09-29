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
  transcript: string
  audioBytes: number
  compressedBytes: number
}

export interface TranscriptArchiveStatus {
  records: number
  compressedBytes: number
  databaseBytes: number
  maxBytes: number
  retentionDays: number
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
  transcript: string
  audio_bytes: number
  compressed_bytes: number
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
        minimum_discriminator_noise, transcript, audio_zstd, audio_bytes,
        compressed_bytes, created_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      startedMs,
      endedMs,
      record.channel,
      record.durationSeconds,
      record.sampleRate,
      record.minimumDiscriminatorNoise ?? null,
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
             minimum_discriminator_noise, transcript, audio_bytes, compressed_bytes
      FROM transcript_archive
      ORDER BY started_ms DESC, id DESC
      LIMIT ?
    `).all(Math.min(2_000, Math.max(1, Math.floor(limit)))) as unknown as ArchiveRow[]
    return rows.map((row) => this.#summary(row))
  }

  record(id: number): TranscriptArchiveRecord | undefined {
    const row = this.#database.prepare(`
      SELECT id, started_ms, ended_ms, channel, duration_seconds, sample_rate,
             minimum_discriminator_noise, transcript, audio_bytes, compressed_bytes
      FROM transcript_archive WHERE id = ?
    `).get(id) as unknown as ArchiveRow | undefined
    return row ? this.#summary(row) : undefined
  }

  wav(id: number): Buffer | undefined {
    const row = this.#database.prepare('SELECT audio_zstd FROM transcript_archive WHERE id = ?').get(id) as unknown as { audio_zstd: Uint8Array } | undefined
    return row ? zstdDecompressSync(row.audio_zstd) : undefined
  }

  status(): TranscriptArchiveStatus {
    const row = this.#database.prepare(`
      SELECT COUNT(*) AS records, COALESCE(SUM(compressed_bytes), 0) AS compressed_bytes
      FROM transcript_archive
    `).get() as unknown as { records: number; compressed_bytes: number }
    return {
      records: row.records,
      compressedBytes: row.compressed_bytes,
      databaseBytes: this.#databaseBytes(),
      maxBytes: this.#maxBytes,
      retentionDays: this.#retentionDays
    }
  }

  prune(now = Date.now()): void {
    this.#database.prepare('DELETE FROM transcript_archive WHERE started_ms < ?').run(now - this.#retentionMs)
    const total = (): number => (this.#database.prepare(
      'SELECT COALESCE(SUM(compressed_bytes), 0) AS bytes FROM transcript_archive'
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
      transcript: row.transcript,
      audioBytes: row.audio_bytes,
      compressedBytes: row.compressed_bytes
    }
  }

  #databaseBytes(): number {
    const pages = this.#database.prepare('PRAGMA page_count').get() as unknown as { page_count: number }
    const pageSize = this.#database.prepare('PRAGMA page_size').get() as unknown as { page_size: number }
    return pages.page_count * pageSize.page_size
  }
}
