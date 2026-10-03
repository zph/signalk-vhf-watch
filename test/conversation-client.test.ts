import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { runInNewContext } from 'node:vm'
import test from 'node:test'

interface ClipRecord {
  id: number
  channel: string
  startedAt: string
  durationSeconds: number
  activityStartSeconds?: number
  activityEndSeconds?: number
  transcript?: string
}

interface Clip {
  record: ClipRecord
  start: number
  end: number
}

interface ConversationClient {
  clipBounds(record: ClipRecord): { start: number; end: number }
  selectConversation(records: ClipRecord[], channel: string, range: string, now: number): { window: { start: number; end: number }; clips: Clip[] }
  rangeForSelection(records: ClipRecord[], range: string, record: ClipRecord, now: number): string
  ConversationPlayer: new (audio: FakeAudio, callbacks: {
    sourceFor(record: ClipRecord): string
    onCurrent?(record: ClipRecord | null): void
    onStatus?(message: string): void
  }) => {
    play(records: ClipRecord[], startIndex?: number, sequence?: boolean): void
    playFrom(records: ClipRecord[], recordId: number, sequence?: boolean): boolean
    stop(): void
    updateRecords(records: ClipRecord[]): void
  }
}

class FakeAudio {
  listeners = new Map<string, Array<() => void>>()
  currentSrc = ''
  paused = true
  private source = ''
  playCalls: string[] = []
  playResults: Array<Promise<void>> = []

  addEventListener(type: string, listener: () => void): void {
    const listeners = this.listeners.get(type) ?? []
    listeners.push(listener)
    this.listeners.set(type, listeners)
  }

  load(): void {}
  pause(): void { this.paused = true }
  removeAttribute(name: string): void {
    if (name === 'src') {
      this.source = ''
      this.currentSrc = ''
    }
  }

  play(): Promise<void> {
    this.paused = false
    this.playCalls.push(this.source || this.currentSrc)
    return this.playResults.shift() ?? Promise.resolve()
  }

  emit(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener()
  }

  set src(value: string) {
    this.source = value
    this.currentSrc = value
  }
  get src(): string { return this.source }
}

function client(): ConversationClient {
  const root = path.resolve(__dirname, '../..')
  const source = readFileSync(path.join(root, 'public/conversation.js'), 'utf8')
  const context: { window: { VHFConversation?: unknown } } = { window: {} }
  runInNewContext(source, context)
  return context.window.VHFConversation as ConversationClient
}

function record(id: number, channel: string, startedAt: number, transcript: string): ClipRecord {
  return {
    id,
    channel,
    startedAt: new Date(startedAt).toISOString(),
    durationSeconds: 10,
    activityStartSeconds: 2,
    activityEndSeconds: 6,
    transcript
  }
}

test('conversation selection isolates a channel and uses activity times for real gaps', () => {
  const api = client()
  const now = Date.UTC(2026, 9, 2, 18)
  const records = [
    record(4, '16', now - 20_000, 'later call'),
    record(3, '68', now - 24_000, 'other channel'),
    record(2, '16', now - 70_000, 'middle call'),
    record(1, '16', now - 120_000, 'first call')
  ]
  const result = api.selectConversation(records, '16', 'all', now)
  assert.deepEqual(Array.from(result.clips, (clip) => clip.record.id), [1, 2, 4])
  assert.equal(result.clips[0].start, Date.parse(records[3].startedAt) + 2_000)
  assert.equal(result.clips[0].end, Date.parse(records[3].startedAt) + 6_000)
  assert.equal((result.clips[1].start - result.clips[0].end) / 1_000, 46)
  assert.ok(result.window.start < result.clips[0].start)
  assert.ok(result.window.end > result.clips.at(-1)!.end)
})

test('hopping to an older clip expands the range and selected clip starts playback there', () => {
  const api = client()
  const now = Date.UTC(2026, 9, 2, 18)
  const older = record(5, '16', now - 48 * 60 * 60_000, 'older call')
  const newer = record(8, '16', now - 5 * 60_000, 'newer call')
  assert.equal(api.rangeForSelection([older, newer], 'hour', older, now), 'all')
  const { clips } = api.selectConversation([newer, older], '16', 'all', now)
  assert.ok(clips.some((clip) => clip.record.id === older.id), 'hopped-to clip remains visible in all-loaded range')

  const audio = new FakeAudio()
  const player = new api.ConversationPlayer(audio, { sourceFor: (entry) => `/clip/${entry.id}.wav` })
  assert.equal(player.playFrom(clips.map((clip) => clip.record), older.id), true)
  assert.equal(audio.src, '/clip/5.wav')
})

