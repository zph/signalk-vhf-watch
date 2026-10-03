import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import test from 'node:test'

const root = path.resolve(__dirname, '../..')
const main = readFileSync(path.join(root, 'public/main.js'), 'utf8')

function declaration(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `${name} is declared`)
  const open = source.indexOf('{', start)
  let depth = 0
  for (let at = open; at < source.length; at += 1) {
    if (source[at] === '{') depth += 1
    if (source[at] === '}' && --depth === 0) return source.slice(start, at + 1)
  }
  assert.fail(`${name} has a closing brace`)
}

test('a manual timeline clip keeps playing when Slot A retunes', () => {
  const audio = {
    paused: false,
    src: '/clip.wav',
    currentTime: 9,
    pauses: 0,
    loads: 0,
    pause() { this.paused = true; this.pauses += 1 },
    removeAttribute(name: string) { if (name === 'src') this.src = '' },
    load() { this.loads += 1 }
  }
  const state = {
    timelineFollowingLive: false,
    timelineActiveSlotAChannel: 'WX1',
    timelineAwaitingChannel: undefined as string | undefined,
    timelineWaitingAtEdge: false,
    timelineSegmentId: 42 as number | undefined,
    timelineAudio: audio,
    timelineTime: { textContent: '' },
    timelineOffset: { textContent: '' },
    channelDisplay: (channel: string) => channel,
    channelFrequencyDisplay: (channel: string) => `freq ${channel}`
  }
  vm.runInNewContext(`${declaration(main, 'handleTimelineSlotARetune')}; globalThis.run = handleTimelineSlotARetune`, state)

  assert.equal((state as any).run('16'), false)
  assert.equal(audio.paused, false)
  assert.equal(audio.src, '/clip.wav')
  assert.equal(audio.pauses, 0)
  assert.equal(audio.loads, 0)
  assert.equal(audio.currentTime, 9)
  assert.equal(state.timelineSegmentId, 42)
})

test('following live still waits for audio on the newly tuned channel', () => {
  const audio = {
    paused: false,
    src: '/live.wav',
    pauses: 0,
    loads: 0,
    pause() { this.paused = true; this.pauses += 1 },
    removeAttribute(name: string) { if (name === 'src') this.src = '' },
    load() { this.loads += 1 }
  }
  const state = {
    timelineFollowingLive: true,
    timelineActiveSlotAChannel: 'WX1',
    timelineAwaitingChannel: undefined as string | undefined,
    timelineWaitingAtEdge: true,
    timelineSegmentId: 42 as number | undefined,
    timelineAudio: audio,
    timelineTime: { textContent: '' },
    timelineOffset: { textContent: '' },
    channelDisplay: (channel: string) => channel,
    channelFrequencyDisplay: (channel: string) => `freq ${channel}`
  }
  vm.runInNewContext(`${declaration(main, 'handleTimelineSlotARetune')}; globalThis.run = handleTimelineSlotARetune`, state)

  assert.equal((state as any).run('16'), true)
  assert.equal(state.timelineAwaitingChannel, '16')
  assert.equal(state.timelineWaitingAtEdge, false)
  assert.equal(state.timelineSegmentId, undefined)
  assert.equal(audio.paused, true)
  assert.equal(audio.src, '')
  assert.equal(audio.loads, 1)
})

test('archive playback activates once on opening its details', () => {
  const audio = { dataset: {} as Record<string, string>, preload: 'none' }
  const details = { open: false }
  let updates = 0
  const sandbox = { audio, details, updates: () => { updates += 1 } }
  vm.runInNewContext(`${declaration(main, 'activateArchivePlayback')}; globalThis.run = () => activateArchivePlayback(details, audio, updates)`, sandbox)
  assert.equal((sandbox as any).run(), false)
  assert.equal(audio.preload, 'none')
  assert.deepEqual(audio.dataset, {})
  assert.equal(updates, 0)

  details.open = true
  assert.equal((sandbox as any).run(), true)
  assert.equal(audio.preload, 'metadata')
  assert.equal(audio.dataset.archivePlaybackActivated, 'true')
  assert.equal(updates, 1)
  assert.equal((sandbox as any).run(), false)
  assert.equal(updates, 1)
})

test('a transcript link waits for lazy archive metadata before seeking and playing', () => {
  const listeners = new Map<string, () => void>()
  const selectedLine = { classList: { toggle() {} }, id: 'transcript-7' }
  const audio = {
    readyState: 0,
    currentTime: 0,
    duration: 20,
    plays: 0,
    addEventListener(name: string, callback: () => void) { listeners.set(name, callback) },
    play() { this.plays += 1; return Promise.resolve() }
  }
  const details = {
    querySelectorAll: () => [selectedLine],
    querySelector: () => audio
  }
  const sandbox = { details, audio }
  vm.runInNewContext(`${declaration(main, 'selectTranscriptMoment')}; globalThis.seek = selectTranscriptMoment`, sandbox)
  ;(sandbox as any).seek(details, 7, 9, true)
  assert.equal(audio.currentTime, 0)
  assert.equal(audio.plays, 0)
  assert.equal(listeners.has('loadedmetadata'), true)
  listeners.get('loadedmetadata')!()
  assert.equal(audio.currentTime, 9)
  assert.equal(audio.plays, 1)
})

test('the server and browser UI versions are bumped together', () => {
  const api = readFileSync(path.join(root, 'src/api.ts'), 'utf8')
  const html = readFileSync(path.join(root, 'public/index.html'), 'utf8')
  const clientBuild = main.match(/const CLIENT_BUILD = (\d+)/)?.[1]
  const apiVersion = api.match(/const UI_VERSION = (\d+)/)?.[1]
  const cacheVersion = html.match(/main\.js\?v=(\d+)/)?.[1]
  assert.ok(clientBuild)
  assert.equal(apiVersion, clientBuild)
  assert.equal(cacheVersion, clientBuild)
})
