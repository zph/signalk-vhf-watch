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

test('expanding an archive leaves playback unrequested until its play button is clicked', () => {
  const archiveRow = declaration(main, 'archiveRow')
  assert.match(archiveRow, /audio\.preload = 'none'/)
  assert.match(archiveRow, /bindArchivePlaybackButton\(playButton, details, audio, updatePlayback/)
  assert.doesNotMatch(archiveRow, /audio\.src\s*=/)

  const listeners = new Map<string, () => void>()
  const audio = {
    dataset: {} as Record<string, string>,
    preload: 'none',
    src: '',
    loads: 0,
    plays: 0,
    play() { this.plays += 1; return Promise.resolve() },
    load() { this.loads += 1 }
  }
  const details = { open: false }
  let updates = 0
  let waveforms = 0
  const button = { addEventListener(name: string, callback: () => void) { listeners.set(name, callback) } }
  const updatePlayback = () => {
    updates += 1
    audio.src = '/archive.wav?cleanup=modified'
    audio.load()
  }
  const sandbox = { audio, details, button, updatePlayback, loadWaveform: () => { waveforms += 1 } }
  vm.runInNewContext(`${declaration(main, 'activateArchivePlayback')}; ${declaration(main, 'beginArchivePlayback')}; ${declaration(main, 'bindArchivePlaybackButton')}; bindArchivePlaybackButton(button, details, audio, updatePlayback, loadWaveform)`, sandbox)
  assert.equal(listeners.has('click'), true)
  assert.equal(audio.preload, 'none')
  assert.equal(audio.src, '')
  assert.equal(audio.loads, 0)
  assert.equal(audio.plays, 0)
  assert.deepEqual(audio.dataset, {})
  assert.equal(updates, 0)
  assert.equal(waveforms, 0)

  details.open = true
  listeners.get('click')!()
  assert.equal(audio.preload, 'metadata')
  assert.equal(audio.src, '/archive.wav?cleanup=modified')
  assert.equal(audio.loads, 1)
  assert.equal(audio.plays, 1)
  assert.equal(audio.dataset.archivePlaybackActivated, 'true')
  assert.equal(updates, 1)
  assert.equal(waveforms, 1)
  listeners.get('click')!()
  assert.equal(audio.plays, 2)
  assert.equal(updates, 1)
  assert.equal(waveforms, 1)
})

test('a transcript link activates archive playback, then seeks and plays after metadata', () => {
  const listeners = new Map<string, () => void>()
  const selectedLine = { classList: { toggle() {} }, id: 'transcript-7' }
  const audio = {
    dataset: {} as Record<string, string>,
    preload: 'none',
    src: '',
    loads: 0,
    readyState: 0,
    currentTime: 0,
    duration: 20,
    plays: 0,
    addEventListener(name: string, callback: () => void) { listeners.set(name, callback) },
    load() { this.loads += 1 },
    play() { this.plays += 1; return Promise.resolve() }
  }
  const details = {
    open: false,
    querySelectorAll: () => [selectedLine],
    querySelector: () => audio
  }
  const linkListeners = new Map<string, (event: { preventDefault(): void }) => void>()
  const link = { hash: '#transcript-7', addEventListener(name: string, callback: (event: { preventDefault(): void }) => void) { linkListeners.set(name, callback) } }
  const sandbox = {
    details,
    audio,
    link,
    window: { history: { pushState() {} } },
    document: { getElementById: () => ({ scrollIntoView() {} }) },
    updatePlayback: () => {
      audio.src = '/archive.wav?cleanup=modified'
      audio.load()
    }
  }
  vm.runInNewContext(`${declaration(main, 'transcriptMomentId')}; ${declaration(main, 'selectTranscriptMoment')}; ${declaration(main, 'activateArchivePlayback')}; ${declaration(main, 'bindTranscriptMoment')}; bindTranscriptMoment(link, details, { id: 7 }, 9, updatePlayback)`, sandbox)
  linkListeners.get('click')!({ preventDefault() {} })
  assert.equal(details.open, true)
  assert.equal(audio.dataset.archivePlaybackActivated, 'true')
  assert.equal(audio.src, '/archive.wav?cleanup=modified')
  assert.equal(audio.loads, 1)
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