test('conversation playback advances through the selected channel only and stops without wrapping', () => {
  const api = client()
  const audio = new FakeAudio()
  const current: Array<number | null> = []
  const statuses: string[] = []
  const player = new api.ConversationPlayer(audio, {
    sourceFor: (entry) => `/clip/${entry.id}.wav`,
    onCurrent: (entry) => current.push(entry?.id ?? null),
    onStatus: (message) => statuses.push(message)
  })
  const selectedChannel = [
    record(1, '16', Date.UTC(2026, 9, 2, 17), 'first'),
    record(3, '16', Date.UTC(2026, 9, 2, 17, 1), 'second')
  ]
  player.play(selectedChannel, 0, true)
  assert.equal(audio.src, '/clip/1.wav')
  audio.emit('ended')
  assert.equal(audio.src, '/clip/3.wav')
  audio.emit('ended')
  assert.equal(audio.src, '')
  assert.deepEqual(current, [1, 3, null])
  assert.equal(statuses.at(-1), 'Conversation ended.')
})

test('scope changes stop playback, polling retains the active source, and removed clips clear it', () => {
  const api = client()
  const audio = new FakeAudio()
  const current: Array<number | null> = []
  const statuses: string[] = []
  const player = new api.ConversationPlayer(audio, {
    sourceFor: (entry) => `/clip/${entry.id}.wav`,
    onCurrent: (entry) => current.push(entry?.id ?? null),
    onStatus: (message) => statuses.push(message)
  })
  const active = record(1, '16', Date.UTC(2026, 9, 2, 17), 'first')
  const next = record(2, '16', Date.UTC(2026, 9, 2, 17, 1), 'next')
  player.play([active, next], 0, true)
  player.updateRecords([{ ...active }, { ...next }])
  assert.equal(audio.src, '/clip/1.wav', 'archive polling must not reload active audio')
  assert.equal(audio.paused, false)
  player.stop() // Channel, range, or view changes use the same stop boundary.
  audio.emit('ended')
  assert.equal(audio.src, '')
  assert.deepEqual(current, [1])

  player.play([active, next], 0, true)
  player.updateRecords([next])
  assert.equal(audio.src, '')
  assert.equal(current.at(-1), null)
  assert.match(statuses.at(-1)!, /no longer available/)
})

test('missing clips advance at most once per record and report the failures', () => {
  const api = client()
  const audio = new FakeAudio()
  const statuses: string[] = []
  const player = new api.ConversationPlayer(audio, {
    sourceFor: (entry) => `/clip/${entry.id}.wav`,
    onStatus: (message) => statuses.push(message)
  })
  player.play([record(1, '16', 1_790_000_000_000, 'missing'), record(2, '16', 1_790_000_001_000, 'missing')], 0, true)
  audio.emit('error')
  assert.equal(audio.src, '/clip/2.wav')
  audio.emit('error')
  assert.equal(audio.src, '')
  assert.equal(statuses.at(-1), '2 clips unavailable; conversation ended.')
  audio.emit('error')
  assert.equal(statuses.at(-1), '2 clips unavailable; conversation ended.')
})

test('a stale play rejection from a missing clip cannot stop the next conversation clip', async () => {
  const api = client()
  const audio = new FakeAudio()
  const player = new api.ConversationPlayer(audio, { sourceFor: (entry) => `/clip/${entry.id}.wav` })
  audio.playResults.push(Promise.reject(new Error('clip missing')), Promise.resolve())
  player.play([record(1, '16', 1_790_000_000_000, 'missing'), record(2, '16', 1_790_000_001_000, 'next')], 0, true)
  audio.emit('error')
  await Promise.resolve()
  assert.equal(audio.src, '/clip/2.wav')
  assert.equal(audio.paused, false)
})
