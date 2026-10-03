import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

test('minimal web client keeps receiver monitoring and one unified activity workspace', () => {
  const root = path.resolve(__dirname, '../..')
  const html = readFileSync(path.join(root, 'public/index.html'), 'utf8')
  const script = readFileSync(path.join(root, 'public/main.js'), 'utf8')

  assert.doesNotMatch(html, /Listen live/)
  assert.doesNotMatch(html, />Recent radio</)
  assert.match(html, /Voice watch · Slot A/)
  assert.match(html, /Second voice · Slot B/)
  assert.match(html, /id="slot-b-mode"/)
  assert.match(html, /Wideband scan/)
  assert.match(html, /id="preset-standard"[^>]*>16 \+ DSC 70</)
  assert.match(html, /id="preset-slot-a-16"[^>]*>Slot A · 16</)
  assert.match(html, /id="preset-slot-b-70"[^>]*>Slot B · off</)
  assert.match(html, />Scan</)
  assert.match(html, /Recent activity/)
  assert.match(html, /DSC calls/)
  assert.match(html, /United States \+ Canada/)
  assert.match(html, /No transmit controls exist/)
  assert.match(html, /Rolling buffer/)
  assert.match(html, />Activity</)
  assert.match(html, /Frequency activity/)
  assert.match(html, /Storage &amp; status/)
  assert.match(html, /Listening &amp; tuning/)
  assert.match(html, /Raw playback squelch/)
  assert.match(html, /processing-panel/)
  assert.match(html, /frequency-map/)
  assert.match(html, /RF detected/)
  assert.match(html, /playable voice/)
  assert.match(html, /Listening — no RF, voice, or DSC activity yet/)
  assert.match(html, /<option value="raw">Raw<\/option>/)
  assert.match(html, /<option value="modified" selected>Modified<\/option>/)
  assert.doesNotMatch(html, />Natural<\/option>/)
  assert.doesNotMatch(html, /value="(?:voice|comfort|maximum|strong|rnnoise)"/)
  assert.match(html, /Delete all recent audio\?/)
  assert.match(html, /clear-replay-dialog/)
  assert.match(html, /Transcribe voice/)
  assert.match(html, /transcription-model/)
  assert.match(html, /transcription-threads/)

  assert.match(script, /request\('slots'/)
  assert.match(script, /applyChannelPreset/)
  assert.match(script, /slotAChannel\.value = '16'/)
  assert.match(script, /slotBChannel\.value = '70'/)
  assert.match(script, /slotConfigurationPending/)
  assert.match(script, /document\.activeElement !== slotAChannel/)
  assert.match(script, /const selection = \{ mode: slotAMode\.value, slotAChannel: slotAChannel\.value, slotBMode: slotBMode\.value, slotBChannel: slotBChannel\.value \}/)
  assert.match(script, /Spectrum-guided now/)
  assert.match(script, /wideband\?\.activity/)
  assert.match(script, /frequency-live/)
  assert.match(script, /request\('activity'\)/)
  assert.match(script, /spectrumTimeline/)
  assert.match(script, /dscTimeline/)
  assert.match(script, /frequency-rf/)
  assert.match(script, /frequency-dsc/)
  assert.match(script, /selectNonAudioMoment/)
  assert.match(script, /no playable voice was captured/)
  assert.match(script, /single-frequency; pauses Slot B \+ DSC/)
  assert.match(script, /availableSlotB/)
  assert.match(script, /Primary watch/)
  assert.match(script, /Marine voice · numeric order/)
  assert.match(script, /Coast \/ duplex · pauses Slot B/)
  assert.match(script, /Weather · pauses Slot B/)
  assert.match(script, /channel\.availableSlotB !== false/)
  assert.match(script, /MINIMUM_REPLAY_SIGNAL_SECONDS/)
  assert.match(script, /renderFrequencyMap/)
  assert.match(script, /timelineReceiverRows/)
  assert.match(script, /frequency-floor/)
  assert.match(script, /floorMarks/)
  assert.match(script, /activityRuns/)
  assert.match(script, /frequency-burst/)
  assert.match(script, /channelFrequency/)
  assert.match(script, /timelineAudio\.addEventListener\('ended'/)
  assert.match(script, /cleanup=\$\{encodeURIComponent\(timelineCleanup\.value\)\}/)
  assert.match(script, /replay\/\$\{segment\.id\}\/continuous\.wav/)
  assert.match(script, /timelineAwaitingChannel/)
  assert.match(script, /groupReplaySessions/)
  assert.match(script, /groupArchiveSessions/)
  assert.match(script, /renderProcessingQueue/)
  assert.match(script, /status\.slots\.B\.kind === 'dsc'/)
  assert.match(script, /UI_VERSION|CLIENT_BUILD/)
  assert.match(script, /SESSION_BREAK_SECONDS = 6/)
  assert.match(script, /transcript-session\.wav\?ids=/)
  assert.match(script, /hasPlayingAudio/)
  assert.match(script, /pauseOtherAudio/)
  assert.match(script, /document\.addEventListener\('play'/)
  assert.match(script, /audio !== activeAudio && !audio\.paused/)
  assert.match(script, /archiveRenderSignature/)
  assert.match(script, /!hasPlayingAudio\(archiveList\)/)
  assert.match(script, /request\('transcripts\?limit=500'/)
  assert.match(script, /document\.createElement\('details'\)/)
  assert.match(script, /archive-log-line/)
  assert.match(script, /Copy transcript/)
  assert.doesNotMatch(script, /Transcript reader|transcript-session\.opus|Sarah|vhf-tts-runtime|Kokoro/i)
  assert.doesNotMatch(script, /SpeechSynthesisUtterance|speechSynthesis/)
  assert.match(script, /!hasPlayingAudio\(archiveList\)/)
  assert.match(script, /Download current playback/)
  assert.match(script, /Original WAV/)
  assert.match(script, /vhf-whisper-runtime/)
  assert.match(script, /availableModels/)
  assert.match(script, /saveTranscriptionRuntime/)
  assert.doesNotMatch(script, /push.?to.?talk|\bptt\b|transmit/i)
})

test('playback exposes only Raw and default Modified and migrates legacy saved choices', () => {
  const root = path.resolve(__dirname, '../..')
  const html = readFileSync(path.join(root, 'public/index.html'), 'utf8')
  const script = readFileSync(path.join(root, 'public/main.js'), 'utf8')
  const api = readFileSync(path.join(root, 'src/api.ts'), 'utf8')
  assert.doesNotMatch(api, /transcript-session\.opus|transcript-session\.narration|vhf-tts-runtime/i)
  const timelineOptions = html.match(/<select id="timeline-cleanup">([\s\S]*?)<\/select>/)?.[1] ?? ''
  const timelineValues = [...timelineOptions.matchAll(/<option value="([^"]+)"/g)].map((match) => match[1])
  const archiveOptions = script.match(/cleanup\.innerHTML = '([^']+)'/)?.[1] ?? ''
  const archiveValues = [...archiveOptions.matchAll(/<option value="([^"]+)"/g)].map((match) => match[1])

  assert.deepEqual(timelineValues, ['raw', 'modified'])
  assert.deepEqual(archiveValues, ['raw', 'modified'])
  assert.match(script, /function playbackPreference\(key, fallback\)/)
  assert.match(script, /value === 'raw' \|\| value === 'modified'/)
  assert.match(script, /if \(value\) \{\s*savePreference\(key, 'modified'\)\s*return 'modified'/)
  assert.match(script, /playbackPreference\('timeline-cleanup', timelineCleanup\.value\)/)
  assert.match(script, /playbackPreference\(`\$\{preferenceKey\}:cleanup`, timelineCleanup\.value\)/)
  assert.match(script, /replaySquelch\.disabled = timelineCleanup\.value === 'modified'/)
  assert.match(script, /const CLIENT_BUILD = 50/)
  assert.match(api, /const UI_VERSION = 50/)
  assert.match(html, /main\.js\?v=50/)
  assert.match(html, /Between-transmission quieting/)
  assert.match(script, /timeline-quieting/)
  assert.match(script, /savePreference\('timeline-quieting', timelineQuieting\.value\)/)
  assert.match(script, /savePreference\(`\$\{preferenceKey\}:quieting`, quieting\.value\)/)
  assert.match(script, /quieting\.disabled = cleanup\.value === 'raw'/)
  assert.match(script, /&quieting=\$\{encodeURIComponent\(quieting\)\}/)
  assert.match(script, /&quieting=\$\{encodeURIComponent\(timelineQuieting\.value\)\}/)
  assert.match(api, /quietingIntensity: parseQuietingIntensity\(request\.query\.quieting\)/)
  assert.match(api, /openStream\(runtime\.config\.sampleRate, abort\.signal, parseQuietingIntensity\(request\.query\.quieting\)\)/)
  assert.equal([...api.matchAll(/quietingIntensity: parseQuietingIntensity\(request\.query\.quieting\)/g)].length, 4)
  assert.equal([...api.matchAll(/openStream\(runtime\.config\.sampleRate, abort\.signal, parseQuietingIntensity\(request\.query\.quieting\)\)/g)].length, 2)
})

test('client starts polling before initialization finishes and retries failed channel setup', async () => {
  const { runInNewContext } = await import('node:vm')
  const root = path.resolve(__dirname, '../..')
  const script = readFileSync(path.join(root, 'public/main.js'), 'utf8')
  const channelsStart = script.indexOf('  async function loadChannels()')
  const statusStart = script.indexOf('  async function updateStatus()', channelsStart)
  const pollingStart = script.indexOf('  function startPolling()', statusStart)
  const listenersStart = script.indexOf('  slotAMode.addEventListener', pollingStart)
  const source = script.slice(channelsStart, statusStart) + script.slice(pollingStart, listenersStart)
  assert.ok(channelsStart >= 0 && statusStart > channelsStart && pollingStart > statusStart && listenersStart > pollingStart)

  const callbacks: Array<() => void | Promise<void>> = []
  let attempts = 0
  let statusUpdates = 0
  let replayUpdates = 0
  const element = () => ({ value: '', label: '', textContent: '', disabled: false, children: [] as unknown[],
    append(...children: unknown[]) { this.children.push(...children) }, replaceChildren(...children: unknown[]) { this.children = children } })
  const context: {
    window: { setInterval: (callback: () => void) => number }
    document: { createElement: (tag: string) => ReturnType<typeof element> }
    channels: Array<Record<string, unknown>>
    pollTimers: Set<number>
    pollingStarted: boolean
    channelsLoaded: boolean
    channelsLoading: boolean
    poll?: number
    latestStatus: object
    renderedChannelCount?: number
    regionSelect: ReturnType<typeof element>
    slotAChannel: ReturnType<typeof element>
    slotBChannel: ReturnType<typeof element>
    renderStatus: () => void
    renderFrequencyMap: () => void
    request: () => Promise<{ channels: Array<Record<string, unknown>>; region: string }>
    loadChannels: () => Promise<void>
    updateStatus: () => Promise<void>
    updateReplay: () => Promise<void>
    updateSpectrumActivity: () => Promise<void>
    updateDsc: () => Promise<void>
    updateArchive: () => Promise<void>
    setConnection: () => void
  } = {
    window: { setInterval: (callback) => { callbacks.push(callback); return callbacks.length } },
    document: { createElement: () => element() }, channels: [],
    pollTimers: new Set(), pollingStarted: false, channelsLoaded: false, channelsLoading: false, poll: undefined,
    latestStatus: {}, regionSelect: element(), slotAChannel: element(), slotBChannel: element(),
    renderStatus: () => { context.renderedChannelCount = context.slotAChannel.children.length }, renderFrequencyMap: () => {},
    request: async () => {
      attempts += 1
      if (attempts === 1) throw new Error('Signal K is starting')
      return { region: 'US', channels: [{ id: '16', label: '16', countries: ['US'], purpose: 'Distress', weather: false,
        requiresSingleFrequency: false, availableSlotA: true, availableSlotB: true }] }
    },
    loadChannels: async () => {},
    updateStatus: async () => { statusUpdates += 1 },
    updateReplay: async () => { replayUpdates += 1 },
    updateSpectrumActivity: async () => {}, updateDsc: async () => {}, updateArchive: async () => {},
    setConnection: () => {}
  }
  await runInNewContext(`(async () => { ${source}; await initialize() })()`, context)
  assert.equal(callbacks.length, 6)
  assert.equal(attempts, 1)
  assert.equal(statusUpdates, 1)
  assert.equal(replayUpdates, 1)
  await callbacks[5]!()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(attempts, 2)
  assert.ok(context.slotAChannel.children.length > 0)
  assert.ok(context.renderedChannelCount! > 0)
  assert.equal(context.pollTimers.size, 6)
})


test('each transcript line deep-links to audio and a waveform marker', () => {
  const root = path.resolve(__dirname, '../..')
  const script = readFileSync(path.join(root, 'public/main.js'), 'utf8')
  const css = readFileSync(path.join(root, 'public/styles.css'), 'utf8')

  assert.match(script, /transcriptMomentId/)
  assert.match(script, /transcript-time-link/)
  assert.match(script, /transcript-marker/)
  assert.match(script, /dataset\.audioOffset/)
  assert.match(script, /window\.history\.pushState/)
  assert.match(script, /openTranscriptFromHash/)
  assert.match(script, /window\.addEventListener\('hashchange'/)
  assert.match(script, /selectTranscriptMoment/)
  assert.match(script, /offset \+= archivePlaybackDuration\(candidate\)/)
  assert.match(script, /activity=1/)
  assert.match(script, /source retained/)
  assert.match(script, /renderArchiveWaveform/)
  assert.match(script, /wavSamples/)
  assert.match(css, /\.transcript-marker/)
  assert.match(css, /\.archive-log-line:target/)
})

test('each archived recording has independent non-destructive squelch and cleanup', () => {
  const root = path.resolve(__dirname, '../..')
  const script = readFileSync(path.join(root, 'public/main.js'), 'utf8')

  assert.match(script, /Raw playback squelch/)
  assert.match(script, /Background noise/)
  assert.match(script, /<option value="raw">Raw<\/option>/)
  assert.match(script, /<option value="modified" selected>Modified<\/option>/)
  assert.doesNotMatch(script, />Natural<\/option>/)
  assert.match(script, /Off \/ raw/)
  assert.doesNotMatch(script, /value="(?:voice|comfort|maximum|strong|rnnoise)"/)
  assert.match(script, /cleanup=\$\{encodeURIComponent\(cleanup\)\}&squelch=\$\{encodeURIComponent\(squelch\)\}/)
  assert.match(script, /audio\.currentTime/)
  assert.match(script, /download\.href = source/)
  assert.match(script, /squelch\.disabled = cleanup\.value === 'modified'/)
})
