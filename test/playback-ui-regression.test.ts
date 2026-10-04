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

test('historical playback remains independent from Slot A retunes', () => {
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
    timelineActiveSlotAChannel: 'WX1',
    liveListening: false,
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

test('live listening stops on Slot A retune', () => {
  let stoppedWith = ''
  let liveListening = true
  const state = {
    liveListening,
    timelineActiveSlotAChannel: 'WX1',
    stopLiveListening(message: string) { stoppedWith = message; liveListening = false },
    channelDisplay: (channel: string) => channel,
  }
  vm.runInNewContext(`${declaration(main, 'handleTimelineSlotARetune')}; globalThis.run = handleTimelineSlotARetune`, state)

  assert.equal((state as any).run('16'), false)
  assert.equal(liveListening, false)
  assert.match(stoppedWith, /changed to 16/)
})

test('historical queue combines channels and sorts equal timestamps deterministically', () => {
  const state = {}
  vm.runInNewContext(`${declaration(main, 'sortHistoricalReplaySegments')}; ${declaration(main, 'historicalReplayQueue')}; globalThis.queue = historicalReplayQueue`, state)
  const segments = [
    { id: 9, startedAt: '2026-10-03T12:00:00Z', slot: 'B', channel: '70' },
    { id: 3, startedAt: '2026-10-03T11:59:00Z', slot: 'A', channel: '16' },
    { id: 7, startedAt: '2026-10-03T12:00:00Z', slot: 'A', channel: 'WX4' },
    { id: 10, startedAt: '2026-10-03T12:00:00Z', slot: 'B', channel: 'WX4' }
  ]
  const queue = (state as any).queue(segments, 7)
  assert.deepEqual([...queue].map((segment: any) => `${segment.slot}:${segment.id}`), ['A:7', 'B:9', 'B:10'])
  segments[2].channel = 'changed'
  assert.equal(queue[0].channel, 'WX4')
})

test('polling preserves a historical queue and its current source', () => {
  const queue = [{ id: 7 }, { id: 9 }]
  const source = '/api/replay/7.wav?snapshot=stable'
  const state = {
    replayTimeline: [] as Array<Record<string, unknown>>,
    timelineRange: { disabled: false, max: '0', value: '0' },
    timelineLatest: { disabled: false },
    timelineOldest: { textContent: '' },
    timelineSegmentId: 7,
    timelineQueue: queue,
    timelineQueueIndex: 0,
    timelineAudioSource: source,
    timelineAudio: { removeAttribute() { throw new Error('poll must not clear source') }, load() { throw new Error('poll must not reload source') } },
    timelineTime: { textContent: '' },
    timelineOffset: { textContent: '' },
    timelineWaveformLoading: { textContent: '', hidden: false },
    timelineSelectionVersion: 4,
    timelineLatestActiveTimelineIndex: () => -1,
    sortHistoricalReplaySegments: (segments: Array<Record<string, unknown>>) => segments,
    renderFrequencyMap() {}
  }
  vm.runInNewContext(`${declaration(main, 'updateTimeline')}; globalThis.update = updateTimeline`, state)

  ;(state as any).update([
    { id: 7, startedAt: '2026-10-03T12:00:00Z' },
    { id: 9, startedAt: '2026-10-03T12:01:00Z' },
    { id: 12, startedAt: '2026-10-03T12:02:00Z' }
  ])
  assert.equal(state.timelineQueue, queue)
  assert.equal(state.timelineAudioSource, source)
  assert.equal(state.timelineRange.value, '0')
})

test('live button opens and closes the dedicated stream at fixed automatic quieting', async () => {
  const liveAudio = {
    src: '', paused: true, pauses: 0, loads: 0,
    play() { this.paused = false; return Promise.resolve() },
    pause() { this.paused = true; this.pauses += 1 },
    removeAttribute(name: string) { if (name === 'src') this.src = '' },
    load() { this.loads += 1 }
  }
  const liveListen = { textContent: '', setAttribute() {} }
  const liveListenStatus = { textContent: '' }
  const state = {
    API: '/api/', URLSearchParams, liveAudio, liveListen, liveListenStatus,
    liveAudioSource: undefined as string | undefined,
    liveAudioGeneration: 0,
    liveListening: false,
    timelineActiveSlotAChannel: '16',
    replaySquelch: { value: '20' }, timelineCleanup: { value: 'modified' },
    channelDisplay: (channel: string) => `CH ${channel}`,
    pauseOtherAudio() {}
  }
  vm.runInNewContext(`${declaration(main, 'stopLiveListening')}; ${declaration(main, 'startLiveListening')}; globalThis.start = startLiveListening; globalThis.stop = stopLiveListening`, state)
  await (state as any).start()
  assert.equal(state.liveListening, true)
  assert.equal(liveListen.textContent, 'Stop live · CH 16')
  const url = new URL(liveAudio.src, 'http://localhost')
  assert.equal(url.pathname, '/api/live.wav')
  assert.equal(url.searchParams.get('squelch'), '20')
  assert.equal(url.searchParams.get('cleanup'), 'modified')
  assert.equal(url.searchParams.get('quieting'), '100')
  ;(state as any).stop('Stopped for test.')
  assert.equal(state.liveListening, false)
  assert.equal(liveAudio.src, '')
  assert.ok(liveAudio.pauses > 0 && liveAudio.loads > 0)
})

test('timeline uses finite clips and retains a separate live stream control', () => {
  const html = readFileSync(path.join(root, 'public/index.html'), 'utf8')
  assert.match(html, /id="timeline-waveform"/)
  assert.match(html, /id="timeline-play"/)
  assert.match(html, /id="timeline-skip"/)
  assert.match(html, /id="timeline-seek"/)
  assert.match(html, /id="live-listen"/)
  assert.match(html, /vendor\/wavesurfer-7\.11\.1\.min\.js/)
  assert.doesNotMatch(html, /id="timeline-audio" controls/)
  assert.doesNotMatch(html, /Between-transmission quieting/)
  assert.match(main, /replay\/\$\{encodeURIComponent\(segment\.id\)\}\.wav/)
  assert.doesNotMatch(main, /timelineAudio\.src\s*=\s*`\$\{API\}replay\/\$\{segment\.id\}\/continuous\.wav/)
  assert.match(main, /\$\{API\}live\.wav\?\$\{params\}/)
  assert.match(main, /quieting: '100'/)
  assert.match(main, /window\.WaveSurfer\.create/)
  assert.match(main, /dragToSeek: true/)
  assert.match(main, /timelineWaveSurfer\.on\('interaction'/)
  assert.match(main, /destroyArchiveWaveforms\(\)/)
})

test('archive waveform owns playback controls while audio stays lazy until Play', () => {
  const archiveRow = declaration(main, 'archiveRow')
  assert.match(archiveRow, /audio\.preload = 'none'/)
  assert.match(archiveRow, /bindArchivePlaybackButton\(playButton, details, audio, \(\) =>/)
  assert.match(archiveRow, /bindArchiveSkipButton\(skipButton, details, audio, updatePlayback/)
  assert.match(archiveRow, /bindArchiveWaveformSeek\(seek, details, audio, updatePlayback/)
  assert.match(archiveRow, /body\.append\(waveform, audio, controls/)
  assert.match(archiveRow, /seek\.type = 'range'/)
  assert.doesNotMatch(archiveRow, /Between-transmission quieting|quieting\.type = 'range'/)
  assert.match(archiveRow, /quieting=100/)
  assert.doesNotMatch(archiveRow, /audio\.controls = true/)
  assert.match(archiveRow, /originalDownload\.href = `\$\{originalAudioUrl\}&cleanup=raw&squelch=0`/)
  assert.match(archiveRow, /const audioUrl = `\$\{originalAudioUrl\}&activity=1`/)
  assert.doesNotMatch(archiveRow, /audio\.src\s*=/)

  const listeners = new Map<string, () => void>()
  const audio = {
    dataset: {} as Record<string, string>,
    preload: 'none',
    src: '',
    paused: true,
    loads: 0,
    plays: 0,
    pauses: 0,
    play() { this.plays += 1; this.paused = false; return Promise.resolve() },
    pause() { this.pauses += 1; this.paused = true },
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
  vm.runInNewContext(`${declaration(main, 'showArchivePlaybackError')}; ${declaration(main, 'playArchiveAudio')}; ${declaration(main, 'activateArchivePlayback')}; ${declaration(main, 'beginArchivePlayback')}; ${declaration(main, 'bindArchivePlaybackButton')}; bindArchivePlaybackButton(button, details, audio, updatePlayback, loadWaveform)`, sandbox)
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
  assert.equal(audio.plays, 1)
  assert.equal(audio.pauses, 1)
  assert.equal(updates, 1)
  assert.equal(waveforms, 1)
})

test('waveform skip advances five seconds and clamps at the end', () => {
  const listeners = new Map<string, () => void>()
  const button = { addEventListener(name: string, callback: () => void) { listeners.set(name, callback) } }
  const audio = {
    dataset: { archivePlaybackActivated: 'true' },
    readyState: 1,
    currentTime: 2,
    duration: 9,
    addEventListener() {}
  }
  const details = { open: true }
  const calls = { updates: 0, waveforms: 0 }
  vm.runInNewContext(`${declaration(main, 'seekArchiveAudio')}; ${declaration(main, 'bindArchiveSkipButton')}; bindArchiveSkipButton(button, details, audio, () => { calls.updates += 1 }, () => { calls.waveforms += 1 }, 9)`, {
    button, details, audio, calls
  })
  listeners.get('click')!()
  assert.equal(audio.currentTime, 7)
  listeners.get('click')!()
  assert.equal(audio.currentTime, 9)
})

test('waveform skip waits for lazy audio metadata before seeking', () => {
  let click: (() => void) | undefined
  let loaded: (() => void) | undefined
  const audio = {
    dataset: {} as Record<string, string>,
    readyState: 0,
    currentTime: 0,
    duration: Number.NaN,
    addEventListener(name: string, callback: () => void) { if (name === 'loadedmetadata') loaded = callback }
  }
  const details = { open: true }
  const button = { addEventListener(_name: string, callback: () => void) { click = callback } }
  const calls = { updates: 0, waveforms: 0 }
  vm.runInNewContext(`${declaration(main, 'activateArchivePlayback')}; ${declaration(main, 'seekArchiveAudio')}; ${declaration(main, 'bindArchiveSkipButton')}; bindArchiveSkipButton(button, details, audio, () => { calls.updates += 1 }, () => { calls.waveforms += 1 }, 12)`, {
    button, details, audio, calls
  })
  click!()
  assert.equal(audio.dataset.archivePlaybackActivated, 'true')
  assert.equal(calls.updates, 1)
  assert.equal(calls.waveforms, 1)
  audio.readyState = 1
  audio.currentTime = 0
  audio.duration = 12
  loaded!()
  assert.equal(audio.currentTime, 5)
})

test('waveform play reports playback errors to the user', async () => {
  const status = { textContent: '' }
  const audio = { play: () => Promise.reject(new Error('blocked')) }
  vm.runInNewContext(`${declaration(main, 'showArchivePlaybackError')}; ${declaration(main, 'playArchiveAudio')}; playArchiveAudio(audio, status)`, { audio, status })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(status.textContent, 'Playback could not start. Tap Play to try again.')
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
