import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { runInNewContext } from 'node:vm'
import test from 'node:test'

function fixture() {
  const handlers: Record<string, () => void> = {}
  const audio = {
    src: '', currentSrc: '', paused: true, plays: [] as string[],
    addEventListener(name: string, callback: () => void) { handlers[name] = callback },
    load() { this.currentSrc = this.src },
    pause() { this.paused = true },
    removeAttribute() { this.src = ''; this.currentSrc = '' },
    play() { this.plays.push(this.src); this.paused = false; return Promise.resolve() }
  }
  const context = { window: {} as any, setInterval: () => 1, clearInterval: () => undefined }
  runInNewContext(readFileSync(path.resolve(__dirname, '../../public/message-listening.js'), 'utf8'), context)
  let feed = { session: 'test', cursor: 0, gap: false, enabled: true, messages: [] as any[] }
  const records = new Map<number, any>()
  const statuses: string[] = []
  let request = async (url: string): Promise<any> => url.includes('/status')
    ? records.get(Number(url.split('/')[1])) : feed
  const player = new context.window.VHFMessageListener(audio, {
    request: (url: string) => request(url), sourceFor: (record: any) => `/audio/${record.id}.wav`,
    onStatus: (message: string) => statuses.push(message)
  })
  const record = (id: number, mute: any = null) => ({ id, channel: '16', startedAt: new Date().toISOString(), transcript: 'test message', mute })
  return { player, audio, handlers, records, record, statuses,
    setFeed(value: Partial<typeof feed>) { feed = { ...feed, ...value } },
    setRequest(value: typeof request) { request = value } }
}

test('delayed listening skips matching messages, plays unknown audio and rechecks queued mutes', async () => {
  const f = fixture()
  await f.player.start()
  f.records.set(1, f.record(1, { id: 'mute' }))
  f.records.set(2, { ...f.record(2), transcript: '' })
  f.records.set(3, f.record(3))
  f.setFeed({ cursor: 3, messages: [f.record(1), f.record(2), f.record(3)] })
  await f.player.poll()
  assert.deepEqual(f.audio.plays, ['/audio/2.wav'])
  assert.match(f.statuses.at(-1)!, /not recognized; playing original/)
  f.records.set(3, f.record(3, { id: 'new mute' }))
  f.handlers.ended()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(f.audio.plays, ['/audio/2.wav'])
  assert.equal(f.player.skipped, 2)
})

test('adding a mute stops an already playing matching message', async () => {
  const f = fixture()
  await f.player.start()
  f.records.set(1, f.record(1))
  f.setFeed({ cursor: 1, messages: [f.record(1)] })
  await f.player.poll()
  assert.equal(f.audio.paused, false)
  f.records.set(1, f.record(1, { id: 'new mute' }))
  f.setFeed({ messages: [] })
  await f.player.poll()
  assert.equal(f.audio.paused, true)
  assert.equal(f.player.skipped, 1)
})

test('stopping during a pending request prevents late playback', async () => {
  const f = fixture()
  await f.player.start()
  let release!: (value: unknown) => void
  f.setRequest(() => new Promise((resolve) => { release = resolve }))
  const pending = f.player.poll()
  f.player.stop()
  release({ session: 'test', cursor: 1, enabled: true, messages: [f.record(1)] })
  await pending
  assert.deepEqual(f.audio.plays, [])
  assert.equal(f.player.active, false)
})

test('a mute saved between metadata and the audio request skips that clip without ending listening', async () => {
  const f = fixture()
  await f.player.start()
  f.records.set(1, f.record(1))
  f.setFeed({ cursor: 1, messages: [f.record(1)] })
  await f.player.poll()
  f.records.set(1, f.record(1, { id: 'new mute' }))
  await f.player.audioError()
  assert.equal(f.player.active, true)
  assert.equal(f.player.skipped, 1)
  assert.equal(f.audio.paused, true)
})

test('disabling transcription, restarting or losing retained audio stops with a clear status', async () => {
  for (const feed of [{ enabled: false }, { session: 'restarted' }, { gap: true }]) {
    const f = fixture()
    await f.player.start()
    f.setFeed(feed)
    await f.player.poll()
    assert.equal(f.player.active, false)
    assert.match(f.statuses.at(-1)!, /stopped|restarted|fell behind/)
  }
  const f = fixture()
  f.setFeed({ enabled: false })
  await f.player.start()
  assert.equal(f.player.active, false)
  assert.match(f.statuses.at(-1)!, /Enable transcription/)
})
