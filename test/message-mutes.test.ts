import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { MessageMuteStore, messageSimilarity } from '../src/message-mutes'
import { MessageListeningBuffer } from '../src/message-listening'

const announcement = 'This is the harbor patrol with a routine radio check for all vessels in the marina'

test('matches complete repeated messages with small recognition differences', () => {
  assert.equal(messageSimilarity(announcement, announcement.toUpperCase() + '.'), 1)
  assert.ok(messageSimilarity(announcement, announcement.replace('the harbor', 'our harbor')) >= .9)
  assert.ok(messageSimilarity(announcement, announcement.replace('routine radio', 'radio')) >= .9)
  assert.equal(messageSimilarity(announcement, 'This is the harbor patrol requesting urgent assistance outside the marina'), 0)
  assert.equal(messageSimilarity(announcement, `${announcement} we also need assistance for a vessel taking on water`), 0)
  assert.equal(messageSimilarity('', ''), 0)
  assert.equal(messageSimilarity('radio check', 'radio checks'), 0)
  assert.equal(messageSimilarity('Radio check!', 'radio check'), 1)
  assert.equal(messageSimilarity('word '.repeat(501), 'word '.repeat(501)), 0)
})

test('a changed number keeps an otherwise near-identical message audible', () => {
  assert.equal(messageSimilarity(`${announcement} on channel 16`, `${announcement} on channel 12`), 0)
  assert.equal(messageSimilarity(`${announcement} on channel one six`, `${announcement} on channel one two`), 0)
  assert.equal(messageSimilarity(announcement, `${announcement} emergency`), 0)
  assert.equal(messageSimilarity(`${announcement} the bridge will open`, `${announcement} the bridge will not open`), 0)
})

test('mutes are channel-scoped, durable, private, deduplicated and reversible', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'vhf-mutes-'))
  try {
    const filename = path.join(directory, 'mutes.json')
    const store = new MessageMuteStore(filename)
    assert.equal(store.match('16', announcement), undefined)
    const rule = store.add('16', announcement)
    assert.equal(store.match('16', announcement)?.id, rule.id)
    assert.equal(store.match('68', announcement), undefined)
    assert.equal(store.match('16', 'unrelated traffic'), undefined)
    assert.equal(store.add('16', announcement.toUpperCase()).id, rule.id)
    assert.equal(store.list().length, 1)
    assert.equal(statSync(filename).mode & 0o777, 0o600)
    const restarted = new MessageMuteStore(filename)
    assert.equal(restarted.match('16', announcement)?.id, rule.id)
    assert.equal(restarted.remove(rule.id), true)
    assert.equal(restarted.match('16', announcement), undefined)
    assert.equal(restarted.remove(rule.id), false)
    assert.equal(new MessageMuteStore(filename).list().length, 0)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('listening rechecks mutes without altering original or unrecognized audio', () => {
  const mutes = new MessageMuteStore()
  const buffer = new MessageListeningBuffer(mutes)
  const input = { channel: '16', startedAt: new Date().toISOString(), sampleRate: 8_000, transcript: announcement, pcm: Buffer.alloc(16_000, 7) }
  const cursor = buffer.list().cursor
  buffer.add(input)
  buffer.add({ ...input, transcript: '' })
  const rule = mutes.add('16', announcement)
  assert.equal(buffer.list(cursor).messages[0].mute?.id, rule.id)
  assert.equal(buffer.list(cursor).messages[1].mute, null)
  assert.deepEqual(buffer.wav(1)!.subarray(44), input.pcm)
  mutes.remove(rule.id)
  assert.equal(buffer.record(1)?.mute, null)
  assert.equal(buffer.list().messages.length, 0, 'starting a listener does not replay prior traffic')
  assert.notEqual(new MessageListeningBuffer(mutes).session, buffer.session)
})

test('listening bounds memory and signals missing audio instead of silently skipping it', () => {
  const buffer = new MessageListeningBuffer(new MessageMuteStore(), 16)
  const input = { channel: '16', startedAt: new Date().toISOString(), sampleRate: 8_000, transcript: '', pcm: Buffer.alloc(8) }
  buffer.add(input)
  buffer.add(input)
  buffer.add(input)
  assert.equal(buffer.list(0).gap, true)
  assert.equal(buffer.list(1).gap, false)
  assert.deepEqual(buffer.list(1).messages.map((message) => message.id), [2, 3])
  assert.equal(buffer.wav(1), undefined)
  buffer.add({ ...input, pcm: Buffer.alloc(18) })
  assert.equal(buffer.list(3).gap, true)
})
