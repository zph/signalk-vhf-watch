import assert from 'node:assert/strict'
import test from 'node:test'
import type { PluginRouter } from '@signalk/server-api'
import { registerRoutes } from '../src/api'
import { MessageMuteStore } from '../src/message-mutes'
import { MessageListeningBuffer } from '../src/message-listening'

function fixture() {
  const routes = new Map<string, { access: string; handler: (req: any, res: any) => any }>()
  const router = { access: (access: string) => Object.fromEntries(['get', 'post', 'delete'].map((method) => [method,
    (url: string, handler: any) => routes.set(`${method} ${url}`, { access, handler })])) } as unknown as PluginRouter
  const messageMutes = new MessageMuteStore()
  const listening = new MessageListeningBuffer(messageMutes)
  const record = { id: 7, channel: '16', transcript: 'This is a routine harbor radio check for all vessels in the marina' }
  const runtime = { transcription: { messageMutes, listening, archiveRecord: (id: number) => id === 7 ? record : undefined,
    status: () => ({ enabled: true, available: true }), archiveRecords: () => [record] } }
  registerRoutes(router, () => runtime as any)
  const call = async (method: string, path: string, request: any = {}) => {
    const route = routes.get(`${method} ${path}`)!
    assert.ok(route)
    const res = { code: 200, body: undefined as any, headers: {} as Record<string, string>,
      status(code: number) { this.code = code; return this },
      set(key: any, value?: string) { if (typeof key === 'string') this.headers[key] = value!; else Object.assign(this.headers, key); return this },
      json(body: any) { this.body = body; return this }, send(body: any) { this.body = body; return this }, end() { return this } }
    await route.handler({ query: { session: listening.session }, params: {}, headers: {}, ...request }, res)
    return { ...res, access: route.access }
  }
  return { call, record, messageMutes, listening }
}

test('mute API requires write access, validates sources, and annotates transcripts without editing them', async () => {
  const f = fixture()
  assert.equal((await f.call('post', '/api/message-mutes', { body: { transcriptId: '7' } })).code, 400)
  assert.equal((await f.call('post', '/api/message-mutes', { body: { transcriptId: 99 } })).code, 404)
  const created = await f.call('post', '/api/message-mutes', { body: { transcriptId: 7 } })
  assert.equal(created.code, 201)
  assert.equal(created.access, 'readwrite')
  const transcripts = await f.call('get', '/api/transcripts')
  assert.equal(transcripts.body.records[0].mute.id, created.body.rule.id)
  assert.equal((f.record as any).mute, undefined)
  const removed = await f.call('delete', '/api/message-mutes/:id', { params: { id: created.body.rule.id } })
  assert.equal(removed.access, 'readwrite')
  assert.equal(removed.code, 204)
  assert.equal((await f.call('get', '/api/message-mutes')).body.rules.length, 0)
})

test('listening checks the current mute at audio request time and preserves seekable unmuted WAVs', async () => {
  const f = fixture()
  f.listening.add({ ...f.record, sampleRate: 8_000, startedAt: new Date().toISOString(), pcm: Buffer.alloc(8_000) })
  const wav = await f.call('get', '/api/message-listen/:id.wav', { params: { id: 1 } })
  assert.equal(wav.code, 200)
  assert.equal(wav.body.subarray(0, 4).toString(), 'RIFF')
  assert.equal(wav.headers['Cache-Control'], 'no-store, private')
  const mute = f.messageMutes.add('16', f.record.transcript)
  assert.equal((await f.call('get', '/api/message-listen/:id.wav', { params: { id: 1 } })).code, 409)
  f.messageMutes.remove(mute.id)
  const ranged = await f.call('get', '/api/message-listen/:id.wav', { params: { id: 1 }, headers: { range: 'bytes=44-99' } })
  assert.equal(ranged.code, 206)
  assert.equal(ranged.body.length, 56)
  assert.equal((await f.call('get', '/api/message-listen', { query: { after: '-1' } })).code, 400)
  assert.equal((await f.call('get', '/api/message-listen/:id.wav', { params: { id: 1 }, query: { session: 'previous-server' } })).code, 409)
})
