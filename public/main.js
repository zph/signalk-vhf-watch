(() => {
  'use strict'
  const CLIENT_BUILD = 55
  const API = new URL('../plugins/signalk-vhf-watch/api/', window.location.href).pathname
  const $ = (selector) => document.querySelector(selector)
  const connection = $('#connection')
  const regionSelect = $('#region')
  const slotAMode = $('#slot-a-mode')
  const slotAChannel = $('#slot-a-channel')
  const slotBMode = $('#slot-b-mode')
  const slotBChannel = $('#slot-b-channel')
  const slotAPurpose = $('#slot-a-purpose')
  const slotBPurpose = $('#slot-b-purpose')
  const slotADisplay = $('#slot-a-display')
  const slotAFrequency = $('#slot-a-frequency')
  const slotAModeLabel = $('#slot-a-mode-label')
  const slotBDisplay = $('#slot-b-display')
  const slotBFrequency = $('#slot-b-frequency')
  const slotBModeLabel = $('#slot-b-mode-label')
  const presetStandard = $('#preset-standard')
  const presetSlotA16 = $('#preset-slot-a-16')
  const presetSlotB70 = $('#preset-slot-b-70')
  const signalBar = $('#signal-bar')
  const signalValue = $('#signal-value')
  const receiverState = $('#receiver-state')
  const liveListen = $('#live-listen')
  const liveListenStatus = $('#live-listen-status')
  const liveAudio = $('#live-audio')
  const dscList = $('#dsc-list')
  const dscEmpty = $('#dsc-empty')
  const dscModeLabel = $('#dsc-mode-label')
  const retention = $('#retention')
  const replaySquelch = $('#replay-squelch')
  const clearReplayDialog = $('#clear-replay-dialog')
  const timelineRange = $('#timeline-range')
  const timelineTime = $('#timeline-time')
  const timelineOffset = $('#timeline-offset')
  const timelineOldest = $('#timeline-oldest')
  const timelineAudio = $('#timeline-audio')
  const timelineLatest = $('#timeline-latest')
  const timelineDescription = $('#timeline-description')
  const timelineCleanup = $('#timeline-cleanup')
  const timelineWaveformTrack = $('#timeline-waveform-track')
  const timelineWaveformLoading = $('#timeline-waveform-loading')
  const timelineWaveformSpinner = $('#timeline-waveform-spinner')
  const timelineWaveformHover = $('#timeline-waveform-hover')
  const timelineSeek = $('#timeline-seek')
  const timelinePlay = $('#timeline-play')
  const timelineSkip = $('#timeline-skip')
  const timelinePlaybackTime = $('#timeline-playback-time')
  const timelinePlaybackStatus = $('#timeline-playback-status')
  const frequencyMap = $('#frequency-map')
  const frequencyEmpty = $('#frequency-empty')
  const transcriptionEnabled = $('#transcription-enabled')
  const transcriptionModel = $('#transcription-model')
  const transcriptionThreads = $('#transcription-threads')
  const weatherTranscriptionModel = $('#weather-transcription-model')
  const weatherTranscriptionThreads = $('#weather-transcription-threads')
  const transcriptionOverlap = $('#transcription-overlap')
  const transcriptionKeepLoaded = $('#transcription-keep-loaded')
  const transcriptionStatus = $('#transcription-status')
  const transcriptionProgressState = $('#transcription-progress-state')
  const transcriptionProgressDetail = $('#transcription-progress-detail')
  const archiveList = $('#archive-list')
  const archiveAllView = $('#archive-all-view')
  const archiveViewAll = $('#archive-view-all')
  const archiveViewConversation = $('#archive-view-conversation')
  const conversationView = $('#conversation-view')
  const conversationChannel = $('#conversation-channel')
  const conversationRange = $('#conversation-range')
  const conversationPlay = $('#conversation-play')
  const conversationTimeline = $('#conversation-timeline')
  const conversationScaleStart = $('#conversation-scale-start')
  const conversationScaleEnd = $('#conversation-scale-end')
  const conversationEmpty = $('#conversation-empty')
  const conversationStatus = $('#conversation-status')
  const conversationAudio = $('#conversation-audio')
  const conversationClips = $('#conversation-clips')
  const conversationLimit = $('#conversation-limit')
  const archiveEmpty = $('#archive-empty')
  const archiveSummary = $('#archive-summary')
  const voiceEventCount = $('#voice-event-count')
  const voiceEventSummary = $('#voice-event-summary')
  const dscCallCount = $('#dsc-call-count')
  const archiveBytes = $('#archive-bytes')
  const processingPanel = $('#processing-panel')
  const processingCount = $('#processing-count')
  const processingList = $('#processing-list')
  const settingsPanel = $('#settings-panel')
  const receiverFootnote = $('#receiver-footnote')
  const MINIMUM_REPLAY_SIGNAL_SECONDS = 0.35
  const SESSION_BREAK_SECONDS = 6
  let channels = []
  let poll
  const pollTimers = new Set()
  let pollingStarted = false
  let channelsLoaded = false
  let channelsLoading = false
  let latestStatus
  let replaySquelchTouched = false
  let replayTimeline = []
  let timelineQueue = []
  let timelineQueueIndex = -1
  let timelineSelectionVersion = 0
  let timelineWaveformController
  let timelineWaveSurfer
  let timelineAudioSource
  let timelinePendingSeek
  let timelineMetadataSource
  let timelineAutoAdvance = false
  let timelinePlaybackGeneration = 0
  let timelinePlaybackRequested = false
  let timelineBusyVersion = 0
  let liveAudioSource
  let liveAudioGeneration = 0
  let liveListening = false
  let spectrumTimeline = []
  let dscTimeline = []
  let timelineSegmentId
  let timelineWindowMinutes = 1_440
  let timelineReceiverRows = []
  let timelineActiveSlotAChannel
  let archiveRenderSignature = ''
  const archiveWaveSurfers = new Map()
  let conversationRecords = []
  let conversationSelectedId
  let conversationSignature = ''
  let conversationChannelSignature = ''
  let conversationLastRenderMinute = -1
  let archiveView = 'all'
  let conversationPlayer
  let singleFrequencyActive = false
  let slotConfigurationPending = false

  conversationPlayer = new window.VHFConversation.ConversationPlayer(conversationAudio, {
    sourceFor: (record) => `${API}transcripts/${record.id}.wav?activity=1&cleanup=${encodeURIComponent(timelineCleanup.value)}&squelch=${encodeURIComponent(replaySquelch.value)}&quieting=100`,
    onCurrent: (record) => {
      conversationSelectedId = record?.id
      markConversationClip()
    },
    onStatus: (message) => { conversationStatus.textContent = message }
  })

  function storedPreference(key, fallback) {
    try { return window.localStorage.getItem(`vhf-watch:${key}`) ?? fallback } catch { return fallback }
  }

  function savePreference(key, value) {
    try { window.localStorage.setItem(`vhf-watch:${key}`, String(value)) } catch { /* private browsing or disabled storage */ }
  }

  function playbackPreference(key, fallback) {
    const value = storedPreference(key, '')
    if (value === 'raw' || value === 'modified') return value
    if (value) {
      savePreference(key, 'modified')
      return 'modified'
    }
    return fallback
  }

  const storedSquelch = storedPreference('replay-squelch', '')
  if (replaySquelch.querySelector(`option[value="${storedSquelch}"]`)) {
    replaySquelch.value = storedSquelch
    replaySquelchTouched = true
  }
  timelineCleanup.value = playbackPreference('timeline-cleanup', timelineCleanup.value)
  settingsPanel.open = storedPreference('settings-open', 'false') === 'true'

  async function request(path, options) {
    const response = await fetch(API + path, { credentials: 'include', ...options })
    if (!response.ok) {
      const body = await response.json().catch(() => ({}))
      throw new Error(body.error || `Request failed (${response.status})`)
    }
    if (response.status === 204) return undefined
    return response.json()
  }

  async function copyText(text) {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return
    }
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.setAttribute('readonly', '')
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.append(textarea)
    textarea.select()
    const copied = document.execCommand('copy')
    textarea.remove()
    if (!copied) throw new Error('clipboard access is unavailable')
  }

  function setConnection(kind, label) {
    connection.className = `connection ${kind}`
    connection.lastChild.textContent = label
  }

  function channelPurpose(id) {
    return channels.find((channel) => channel.id === id)?.purpose || '—'
  }

  function channelDisplay(id) {
    const channel = channels.find((entry) => entry.id === id)
    if (!channel) return `CH ${id}`
    return channel.weather ? `${channel.label} · ${channel.purpose}` : `CH ${channel.label}`
  }

  function channelFrequencyDisplay(id) {
    const frequencyHz = channelFrequency(id)
    return frequencyHz ? `${(frequencyHz / 1_000_000).toFixed(3)} MHz` : 'Frequency unavailable'
  }

  function renderTranscriptionProgress(transcription) {
    let label = 'Unavailable'
    let detail = 'Transcription status is unavailable.'
    let state = 'unavailable'
    if (transcription && !transcription.enabled) {
      label = 'Off'
      detail = 'Transcription is switched off.'
    } else if (transcription?.error) {
      label = 'Needs attention'
      detail = transcription.error
      state = 'error'
    } else if (transcription?.available && transcription.backlog) {
      const { clips, seconds, processingClips } = transcription.backlog
      if (clips === 0) {
        label = 'Caught up'
        detail = 'No clips waiting for transcription.'
        state = 'caught-up'
      } else {
        label = 'Backlog'
        detail = `${clips} clip${clips === 1 ? '' : 's'} unfinished · ${Math.ceil(seconds)} s of audio`
        detail += processingClips ? ` · ${processingClips} processing` : ' · waiting to start'
        state = 'backlog'
      }
    }
    transcriptionProgressState.textContent = label
    transcriptionProgressState.dataset.state = state
    transcriptionProgressDetail.textContent = detail
  }

  function renderStatus(status) {
    if (status.uiVersion && status.uiVersion !== CLIENT_BUILD) {
      const reloadKey = `vhf-watch:reload:${status.uiVersion}`
      if (!window.sessionStorage.getItem(reloadKey)) {
        window.sessionStorage.setItem(reloadKey, 'true')
        const url = new URL(window.location.href)
        url.searchParams.set('ui', status.uiVersion)
        window.location.replace(url)
        return
      }
    }
    singleFrequencyActive = status.captureMode === 'single_frequency'
    const activeSlotAChannel = status.slots.A.currentChannel.id
    handleTimelineSlotARetune(activeSlotAChannel)
    timelineActiveSlotAChannel = activeSlotAChannel
    liveListen.disabled = false
    if (!liveListening) liveListen.textContent = `Listen live · ${channelDisplay(activeSlotAChannel)}`
    if (!slotConfigurationPending) {
      if (document.activeElement !== regionSelect) regionSelect.value = status.channelRegion
      if (document.activeElement !== slotAMode) slotAMode.value = status.slots.A.mode
      if (document.activeElement !== slotAChannel) slotAChannel.value = status.slots.A.configuredChannel.id
      if (document.activeElement !== slotBMode) slotBMode.value = status.slots.B.mode
      if (document.activeElement !== slotBChannel) slotBChannel.value = status.slots.B.configuredChannel.id
    }
    slotADisplay.textContent = status.slots.A.currentChannel.label
    slotAFrequency.textContent = `${(status.slots.A.currentChannel.frequencyHz / 1_000_000).toFixed(3)} MHz`
    slotAModeLabel.textContent = status.slots.A.mode === 'scan' ? 'Scanning' : 'Fixed'
    slotBDisplay.textContent = status.slots.B.channel.label
    slotBFrequency.textContent = `${(status.slots.B.channel.frequencyHz / 1_000_000).toFixed(3)} MHz`
    slotBModeLabel.textContent = status.slots.B.kind === 'paused'
      ? 'Paused'
      : status.slots.B.mode === 'scan'
        ? status.slots.B.state === 'holding' ? 'Holding voice' : 'Wideband scan'
        : status.slots.B.kind === 'dsc' ? 'Voice slot idle' : 'Fixed voice'
    slotAPurpose.textContent = status.slots.A.mode === 'scan'
      ? `Scanning now: CH ${status.slots.A.currentChannel.label} · ${status.slots.A.state}`
      : status.slots.A.configuredChannel.purpose
    slotBPurpose.textContent = status.slots.B.kind === 'paused'
      ? `Paused while Slot A receives ${status.slots.A.currentChannel.label} outside the marine band`
      : status.slots.B.mode === 'scan'
        ? `Spectrum-guided now: CH ${status.slots.B.channel.label} · DSC 70 remains continuous`
        : status.slots.B.kind === 'dsc'
        ? 'No second voice channel · DSC 70 remains continuous independently'
        : status.slots.B.channel.purpose
    slotAMode.disabled = singleFrequencyActive
    slotBMode.disabled = singleFrequencyActive
    slotBChannel.disabled = singleFrequencyActive
    dscModeLabel.textContent = singleFrequencyActive
      ? 'Retained history · Channel 70 paused for weather'
      : 'Channel 70 · continuous'
    receiverFootnote.textContent = singleFrequencyActive
      ? 'Receive only. Channel 70 is paused during single-frequency reception.'
      : 'Receive only. Channel 70 is watched continuously while voice slots use the shared wideband capture.'
    const percentage = Math.min(100, Math.round(status.level * 650))
    signalBar.style.width = `${percentage}%`
    signalValue.textContent = `${percentage}%`
    if (!replaySquelchTouched) replaySquelch.value = String(status.squelch)
    const dsc = status.dscWatch?.continuous ? ' · DSC 70 continuous' : ''
    const metrics = status.receiverMetrics
    const health = metrics && (metrics.restarts || metrics.droppedIqChunks)
      ? ` · ${metrics.restarts} restarts · ${metrics.droppedIqChunks} IQ drops`
      : ''
    const source = status.mode === 'demo' ? 'Demo source' : singleFrequencyActive ? 'Single-frequency RTL-SDR' : 'Wideband RTL-SDR'
    receiverState.textContent = status.error || `${status.receiverState} · ${source}${dsc}${health}`
    const replayWindow = status.replayMinutes === 1_440 ? '24 hours' : `${status.replayMinutes} minutes`
    retention.textContent = `Latest ${replayWindow} · ${status.maxBufferMiB} MiB total compressed-audio cap · ${status.replaySegments} private playable segments`
    timelineWindowMinutes = status.replayMinutes
    timelineDescription.textContent = `Historical recordings · all channels · past ${replayWindow}`
    const frequencyScale = document.querySelectorAll('.frequency-scale span')
    if (frequencyScale.length === 3) {
      frequencyScale[0].textContent = status.replayMinutes === 1_440 ? '24 hr ago' : `${status.replayMinutes} min ago`
      frequencyScale[1].textContent = status.replayMinutes === 1_440 ? '12 hr ago' : `${Math.round(status.replayMinutes / 2)} min ago`
    }
    const receiverRows = [{
      slot: 'A',
      channel: status.slots.A.currentChannel.id,
      frequencyHz: status.slots.A.currentChannel.frequencyHz
    }]
    if (status.slots.B.kind === 'voice') {
      receiverRows.push({
        slot: 'B',
        channel: status.slots.B.channel.id,
        frequencyHz: status.slots.B.channel.frequencyHz
      })
    }
    for (const detected of status.wideband?.activity?.filter((entry) => entry.active) || []) {
      if (receiverRows.some((row) => row.frequencyHz === detected.frequencyHz)) continue
      receiverRows.push({ slot: 'RF', channel: detected.channel, frequencyHz: detected.frequencyHz, liveScore: detected.score })
    }
    const receiverRowsChanged = JSON.stringify(receiverRows) !== JSON.stringify(timelineReceiverRows)
    timelineReceiverRows = receiverRows
    if (receiverRowsChanged) renderFrequencyMap()
    const transcription = status.transcription
    renderTranscriptionProgress(transcription)
    const modelSignature = JSON.stringify(transcription.availableModels)
    for (const selector of [transcriptionModel, weatherTranscriptionModel]) {
      if (selector.dataset.models !== modelSignature) {
        selector.replaceChildren(...transcription.availableModels.map((model) => {
          const option = document.createElement('option')
          option.value = model.id
          option.textContent = `${model.label} · ${(model.bytes / 1024 / 1024).toFixed(0)} MiB`
          return option
        }))
        selector.dataset.models = modelSignature
      }
    }
    if (!transcription.weatherAvailable && ![...weatherTranscriptionModel.options].some((option) => option.value === transcription.weatherModel)) {
      const unavailable = document.createElement('option')
      unavailable.value = transcription.weatherModel
      unavailable.textContent = `${transcription.weatherModel} · unavailable`
      weatherTranscriptionModel.append(unavailable)
    }
    transcriptionModel.value = transcription.model
    transcriptionThreads.value = String(transcription.threads)
    weatherTranscriptionModel.value = transcription.weatherModel
    weatherTranscriptionThreads.value = String(transcription.weatherThreads)
    if (document.activeElement !== transcriptionOverlap) transcriptionOverlap.value = String(transcription.overlapSeconds)
    transcriptionKeepLoaded.checked = transcription.keepModelsLoaded
    transcriptionModel.disabled = transcription.availableModels.length === 0 || transcriptionModel.dataset.saving === 'true'
    transcriptionThreads.disabled = transcription.availableModels.length === 0 || transcriptionThreads.dataset.saving === 'true'
    weatherTranscriptionModel.disabled = transcription.availableModels.length === 0 || weatherTranscriptionModel.dataset.saving === 'true'
    weatherTranscriptionThreads.disabled = transcription.availableModels.length === 0 || weatherTranscriptionThreads.dataset.saving === 'true'
    transcriptionOverlap.disabled = transcriptionOverlap.dataset.saving === 'true'
    transcriptionKeepLoaded.disabled = transcriptionKeepLoaded.dataset.saving === 'true'
    transcriptionEnabled.checked = transcription.enabled
    transcriptionEnabled.disabled = !transcription.available && !transcription.enabled
    const modelLabel = (id) => transcription.availableModels.find((model) => model.id === id)?.label || id
    const marineModel = modelLabel(transcription.model)
    const weatherModel = modelLabel(transcription.weatherModel)
    const route = transcription.weatherAvailable
      ? `weather ${weatherModel} · marine ${marineModel}`
      : `weather model unavailable · marine ${marineModel}`
    const activeModel = transcription.activeModel ? ` · processing ${modelLabel(transcription.activeModel)}` : ''
    transcriptionStatus.textContent = transcription.error
      ? `Transcription needs attention · ${transcription.error}`
      : transcription.enabled
      ? `Local transcription on · ${transcription.state}${transcription.queued ? ` · ${transcription.queued} queued` : ''}${activeModel} · ${route} · marine ${transcription.threads} threads · weather ${transcription.weatherThreads} threads`
      : transcription.available
        ? `Local transcription off · ${route} · ready`
        : 'Local transcription off · install vhf-whisper-runtime to enable it'
    if (transcription.archive) {
      archiveSummary.textContent = `${transcription.archive.records} records · ${(transcription.archive.databaseBytes / 1024 / 1024).toFixed(1)} of ${(transcription.archive.maxBytes / 1024 / 1024).toFixed(0)} MiB · up to ${transcription.archive.retentionDays} days`
    }
    setConnection(status.error ? 'error' : 'ok', status.error ? 'Receiver error' : 'Connected')
  }

  function handleTimelineSlotARetune(activeSlotAChannel) {
    if (liveListening && timelineActiveSlotAChannel && timelineActiveSlotAChannel !== activeSlotAChannel) {
      stopLiveListening(`Live audio stopped because Slot A changed to ${channelDisplay(activeSlotAChannel)}.`)
    }
    return false
  }

  async function loadChannels() {
    if (channelsLoading) return
    channelsLoading = true
    try {
      await loadChannelsOnce()
      channelsLoaded = true
      if (latestStatus) renderStatus(latestStatus)
      renderFrequencyMap()
    } finally {
      channelsLoading = false
    }
  }

  async function loadChannelsOnce() {
    const response = await request('channels')
    channels = response.channels
    regionSelect.value = response.region
    const optionFor = (channel, slot) => {
      const option = document.createElement('option')
      option.value = channel.id
      const singleFrequency = slot === 'A' && channel.requiresSingleFrequency ? ' · single-frequency; pauses Slot B + DSC' : ''
      option.textContent = `${channel.label} · ${channel.countries.join('+')} — ${channel.purpose}${singleFrequency}`
      option.disabled = slot === 'B' ? channel.availableSlotB === false : channel.availableSlotA === false
      return option
    }
    const optionGroup = (label, entries, slot) => {
      const group = document.createElement('optgroup')
      group.label = label
      group.append(...entries.map((channel) => optionFor(channel, slot)))
      return group
    }
    const primary = channels.filter((channel) => channel.id === '16')
    const marine = channels.filter((channel) => channel.id !== '16' && !channel.weather && !channel.requiresSingleFrequency)
    const coast = channels.filter((channel) => !channel.weather && channel.requiresSingleFrequency)
    const weather = channels.filter((channel) => channel.weather)
    slotAChannel.replaceChildren(
      optionGroup('Primary watch', primary, 'A'),
      optionGroup('Marine voice · numeric order', marine, 'A'),
      ...(coast.length > 0 ? [optionGroup('Coast / duplex · pauses Slot B', coast, 'A')] : []),
      ...(weather.length > 0 ? [optionGroup('Weather · pauses Slot B', weather, 'A')] : [])
    )
    const dscOption = document.createElement('option')
    dscOption.value = '70'
    dscOption.textContent = 'Off · no second voice channel (DSC 70 stays continuous)'
    const dscGroup = document.createElement('optgroup')
    dscGroup.label = 'Second voice slot'
    dscGroup.append(dscOption)
    const slotBVoice = channels.filter((channel) => channel.availableSlotB !== false)
    slotBChannel.replaceChildren(dscGroup, optionGroup('Marine voice · numeric order', slotBVoice, 'B'))
  }

  async function updateStatus() {
    try {
      latestStatus = await request('status')
      renderStatus(latestStatus)
    } catch (error) {
      renderTranscriptionProgress(undefined)
      setConnection('error', error.message)
    }
  }

  function replayActiveSeconds(segment) {
    if (!Array.isArray(segment.activity) || segment.activity.length === 0) return undefined
    return segment.activity.reduce((sum, value) => sum + value, 0) / segment.activity.length * segment.durationSeconds
  }

  function edgeQuietSeconds(segment, leading) {
    if (!Array.isArray(segment.activity) || segment.activity.length === 0) return 0
    const values = leading ? segment.activity : segment.activity.slice().reverse()
    let quietBins = 0
    for (const value of values) {
      if (value > 0) break
      quietBins += 1
    }
    return quietBins * segment.durationSeconds / segment.activity.length
  }

  function downsampleActivity(values, maximumBins = 240) {
    if (values.length <= maximumBins) return values
    const result = []
    const width = values.length / maximumBins
    for (let index = 0; index < maximumBins; index += 1) {
      const start = Math.floor(index * width)
      const end = Math.max(start + 1, Math.ceil((index + 1) * width))
      result.push(Math.max(...values.slice(start, end)))
    }
    return result
  }

  function replaySession(segments) {
    const first = segments[0]
    const last = segments.at(-1)
    const measured = segments.flatMap((segment) => segment.minimumDiscriminatorNoise === undefined ? [] : [segment.minimumDiscriminatorNoise])
    const transcriptionStates = segments.flatMap((segment) => segment.transcription ? [segment.transcription] : [])
    const texts = transcriptionStates.flatMap((transcription) => transcription.status === 'complete' && transcription.text ? [transcription.text] : [])
    const error = transcriptionStates.find((transcription) => transcription.status === 'error')
    const active = transcriptionStates.find((transcription) => ['queued', 'transcribing'].includes(transcription.status))
    const transcription = error
      ? error
      : active
        ? active
        : texts.length > 0
          ? { status: 'complete', text: texts.join(' ') }
          : undefined
    return {
      ...first,
      ids: segments.map((segment) => segment.id),
      endedAt: last.endedAt,
      durationSeconds: segments.reduce((sum, segment) => sum + segment.durationSeconds, 0),
      activity: downsampleActivity(segments.flatMap((segment) => segment.activity ?? [])),
      ...(measured.length > 0 ? { minimumDiscriminatorNoise: Math.min(...measured) } : {}),
      ...(transcription ? { transcription } : {})
    }
  }

  function groupReplaySessions(segments) {
    const groups = []
    for (const segment of segments.slice().reverse()) {
      const group = groups.at(-1)
      const previous = group?.at(-1)
      const timeGapSeconds = previous ? (Date.parse(segment.startedAt) - Date.parse(previous.endedAt)) / 1000 : Number.POSITIVE_INFINITY
      const quietSeconds = previous ? edgeQuietSeconds(previous, false) + edgeQuietSeconds(segment, true) : Number.POSITIVE_INFINITY
      const joins = previous && previous.slot === segment.slot && previous.channel === segment.channel &&
        timeGapSeconds >= -1 && timeGapSeconds <= 2 && quietSeconds < SESSION_BREAK_SECONDS
      if (joins) group.push(segment)
      else groups.push([segment])
    }
    return groups.map(replaySession).reverse()
  }

  function archiveActivityStart(record) {
    return Math.max(0, Math.min(record.durationSeconds, record.activityStartSeconds ?? 0))
  }

  function archiveActivityEnd(record) {
    return Math.max(archiveActivityStart(record), Math.min(record.durationSeconds, record.activityEndSeconds ?? record.durationSeconds))
  }

  function archivePlaybackDuration(record) {
    return archiveActivityEnd(record) - archiveActivityStart(record)
  }

  function groupArchiveSessions(records) {
    const groups = []
    for (const record of records.slice().reverse()) {
      const group = groups.at(-1)
      const previous = group?.at(-1)
      const gapSeconds = previous ? (Date.parse(record.startedAt) - Date.parse(previous.endedAt)) / 1000 : Number.POSITIVE_INFINITY
      if (previous && previous.channel === record.channel && previous.sampleRate === record.sampleRate && gapSeconds <= SESSION_BREAK_SECONDS) {
        group.push(record)
      } else groups.push([record])
    }
    return groups.map((group) => {
      const first = group[0]
      const last = group.at(-1)
      const measured = group.flatMap((record) => record.minimumDiscriminatorNoise === undefined ? [] : [record.minimumDiscriminatorNoise])
      const sourceDurationSeconds = group.reduce((sum, record) => sum + record.durationSeconds, 0)
      return {
        ...first,
        ids: group.map((record) => record.id),
        records: group,
        startedAt: new Date(Date.parse(first.startedAt) + archiveActivityStart(first) * 1_000).toISOString(),
        endedAt: new Date(Date.parse(last.startedAt) + archiveActivityEnd(last) * 1_000).toISOString(),
        durationSeconds: group.reduce((sum, record) => sum + archivePlaybackDuration(record), 0),
        sourceDurationSeconds,
        transcript: group.map((record) => record.transcript).filter(Boolean).join(' '),
        ...(measured.length > 0 ? { minimumDiscriminatorNoise: Math.min(...measured) } : {})
      }
    }).reverse()
  }

  function hasPlayingAudio(container) {
    return [...container.querySelectorAll('audio')].some((audio) => !audio.paused && !audio.ended)
  }

  function archiveTimeLabel(seconds) {
    const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0))
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
  }

  function localRecordingClock(timestamp) {
    const date = new Date(timestamp)
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })
  }

  function timelineClockAtOffset(segment, offsetSeconds) {
    const start = Date.parse(segment.startedAt)
    if (!Number.isFinite(start)) return ''
    return localRecordingClock(start + Math.max(0, offsetSeconds) * 1000)
  }

  function archiveClockAtOffset(record, offsetSeconds) {
    let remaining = Math.max(0, offsetSeconds)
    const entries = record.records || []
    for (const entry of entries) {
      const duration = archivePlaybackDuration(entry)
      if (remaining < duration || entry === entries.at(-1)) {
        const start = Date.parse(entry.startedAt)
        if (!Number.isFinite(start)) return ''
        return localRecordingClock(start + (archiveActivityStart(entry) + Math.min(remaining, duration)) * 1000)
      }
      remaining -= duration
    }
    return ''
  }

  function showWaveformHover(track, tooltip, duration, timestampAt, event) {
    if (event.pointerType === 'touch' || !duration || (event.target instanceof Element && event.target.closest('.archive-waveform-transport'))) return
    const bounds = track.getBoundingClientRect()
    if (!bounds.width) return
    const fraction = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width))
    tooltip.textContent = timestampAt(fraction * duration)
    tooltip.hidden = !tooltip.textContent
    tooltip.style.left = `${Math.max(0, Math.min(bounds.width - tooltip.offsetWidth, event.clientX - bounds.left - tooltip.offsetWidth / 2))}px`
    tooltip.style.transform = 'none'
  }

  function waveformPlayIcon(button, playing) {
    button.innerHTML = playing
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7zM15 5h4v14h-4z"/></svg>'
      : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.8v14.4L19 12 7 4.8z"/></svg>'
    const label = playing ? 'Pause recording' : 'Play recording'
    button.setAttribute('aria-label', label)
    button.title = label
  }

  function waveformSkipIcon(button) {
    button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 5 8 7-8 7V5zm8 0 8 7-8 7V5z"/></svg><span>5</span>'
    button.setAttribute('aria-label', 'Skip forward 5 seconds')
    button.title = 'Skip forward 5 seconds'
  }

  function setWaveformBusy(waveform, spinner, button, busy) {
    spinner.hidden = !busy
    waveform.setAttribute('aria-busy', String(busy))
    button.classList.toggle('is-loading', busy)
    button.setAttribute('aria-busy', String(busy))
  }

  function seekArchiveAudio(audio, targetSeconds, fallbackDuration) {
    const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : fallbackDuration
    audio.currentTime = Math.max(0, Math.min(duration, targetSeconds))
    return audio.currentTime
  }

  function showArchivePlaybackError(status, error) {
    if (!status) return
    status.textContent = error ? 'Playback could not start. Tap Play to try again.' : ''
  }

  function playArchiveAudio(audio, status, onBusy) {
    const request = onBusy?.(true)
    try {
      void audio.play().catch((error) => {
        if (error?.name === 'AbortError') {
          onBusy?.(false, request)
          return
        }
        const current = onBusy ? onBusy(false, request) : true
        if (current !== false) showArchivePlaybackError(status, error)
      })
    } catch (error) {
      const current = onBusy ? onBusy(false, request) : true
      if (current !== false) showArchivePlaybackError(status, error)
    }
  }

  function activateArchivePlayback(details, audio, updatePlayback) {
    if (!details.open || audio.dataset.archivePlaybackActivated === 'true') return false
    audio.dataset.archivePlaybackActivated = 'true'
    audio.preload = 'metadata'
    updatePlayback()
    return true
  }

  function beginArchivePlayback(details, audio, updatePlayback, loadWaveform, status, onBusy) {
    if (audio.dataset.archivePlaybackActivated === 'true') return false
    if (!activateArchivePlayback(details, audio, updatePlayback)) return false
    loadWaveform()
    playArchiveAudio(audio, status, onBusy)
    return true
  }

  function bindArchivePlaybackButton(button, details, audio, updatePlayback, loadWaveform, status, onBusy, isBusy) {
    button.addEventListener('click', () => {
      if (audio.dataset.archivePlaybackActivated === 'true') {
        if (isBusy?.() && audio.paused) {
          onBusy?.(false)
          audio.dataset.archiveReloading = 'false'
          audio.pause()
        } else if (audio.paused) playArchiveAudio(audio, status, onBusy)
        else {
          onBusy?.(false)
          audio.pause()
        }
        return
      }
      beginArchivePlayback(details, audio, updatePlayback, loadWaveform, status, onBusy)
    })
  }

  function bindArchiveSkipButton(button, details, audio, updatePlayback, loadWaveform, durationSeconds) {
    button.addEventListener('click', () => {
      const seekForward = () => seekArchiveAudio(audio, audio.currentTime + 5, durationSeconds)
      if (audio.dataset.archivePlaybackActivated === 'true') {
        if (audio.readyState >= 1) seekForward()
        else audio.addEventListener('loadedmetadata', seekForward, { once: true })
        return
      }
      if (!details.open) return
      audio.addEventListener('loadedmetadata', seekForward, { once: true })
      if (!activateArchivePlayback(details, audio, updatePlayback)) return
      loadWaveform()
    })
  }

  function bindArchiveWaveformSeek(range, details, audio, updatePlayback, loadWaveform, durationSeconds) {
    const seekWhenReady = () => {
      const targetSeconds = Number(range.value)
      if (audio.readyState >= 1) {
        seekArchiveAudio(audio, targetSeconds, durationSeconds)
        return
      }
      range.dataset.pendingSeekSeconds = String(targetSeconds)
      if (range.dataset.seekPending === 'true') return
      range.dataset.seekPending = 'true'
      audio.addEventListener('loadedmetadata', () => {
        range.dataset.seekPending = 'false'
        seekArchiveAudio(audio, Number(range.dataset.pendingSeekSeconds), durationSeconds)
      }, { once: true })
    }
    range.addEventListener('input', () => {
      if (audio.dataset.archivePlaybackActivated !== 'true') {
        if (!activateArchivePlayback(details, audio, updatePlayback)) return
        loadWaveform()
      }
      seekWhenReady()
    })
  }

  function pauseOtherAudio(activeAudio) {
    for (const audio of document.querySelectorAll('audio')) {
      if (audio === activeAudio) continue
      if (audio === liveAudio && liveListening) {
        stopLiveListening('Live audio stopped while another recording plays.')
        continue
      }
      if (!audio.paused) {
        if (audio === timelineAudio) timelineAutoAdvance = false
        audio.pause()
      }
    }
  }

  function stopLiveListening(message = 'Live audio stopped.') {
    liveAudioGeneration += 1
    liveListening = false
    liveAudio.pause()
    liveAudio.removeAttribute('src')
    liveAudio.load()
    liveAudioSource = undefined
    liveListen.textContent = 'Listen live'
    liveListen.setAttribute('aria-pressed', 'false')
    liveListenStatus.textContent = message
  }

  function startLiveListening() {
    if (!timelineActiveSlotAChannel) {
      liveListenStatus.textContent = 'Receiver status is not ready yet.'
      return
    }
    if (liveListening) stopLiveListening('Refreshing live audio settings…')
    pauseOtherAudio(liveAudio)
    const params = new URLSearchParams({
      squelch: replaySquelch.value,
      cleanup: timelineCleanup.value,
      quieting: '100'
    })
    const source = `${API}live.wav?${params}`
    const generation = ++liveAudioGeneration
    liveAudioSource = source
    liveAudio.src = source
    liveAudio.load()
    liveListening = true
    liveListen.textContent = `Stop live · ${channelDisplay(timelineActiveSlotAChannel)}`
    liveListen.setAttribute('aria-pressed', 'true')
    liveListenStatus.textContent = `Listening live on ${channelDisplay(timelineActiveSlotAChannel)}.`
    void liveAudio.play().catch((error) => {
      if (error?.name === 'AbortError' || generation !== liveAudioGeneration) return
      if (liveListening && liveAudioSource === source) stopLiveListening('Live audio could not start. Tap Listen live to try again.')
    })
  }

  function sessionRenderSignature(sessions, includeTranscript = false) {
    return JSON.stringify(sessions.map((session) => ({
      ids: session.ids,
      durationSeconds: session.durationSeconds,
      ...(includeTranscript ? {
        transcript: session.transcript,
        transcription: session.transcription
      } : {})
    })))
  }

  function channelFrequency(channelId) {
    return channels.find((channel) => channel.id === channelId)?.frequencyHz
  }

  function rfStrength(segment) {
    const noise = segment.minimumDiscriminatorNoise
    return noise === undefined ? 0.45 : Math.max(0, Math.min(1, (0.5 - noise) / 0.45))
  }

  function radioStrength(segment, activity) {
    return Math.max(0.12, Math.min(1, activity * 0.65 + rfStrength(segment) * 0.35))
  }

  function activityRuns(segment) {
    if (!Array.isArray(segment.activity) || segment.activity.length === 0) return []
    let start = -1
    let end = -1
    let maximum = 0
    for (const [index, value] of segment.activity.entries()) {
      if (value <= 0) continue
      if (start < 0) start = index
      end = index + 1
      maximum = Math.max(maximum, value)
    }
    return start < 0 ? [] : [{ start, end, activity: maximum }]
  }

  function highlightFrequencyBurst() {
    for (const burst of frequencyMap.querySelectorAll('.frequency-burst')) {
      burst.classList.toggle('selected', burst.dataset.segmentId === String(timelineSegmentId))
    }
  }

  function selectNonAudioMoment(timestamp, description) {
    timelineSelectionVersion += 1
    timelineWaveformController?.abort()
    timelineQueue = []
    timelineQueueIndex = -1
    timelineSegmentId = undefined
    timelineAudio.pause()
    timelineAudio.removeAttribute('src')
    timelineAudio.load()
    timelineAudioSource = undefined
    timelineSeek.disabled = true
    timelinePlay.disabled = true
    timelineSkip.disabled = true
    destroyTimelineWaveform()
    timelineWaveformHover.hidden = true
    timelineWaveformTrack.onpointermove = null
    timelineWaveformTrack.onpointerleave = null
    timelinePlaybackStatus.textContent = ''
    timelineWaveformLoading.textContent = 'Select a recording to load its waveform…'
    timelineWaveformLoading.hidden = false
    timelineTime.textContent = new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    timelineOffset.textContent = `${description} · no playable voice was captured`
    timelineLatest.textContent = 'Latest'
    timelineLatest.setAttribute('aria-pressed', 'false')
  }

  function renderFrequencyMap() {
    const endTime = Date.now()
    const startTime = endTime - timelineWindowMinutes * 60_000
    const timeSpan = endTime - startTime
    const rows = new Map()

    const ensureRow = (channel, frequencyHz) => {
      const key = String(frequencyHz || channel)
      if (!rows.has(key)) rows.set(key, { channel, frequencyHz, marks: [], floorMarks: [], rfMarks: [], dscMarks: [], monitoredSlots: new Set() })
      return rows.get(key)
    }

    for (const receiver of timelineReceiverRows) {
      const row = ensureRow(receiver.channel, receiver.frequencyHz)
      if (receiver.slot !== 'RF') row.monitoredSlots.add(receiver.slot)
      row.liveScore = Math.max(row.liveScore || 0, receiver.liveScore || 0)
    }

    for (const [segmentIndex, segment] of replayTimeline.entries()) {
      const frequencyHz = channelFrequency(segment.channel)
      const row = ensureRow(segment.channel, frequencyHz)
      const segmentStart = Date.parse(segment.startedAt)
      const segmentDuration = Math.max(1, segment.durationSeconds * 1000)
      const segmentEnd = segmentStart + segmentDuration
      if (segment.minimumDiscriminatorNoise !== undefined && segmentEnd >= startTime && segmentStart <= endTime) {
        row.floorMarks.push({ segmentStart, segmentEnd, strength: rfStrength(segment) })
      }
      for (const run of activityRuns(segment)) {
        const runStart = segmentStart + segmentDuration * run.start / segment.activity.length
        const runEnd = segmentStart + segmentDuration * run.end / segment.activity.length
        if (runEnd < startTime || runStart > endTime) continue
        row.marks.push({ segment, segmentIndex, runStart, runEnd, activity: run.activity })
      }
    }

    for (const event of spectrumTimeline) {
      const eventStart = Date.parse(event.startedAt)
      const eventEnd = event.endedAt ? Date.parse(event.endedAt) : endTime
      if (eventEnd < startTime || eventStart > endTime) continue
      ensureRow(event.channel, event.frequencyHz).rfMarks.push({ eventStart, eventEnd, score: event.score, open: !event.endedAt })
    }

    for (const message of dscTimeline) {
      const receivedAt = Date.parse(message.receivedAt)
      if (receivedAt < startTime || receivedAt > endTime) continue
      ensureRow('70', 156_525_000).dscMarks.push({ receivedAt, message })
    }

    const visibleRows = [...rows.values()]
      .sort((left, right) => (left.frequencyHz || Number.MAX_SAFE_INTEGER) - (right.frequencyHz || Number.MAX_SAFE_INTEGER))

    const rowElements = visibleRows.map((row) => {
      const wrapper = document.createElement('div')
      wrapper.className = 'frequency-row'
      const label = document.createElement('div')
      label.className = 'frequency-label'
      const channel = document.createElement('strong')
      channel.textContent = channelDisplay(row.channel)
      const frequency = document.createElement('span')
      const kinds = [
        row.rfMarks.length > 0 ? 'RF' : '',
        row.marks.length > 0 ? 'voice' : '',
        row.dscMarks.length > 0 ? 'DSC' : '',
        row.monitoredSlots.size > 0 ? `Slot ${[...row.monitoredSlots].join('+')}` : ''
      ].filter(Boolean)
      frequency.textContent = row.frequencyHz
        ? `${(row.frequencyHz / 1_000_000).toFixed(3)} MHz${kinds.length ? ` · ${kinds.join(' · ')}` : ''}`
        : 'Frequency unavailable'
      label.append(channel, frequency)
      const track = document.createElement('div')
      track.className = 'frequency-track'
      track.setAttribute('aria-label', `${row.rfMarks.length} RF events, ${row.marks.length} playable voice events, ${row.dscMarks.length} DSC calls`)
      if (row.liveScore) {
        const live = document.createElement('span')
        live.className = 'frequency-live'
        live.title = 'Wideband activity detected now; an available voice slot will record it'
        track.append(live)
      }
      for (const floor of row.floorMarks) {
        const left = Math.max(0, Math.min(100, (floor.segmentStart - startTime) / timeSpan * 100))
        const right = Math.max(left, Math.min(100, (floor.segmentEnd - startTime) / timeSpan * 100))
        const trace = document.createElement('button')
        trace.type = 'button'
        trace.className = 'frequency-floor'
        trace.setAttribute('aria-hidden', 'true')
        trace.style.setProperty('--burst-left', `${left}%`)
        trace.style.setProperty('--burst-width', `${Math.max(0.08, right - left)}%`)
        trace.style.setProperty('--floor-opacity', (0.05 + floor.strength * 0.2).toFixed(2))
        track.append(trace)
      }
      for (const mark of row.rfMarks) {
        const left = Math.max(0, Math.min(100, (mark.eventStart - startTime) / timeSpan * 100))
        const right = Math.max(left, Math.min(100, (mark.eventEnd - startTime) / timeSpan * 100))
        const trace = document.createElement('span')
        trace.className = `frequency-rf${mark.open ? ' active' : ''}`
        trace.style.setProperty('--burst-left', `${left}%`)
        trace.style.setProperty('--burst-width', `${Math.max(0.08, right - left)}%`)
        const at = new Date(mark.eventStart).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
        trace.title = `RF detected at ${at} · score ${mark.score.toFixed(2)}${mark.open ? ' · active now' : ''}`
        trace.setAttribute('aria-label', `${channelDisplay(row.channel)} RF detected at ${at}; no playable voice capture`)
        trace.addEventListener('click', () => selectNonAudioMoment(mark.eventStart, `${channelDisplay(row.channel)} · RF detected`))
        track.append(trace)
      }
      for (const mark of row.dscMarks) {
        const left = Math.max(0, Math.min(100, (mark.receivedAt - startTime) / timeSpan * 100))
        const trace = document.createElement('button')
        trace.type = 'button'
        trace.className = 'frequency-dsc'
        trace.style.setProperty('--burst-left', `${left}%`)
        const at = new Date(mark.receivedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
        trace.title = `DSC ${mark.message.category || 'call'} decoded at ${at}`
        trace.setAttribute('aria-label', `Channel 70 DSC ${mark.message.category || 'call'} decoded at ${at}`)
        trace.addEventListener('click', () => selectNonAudioMoment(mark.receivedAt, `CH 70 · DSC ${mark.message.category || 'call'} decoded`))
        track.append(trace)
      }
      for (const mark of row.marks) {
        const left = Math.max(0, Math.min(100, (mark.runStart - startTime) / timeSpan * 100))
        const right = Math.max(left, Math.min(100, (mark.runEnd - startTime) / timeSpan * 100))
        const strength = radioStrength(mark.segment, mark.activity)
        const button = document.createElement('button')
        button.className = 'frequency-burst'
        button.type = 'button'
        button.dataset.segmentId = String(mark.segment.id)
        button.style.setProperty('--burst-left', `${left}%`)
        button.style.setProperty('--burst-width', `${Math.max(0.08, right - left)}%`)
        button.style.setProperty('--burst-strength', strength.toFixed(2))
        button.style.setProperty('--burst-opacity', (0.16 + strength * 0.84).toFixed(2))
        button.style.setProperty('--burst-glow', `${(4 + strength * 10).toFixed(1)}px`)
        const time = new Date(mark.runStart).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
        button.setAttribute('aria-label', `Listen to Slot ${mark.segment.slot}, ${channelDisplay(row.channel)}, ${frequency.textContent}, voice captured at ${time}`)
        button.addEventListener('click', () => {
          selectTimelineIndex(mark.segmentIndex, true)
        })
        track.append(button)
      }
      wrapper.append(label, track)
      return wrapper
    })
    frequencyMap.replaceChildren(...rowElements)
    const hasActivity = visibleRows.some((row) => row.marks.length > 0 || row.rfMarks.length > 0 || row.dscMarks.length > 0)
    frequencyMap.hidden = visibleRows.length === 0
    frequencyEmpty.hidden = hasActivity
    frequencyEmpty.textContent = visibleRows.length === 0
      ? 'Starting receiver…'
      : 'Listening — no RF, voice, or DSC activity yet.'
    highlightFrequencyBurst()
  }

  function sortHistoricalReplaySegments(segments) {
    return segments.slice().sort((left, right) => {
      const timeDifference = Date.parse(left.startedAt) - Date.parse(right.startedAt)
      if (Number.isFinite(timeDifference) && timeDifference !== 0) return timeDifference
      const slotDifference = String(left.slot).localeCompare(String(right.slot))
      if (slotDifference !== 0) return slotDifference
      return String(left.id).localeCompare(String(right.id), undefined, { numeric: true })
    })
  }

  function historicalReplayQueue(segments, startId) {
    const ordered = sortHistoricalReplaySegments(segments)
    const startIndex = ordered.findIndex((segment) => String(segment.id) === String(startId))
    return startIndex < 0 ? [] : ordered.slice(startIndex).map((segment) => ({ ...segment }))
  }

  function timelineClipUrl(segment, version) {
    const snapshot = segment.endedAt || segment.updatedAt || segment.startedAt
    const params = new URLSearchParams({
      cleanup: timelineCleanup.value,
      quieting: '100',
      squelch: replaySquelch.value,
      snapshot: snapshot || '',
      selection: String(version)
    })
    return `${API}replay/${encodeURIComponent(segment.id)}.wav?${params}`
  }

  function timelineWaveformUrl(segment, version) {
    const params = new URLSearchParams({ cleanup: 'raw', quieting: '100', squelch: '0', snapshot: segment.endedAt || segment.updatedAt || segment.startedAt || '', selection: String(version) })
    return `${API}replay/${encodeURIComponent(segment.id)}.wav?${params}`
  }

  function timelineDuration(segment) {
    return Math.max(0.1, Number(segment.durationSeconds || segment.duration || segment.audioDurationSeconds || 0.1))
  }

  function timelineQueueSegment(index) {
    const segment = timelineQueue[index]
    if (!segment) return
    timelineQueueIndex = index
    timelineSegmentId = segment.id
    const startedAt = new Date(segment.startedAt)
    const ageMinutes = Math.max(0, Math.round((Date.now() - startedAt.getTime()) / 60_000))
    const currentIndex = replayTimeline.findIndex((item) => String(item.id) === String(segment.id))
    if (currentIndex >= 0) timelineRange.value = String(currentIndex)
    timelineTime.textContent = startedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    timelineOffset.textContent = `${ageMinutes === 0 ? 'Less than a minute' : `${ageMinutes} min`} ago · Slot ${segment.slot} · ${channelDisplay(segment.channel)} · ${channelFrequencyDisplay(segment.channel)}`
    timelineAudio.pause()
    timelineAutoAdvance = false
    timelinePlaybackRequested = false
    timelineBusyVersion += 1
    setWaveformBusy($('#timeline-waveform'), timelineWaveformSpinner, timelinePlay, false)
    timelineAudio.removeAttribute('src')
    timelineAudio.load()
    timelineAudioSource = undefined
    timelinePendingSeek = undefined
    timelineMetadataSource = undefined
    destroyTimelineWaveform()
    timelineSeek.disabled = false
    timelineSeek.min = '0'
    timelineSeek.max = String(timelineDuration(segment))
    timelineSeek.value = '0'
    waveformPlayIcon(timelinePlay, false)
    timelinePlaybackStatus.textContent = ''
    timelinePlaybackTime.textContent = `0:00 / ${archiveTimeLabel(timelineDuration(segment))}`
    timelinePlay.disabled = false
    timelineSkip.disabled = false
    timelineLatest.textContent = 'Latest'
    timelineLatest.setAttribute('aria-pressed', 'false')
    renderTimelineWaveform(segment, timelineSelectionVersion)
    highlightFrequencyBurst()
  }

  function renderTimelineWaveform(segment, version) {
    destroyTimelineWaveform()
    timelineWaveformController = new AbortController()
    const { signal } = timelineWaveformController
    timelineWaveformLoading.textContent = 'Loading waveform…'
    timelineWaveformLoading.hidden = false
    void fetch(timelineWaveformUrl(segment, version), { credentials: 'include', signal }).then(async (response) => {
      if (!response.ok) throw new Error(`Waveform request failed (${response.status})`)
      return wavSamples(await response.arrayBuffer())
    }).then(({ view, offset, samples, sampleRate }) => {
      if (signal.aborted || version !== timelineSelectionVersion) return
      timelineWaveSurfer = createWaveform(timelineWaveformTrack, timelineAudio, { view, offset, samples }, sampleRate > 0 ? samples / sampleRate : timelineDuration(segment))
      timelineWaveSurfer.on('interaction', (time) => seekTimelineAudio(time))
      const duration = sampleRate > 0 ? samples / sampleRate : timelineDuration(segment)
      timelineSeek.max = String(duration)
      timelineWaveformTrack.onpointermove = (event) => showWaveformHover(timelineWaveformTrack, timelineWaveformHover, duration, (offsetSeconds) => timelineClockAtOffset(segment, offsetSeconds), event)
      timelineWaveformTrack.onpointerleave = () => { timelineWaveformHover.hidden = true }
      timelineWaveformLoading.hidden = true
    }).catch((error) => {
      if (signal.aborted || version !== timelineSelectionVersion) return
      timelineWaveformLoading.textContent = 'Waveform unavailable'
      timelineWaveformLoading.hidden = false
      timelinePlaybackStatus.textContent = 'Waveform unavailable. Playback may still work.'
    })
  }

  function updateTimelinePlayback() {
    const duration = Number.isFinite(timelineAudio.duration) && timelineAudio.duration > 0
      ? timelineAudio.duration
      : timelineQueueIndex >= 0 ? timelineDuration(timelineQueue[timelineQueueIndex]) : 0
    const currentTime = Math.max(0, Math.min(duration, timelineAudio.currentTime || 0))
    timelineSeek.max = String(Math.max(0.1, duration))
    timelineSeek.value = String(currentTime)
    timelineSeek.setAttribute('aria-valuetext', `${archiveTimeLabel(currentTime)} of ${archiveTimeLabel(duration)}`)
    timelinePlaybackTime.textContent = `${archiveTimeLabel(currentTime)} / ${archiveTimeLabel(duration)}`
    waveformPlayIcon(timelinePlay, !timelineAudio.paused)
  }

  function loadTimelineAudio(segment, autoplay = false, targetTime) {
    const generation = ++timelinePlaybackGeneration
    const source = timelineClipUrl(segment, timelineSelectionVersion)
    const version = timelineSelectionVersion
    if (timelineAudioSource !== source) {
      timelineBusyVersion += 1
      timelinePlaybackRequested = false
      setWaveformBusy($('#timeline-waveform'), timelineWaveformSpinner, timelinePlay, false)
      timelineAudioSource = source
      timelinePendingSeek = undefined
      timelineMetadataSource = undefined
      timelineAudio.src = source
      timelineAudio.load()
    }
    if (targetTime !== undefined) {
      const seek = () => {
        if (timelineAudioSource !== source || timelineSelectionVersion !== version) return
        timelineAudio.currentTime = Math.max(0, Math.min(timelineAudio.duration || timelineDuration(segment), targetTime))
      }
      if (timelineAudio.readyState >= 1) seek()
      else {
        timelinePendingSeek = { source, version, segment, targetTime }
        if (timelineMetadataSource !== source) {
          timelineMetadataSource = source
          timelineAudio.addEventListener('loadedmetadata', () => {
            if (timelineMetadataSource === source) timelineMetadataSource = undefined
            const pending = timelinePendingSeek
            if (pending?.source !== source || pending.version !== timelineSelectionVersion || timelineAudioSource !== source) return
            timelineAudio.currentTime = Math.max(0, Math.min(timelineAudio.duration || timelineDuration(pending.segment), pending.targetTime))
            timelinePendingSeek = undefined
          }, { once: true })
        }
      }
    }
    if (autoplay) {
      timelineAutoAdvance = true
      timelinePlaybackRequested = true
      const busyVersion = timelineBusyVersion
      setWaveformBusy($('#timeline-waveform'), timelineWaveformSpinner, timelinePlay, true)
      void timelineAudio.play().catch((error) => {
        if (error?.name === 'AbortError' || generation !== timelinePlaybackGeneration) return
        if (timelineAudioSource === source && timelineSelectionVersion === version) {
          timelineAutoAdvance = false
          timelinePlaybackRequested = false
          if (busyVersion === timelineBusyVersion) setWaveformBusy($('#timeline-waveform'), timelineWaveformSpinner, timelinePlay, false)
          timelinePlaybackStatus.textContent = 'Playback could not start. Tap Play to try again.'
        }
      })
    }
  }

  function seekTimelineAudio(targetTime) {
    const segment = timelineQueue[timelineQueueIndex]
    if (!segment) return
    loadTimelineAudio(segment, false, targetTime)
  }

  function refreshTimelineAudio() {
    const segment = timelineQueue[timelineQueueIndex]
    if (!segment || !timelineAudioSource) return
    const currentTime = timelineAudio.currentTime || 0
    const wasPlaying = !timelineAudio.paused
    timelineAudioSource = undefined
    loadTimelineAudio(segment, wasPlaying, currentTime)
  }

  function selectTimelineIndex(requestedIndex, autoplay = false, snapshotQueue = true) {
    if (replayTimeline.length === 0) return
    const index = Math.max(0, Math.min(replayTimeline.length - 1, requestedIndex))
    const segment = replayTimeline[index]
    if (snapshotQueue) {
      timelineSelectionVersion += 1
      timelineQueue = historicalReplayQueue(replayTimeline, segment.id)
      timelineQueueIndex = 0
    }
    const queueIndex = snapshotQueue ? 0 : timelineQueue.findIndex((item) => String(item.id) === String(segment.id))
    if (queueIndex >= 0) timelineQueueSegment(queueIndex)
    if (autoplay && queueIndex >= 0) loadTimelineAudio(timelineQueue[queueIndex], true)
  }

  function selectLatestActiveTimeline(autoplay = false) {
    if (replayTimeline.length === 0) return
    selectTimelineIndex(replayTimeline.length - 1, autoplay)
  }

  function updateTimeline(segments) {
    replayTimeline = sortHistoricalReplaySegments(segments)
    timelineRange.disabled = replayTimeline.length === 0
    timelineRange.max = String(Math.max(0, replayTimeline.length - 1))
    timelineLatest.disabled = replayTimeline.length === 0
    if (replayTimeline.length === 0) {
      if (timelineQueue.length === 0) {
        timelineAudio.removeAttribute('src')
        timelineAudio.load()
        timelineSegmentId = undefined
        timelineTime.textContent = 'Waiting for audio…'
        timelineOffset.textContent = 'The rolling buffer is filling.'
        timelineWaveformLoading.textContent = 'Select a recording to load its waveform…'
        timelineWaveformLoading.hidden = false
      }
      renderFrequencyMap()
      return
    }
    const oldest = new Date(replayTimeline[0].startedAt)
    timelineOldest.textContent = oldest.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    const selectedIndex = replayTimeline.findIndex((segment) => String(segment.id) === String(timelineSegmentId))
    if (selectedIndex >= 0) timelineRange.value = String(selectedIndex)
    else if (!timelineSegmentId) selectLatestActiveTimeline()
    renderFrequencyMap()
  }

  async function updateReplay() {
    try {
      const { segments } = await request(`replay?squelch=${encodeURIComponent(replaySquelch.value)}`)
      updateTimeline(segments)
      const sessions = groupReplaySessions(segments)
      const visibleSessions = sessions.filter((session) => {
        const activeSeconds = replayActiveSeconds(session)
        return activeSeconds === undefined || activeSeconds >= MINIMUM_REPLAY_SIGNAL_SECONDS
      })
      voiceEventSummary.textContent = String(visibleSessions.length)
      renderProcessingQueue(sessions.filter((session) => ['queued', 'transcribing', 'error'].includes(session.transcription?.status)))
    } catch (error) {
      setConnection('error', error.message)
    }
  }

  async function updateSpectrumActivity() {
    try {
      const { events } = await request('activity')
      spectrumTimeline = events
      renderFrequencyMap()
    } catch (error) {
      setConnection('error', error.message)
    }
  }

  function renderProcessingQueue(sessions) {
    processingPanel.hidden = sessions.length === 0
    processingCount.textContent = String(sessions.length)
    processingList.replaceChildren(...sessions.map((session) => {
      const item = document.createElement('li')
      const description = document.createElement('span')
      const state = session.transcription.status === 'error'
        ? `Error · ${session.transcription.error || 'transcription failed'}`
        : session.transcription.status === 'queued' ? 'Queued' : 'Transcribing'
      description.textContent = `${new Date(session.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })} · ${channelDisplay(session.channel)} · ${state}`
      const remove = document.createElement('button')
      remove.type = 'button'
      remove.textContent = 'Remove'
      remove.addEventListener('click', async () => {
        remove.disabled = true
        try {
          await Promise.all(session.ids.map((id) => request(`replay/${id}`, { method: 'DELETE' })))
          await updateReplay()
        } catch (error) {
          setConnection('error', error.message)
          remove.disabled = false
        }
      })
      item.append(description, remove)
      return item
    }))
  }

  function dscRow(message) {
    const item = document.createElement('li')
    const category = ['distress', 'urgency', 'safety', 'routine'].includes(message.category)
      ? message.category
      : 'unknown'
    item.className = `dsc-item dsc-${category}`
    const time = document.createElement('time')
    time.dateTime = message.receivedAt
    time.textContent = new Date(message.receivedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    const summary = document.createElement('div')
    summary.className = 'dsc-summary'
    const identity = document.createElement('div')
    identity.className = 'dsc-identity'
    const name = document.createElement('strong')
    name.className = 'dsc-caller-name'
    name.textContent = message.callerName || message.callerCallsign || (message.selfMmsi ? `MMSI ${message.selfMmsi}` : 'Unknown station')
    const identifiers = document.createElement('span')
    identifiers.className = 'dsc-caller-identifiers'
    identifiers.textContent = [
      message.callerName && message.callerCallsign,
      (message.callerName || message.callerCallsign) && message.selfMmsi ? `[MMSI ${message.selfMmsi}]` : ''
    ].filter(Boolean).join(' · ')
    identity.append(name)
    if (identifiers.textContent) identity.append(identifiers)

    const classification = document.createElement('div')
    classification.className = 'dsc-classification'
    const categoryLabel = document.createElement('span')
    categoryLabel.className = 'dsc-category'
    categoryLabel.textContent = category.toUpperCase()
    const formatLabel = document.createElement('span')
    formatLabel.className = 'dsc-format'
    formatLabel.textContent = message.format || 'unknown format'
    classification.append(categoryLabel, formatLabel)
    if (!message.validCharacters) {
      const decodeWarning = document.createElement('span')
      decodeWarning.className = 'dsc-decode-warning'
      decodeWarning.textContent = 'Check decode'
      classification.append(decodeWarning)
    }
    summary.append(identity, classification)

    const details = document.createElement('dl')
    details.className = 'dsc-details'
    const addDetail = (label, value, className = '') => {
      if (value === undefined || value === null || value === '') return
      const row = document.createElement('div')
      if (className) row.className = className
      const term = document.createElement('dt')
      term.textContent = label
      const description = document.createElement('dd')
      description.textContent = value
      row.append(term, description)
      details.append(row)
    }
    addDetail('Destination', message.targetMmsi ? `MMSI ${message.targetMmsi}` : '', 'dsc-destination')
    addDetail('Nature', message.nature, 'dsc-nature')
    addDetail('Position', message.position
      && Number.isFinite(message.position.latitude)
      && Number.isFinite(message.position.longitude)
      ? `${message.position.latitude.toFixed(4)}, ${message.position.longitude.toFixed(4)}`
      : '', 'dsc-position')
    addDetail('Reported', message.timeUtc ? `${message.timeUtc} UTC` : '')

    item.append(time, summary)
    if (details.childElementCount) item.append(details)
    return item
  }

  async function updateDsc() {
    try {
      const { messages } = await request('dsc')
      dscTimeline = messages
      dscList.replaceChildren(...messages.map(dscRow))
      dscCallCount.textContent = String(messages.length)
      dscEmpty.hidden = messages.length > 0
      dscEmpty.textContent = 'Waiting for a decoded DSC call…'
      renderFrequencyMap()
    } catch (error) {
      dscEmpty.hidden = false
      dscEmpty.textContent = error.message
    }
  }

  function transcriptMomentId(entry) {
    return `transcript-${entry.id}`
  }

  function archiveOffsetSeconds(record, entry) {
    let offset = 0
    for (const candidate of record.records) {
      if (candidate.id === entry.id) break
      offset += archivePlaybackDuration(candidate)
    }
    return offset
  }

  function selectTranscriptMoment(details, entryId, offsetSeconds, autoplay) {
    for (const line of details.querySelectorAll('.archive-log-line')) line.classList.toggle('is-selected', line.id === `transcript-${entryId}`)
    const audio = details.querySelector('audio')
    const seek = () => {
      audio.currentTime = Math.min(offsetSeconds, Number.isFinite(audio.duration) ? audio.duration : offsetSeconds)
      if (autoplay) void audio.play().catch(() => {})
    }
    if (audio.readyState >= 1) seek()
    else audio.addEventListener('loadedmetadata', seek, { once: true })
  }

  function bindTranscriptMoment(link, details, entry, offsetSeconds, updatePlayback) {
    link.addEventListener('click', (event) => {
      event.preventDefault()
      details.open = true
      window.history.pushState(null, '', link.hash)
      activateArchivePlayback(details, details.querySelector('audio'), updatePlayback)
      selectTranscriptMoment(details, entry.id, offsetSeconds, true)
      document.getElementById(transcriptMomentId(entry))?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    })
  }

  function wavSamples(arrayBuffer) {
    const view = new DataView(arrayBuffer)
    if (view.byteLength < 44) throw new Error('WAV header is incomplete')
    let offset = 12
    while (offset + 8 <= view.byteLength) {
      const chunk = String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3))
      const length = view.getUint32(offset + 4, true)
      if (offset + 8 + length > view.byteLength) throw new Error('WAV data chunk is truncated')
      if (chunk === 'data') {
        const sampleRate = view.getUint32(24, true)
        if (sampleRate <= 0 || length % 2 !== 0) throw new Error('WAV data format is invalid')
        return { view, offset: offset + 8, samples: Math.floor(length / 2), sampleRate }
      }
      offset += 8 + length + (length % 2)
    }
    throw new Error('WAV data chunk is missing')
  }

  function createWaveform(container, audio, decoded, duration, onInteraction) {
    const { view, offset, samples } = decoded
    const binCount = Math.min(160, Math.max(1, samples))
    const peaks = new Float32Array(binCount)
    let maximum = 0
    for (let bin = 0; bin < binCount; bin += 1) {
      const start = Math.floor(samples * bin / binCount)
      const end = Math.max(start + 1, Math.floor(samples * (bin + 1) / binCount))
      let peak = 0
      const stride = Math.max(1, Math.floor((end - start) / 80))
      for (let sample = start; sample < end; sample += stride) peak = Math.max(peak, Math.abs(view.getInt16(offset + sample * 2, true)))
      peaks[bin] = peak / 32768
      maximum = Math.max(maximum, peaks[bin])
    }
    if (maximum > 0) for (let bin = 0; bin < peaks.length; bin += 1) peaks[bin] /= maximum
    const instance = window.WaveSurfer.create({
      container,
      media: audio,
      peaks: [peaks],
      duration,
      height: 58,
      barWidth: 3,
      barGap: 2,
      barRadius: 2,
      normalize: true,
      dragToSeek: true,
      waveColor: 'rgba(25, 122, 104, 0.72)',
      progressColor: 'rgba(25, 122, 104, 0.24)',
      cursorColor: '#2767d8',
      cursorWidth: 2
    })
    container.setAttribute('aria-label', 'Audio waveform. Click or drag to seek.')
    if (onInteraction) instance.on('interaction', onInteraction)
    return instance
  }

  function destroyTimelineWaveform() {
    timelineWaveformController?.abort()
    timelineWaveformController = undefined
    timelineWaveSurfer?.destroy()
    timelineWaveSurfer = undefined
  }

  function destroyArchiveWaveforms() {
    for (const entry of archiveWaveSurfers.values()) {
      entry.controller?.abort()
      entry.instance?.destroy()
    }
    archiveWaveSurfers.clear()
  }

  async function renderArchiveWaveform(waveform, audioUrl, audio, fallbackDuration, onInteraction) {
    if (archiveWaveSurfers.has(waveform)) return
    const loading = waveform.querySelector('.waveform-loading')
    const controller = new AbortController()
    const entry = { controller, instance: null }
    archiveWaveSurfers.set(waveform, entry)
    if (loading) {
      loading.textContent = 'Loading waveform…'
      loading.hidden = false
    }
    try {
      const response = await fetch(`${audioUrl}&cleanup=raw&squelch=0&quieting=100`, { credentials: 'include', signal: controller.signal })
      if (!response.ok) throw new Error(`Waveform request failed (${response.status})`)
      const decoded = wavSamples(await response.arrayBuffer())
      if (controller.signal.aborted || !waveform.isConnected) return
      const duration = decoded.sampleRate > 0 ? decoded.samples / decoded.sampleRate : fallbackDuration
      entry.instance = createWaveform(waveform, audio, decoded, duration || fallbackDuration, onInteraction)
      const record = waveform.__record
      const hover = waveform.querySelector('.waveform-hover-time')
      if (record && hover) {
        waveform.onpointermove = (event) => showWaveformHover(waveform, hover, duration, (offsetSeconds) => archiveClockAtOffset(record, offsetSeconds), event)
        waveform.onpointerleave = () => { hover.hidden = true }
      }
      if (loading) loading.hidden = true
    } catch (error) {
      if (controller.signal.aborted) return
      archiveWaveSurfers.delete(waveform)
      if (loading) {
        loading.textContent = 'Waveform unavailable'
        loading.hidden = false
      }
    }
  }

  function setArchivePlayback(audio, download, cleanup, squelch, quieting, onBusy, status, isCurrent) {
    const currentTime = audio.currentTime
    const wasPlaying = !audio.paused
    const source = `${audio.dataset.baseUrl}&cleanup=${encodeURIComponent(cleanup)}&squelch=${encodeURIComponent(squelch)}&quieting=100`
    audio.src = source
    const normalizedSource = new URL(source, window.location.href).href
    download.href = source
    const request = wasPlaying ? onBusy?.(true) : undefined
    audio.dataset.archiveReloading = String(wasPlaying)
    audio.load()
    if (currentTime > 0 || wasPlaying) {
      audio.addEventListener('loadedmetadata', () => {
        if (audio.src !== normalizedSource) return
        if (wasPlaying && isCurrent && !isCurrent(request)) return
        audio.dataset.archiveReloading = 'false'
        audio.currentTime = Math.min(currentTime, Number.isFinite(audio.duration) ? audio.duration : currentTime)
        if (wasPlaying) playArchiveAudio(audio, status, (busy, token) => onBusy?.(busy, token ?? request))
      }, { once: true })
    }
  }

  function archiveRow(record) {
    const item = document.createElement('li')
    item.className = 'archive-item'
    const details = document.createElement('details')
    details.className = 'archive-details'
    details.dataset.sessionKey = record.ids.join(',')
    const summary = document.createElement('summary')
    summary.className = 'archive-summary-row'
    const time = document.createElement('time')
    time.className = 'archive-time'
    time.dateTime = record.startedAt
    time.textContent = new Date(record.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    const channel = document.createElement('strong')
    channel.textContent = channelDisplay(record.channel)
    const duration = document.createElement('span')
    duration.textContent = `${record.durationSeconds.toFixed(0)} sec`
    const count = document.createElement('span')
    count.textContent = `${record.records.length} transcript ${record.records.length === 1 ? 'line' : 'lines'}`
    summary.append(time, channel, duration, count)

    const body = document.createElement('div')
    body.className = 'archive-body'
    const originalAudioUrl = `${API}transcript-session.wav?ids=${encodeURIComponent(record.ids.join(','))}`
    const audioUrl = `${originalAudioUrl}&activity=1`
    const waveform = document.createElement('div')
    waveform.className = 'archive-waveform'
    const waveformTrack = document.createElement('div')
    waveformTrack.className = 'archive-waveform-track'
    waveformTrack.__record = record
    const loading = document.createElement('span')
    loading.className = 'waveform-loading'
    loading.textContent = 'Open to load waveform…'
    waveformTrack.append(loading)
    const hoverTime = document.createElement('span')
    hoverTime.className = 'waveform-hover-time'
    hoverTime.hidden = true
    hoverTime.setAttribute('aria-hidden', 'true')
    waveformTrack.append(hoverTime)
    const playbackSpinner = document.createElement('span')
    playbackSpinner.className = 'waveform-playback-spinner'
    playbackSpinner.hidden = true
    playbackSpinner.setAttribute('role', 'status')
    playbackSpinner.setAttribute('aria-label', 'Loading playback')
    waveformTrack.append(playbackSpinner)
    const seek = document.createElement('input')
    seek.className = 'archive-waveform-seek'
    seek.type = 'range'
    seek.min = '0'
    seek.max = String(Math.max(0.1, record.durationSeconds))
    seek.step = '0.1'
    seek.value = '0'
    seek.setAttribute('aria-label', 'Seek within recording')
    seek.setAttribute('aria-valuetext', `0:00 of ${archiveTimeLabel(record.durationSeconds)}`)
    waveformTrack.append(seek)
    waveform.append(waveformTrack)

    const audio = document.createElement('audio')
    audio.className = 'sr-only archive-audio-source'
    audio.setAttribute('aria-hidden', 'true')
    audio.preload = 'none'
    audio.dataset.baseUrl = audioUrl

    const transport = document.createElement('div')
    transport.className = 'archive-waveform-transport'
    const playButton = document.createElement('button')
    playButton.className = 'archive-waveform-button archive-waveform-play'
    playButton.type = 'button'
    waveformPlayIcon(playButton, false)
    const skipButton = document.createElement('button')
    skipButton.className = 'archive-waveform-button archive-waveform-skip'
    skipButton.type = 'button'
    waveformSkipIcon(skipButton)
    const playbackTime = document.createElement('output')
    playbackTime.className = 'archive-waveform-time'
    playbackTime.textContent = `0:00 / ${archiveTimeLabel(record.durationSeconds)}`
    const playbackStatus = document.createElement('span')
    playbackStatus.className = 'archive-waveform-status'
    playbackStatus.setAttribute('role', 'status')
    playbackStatus.setAttribute('aria-live', 'polite')
    transport.append(playButton, skipButton, playbackTime, playbackStatus)
    waveform.append(transport)

    const renderWaveformPlayback = () => {
      const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : record.durationSeconds
      const currentTime = Math.max(0, Math.min(duration, audio.currentTime || 0))
      seek.max = String(Math.max(0.1, duration))
      seek.value = String(currentTime)
      seek.setAttribute('aria-valuetext', `${archiveTimeLabel(currentTime)} of ${archiveTimeLabel(duration)}`)
      playbackTime.textContent = `${archiveTimeLabel(currentTime)} / ${archiveTimeLabel(duration)}`
      waveformPlayIcon(playButton, !audio.paused)
    }
    let playbackRequested = false
    let playbackGeneration = 0
    const setArchiveBusy = (busy) => {
      setWaveformBusy(waveform, playbackSpinner, playButton, busy)
      playButton.dataset.loading = String(busy)
    }
    const requestArchivePlayback = (busy, expectedGeneration) => {
      if (expectedGeneration !== undefined && expectedGeneration !== playbackGeneration) return false
      playbackGeneration += 1
      playbackRequested = busy
      setArchiveBusy(busy)
      return playbackGeneration
    }
    for (const event of ['loadedmetadata', 'durationchange', 'timeupdate', 'play', 'pause', 'ended', 'seeked']) {
      audio.addEventListener(event, renderWaveformPlayback)
    }
    audio.addEventListener('play', () => { playbackStatus.textContent = '' })
    audio.addEventListener('playing', () => { if (playbackRequested) setArchiveBusy(false) })
    audio.addEventListener('waiting', () => { if (playbackRequested && !audio.paused) setArchiveBusy(true) })
    audio.addEventListener('pause', () => { if (audio.paused && audio.dataset.archiveReloading !== 'true') { playbackGeneration += 1; playbackRequested = false; setArchiveBusy(false) } })
    audio.addEventListener('ended', () => { playbackRequested = false; setArchiveBusy(false) })
    audio.addEventListener('error', () => {
      playbackRequested = false
      setArchiveBusy(false)
      playbackStatus.textContent = 'Recording playback is unavailable.'
    })
    seek.addEventListener('input', renderWaveformPlayback)

    const controls = document.createElement('div')
    controls.className = 'archive-controls'
    const squelchLabel = document.createElement('label')
    squelchLabel.textContent = 'Raw playback squelch'
    const squelch = document.createElement('select')
    squelch.innerHTML = '<option value="0">Off / raw</option><option value="10">Low</option><option value="20" selected>Medium</option><option value="30">High</option><option value="40">Very high</option>'
    const preferenceKey = `archive:${record.ids.join(',')}`
    const preferredSquelch = storedPreference(`${preferenceKey}:squelch`, replaySquelch.value)
    if (squelch.querySelector(`option[value="${preferredSquelch}"]`)) squelch.value = preferredSquelch
    squelchLabel.append(squelch)
    const cleanupLabel = document.createElement('label')
    cleanupLabel.textContent = 'Background noise'
    const cleanup = document.createElement('select')
    cleanup.innerHTML = '<option value="raw">Raw</option><option value="modified" selected>Modified</option>'
    const preferredCleanup = playbackPreference(`${preferenceKey}:cleanup`, timelineCleanup.value)
    cleanup.value = preferredCleanup
    cleanupLabel.append(cleanup)
    controls.append(squelchLabel, cleanupLabel)

    const updatePlayback = () => {
      savePreference(`${preferenceKey}:cleanup`, cleanup.value)
      savePreference(`${preferenceKey}:squelch`, squelch.value)
      squelch.disabled = cleanup.value === 'modified'
      download.href = `${audio.dataset.baseUrl}&cleanup=${encodeURIComponent(cleanup.value)}&squelch=${encodeURIComponent(squelch.value)}&quieting=100`
      if (audio.dataset.archivePlaybackActivated === 'true') {
        requestArchivePlayback(false)
        setArchivePlayback(audio, download, cleanup.value, squelch.value, 100, requestArchivePlayback, playbackStatus, (token) => token === playbackGeneration)
      }
    }
    let pendingWaveformSeek
    let waveformSeekWaiting = false
    const seekFromWaveform = (targetTime) => {
      if (audio.dataset.archivePlaybackActivated !== 'true' && !activateArchivePlayback(details, audio, updatePlayback)) return
      if (audio.readyState >= 1) {
        seekArchiveAudio(audio, targetTime, record.durationSeconds)
        return
      }
      pendingWaveformSeek = targetTime
      if (waveformSeekWaiting) return
      waveformSeekWaiting = true
      audio.addEventListener('loadedmetadata', () => {
        waveformSeekWaiting = false
        seekArchiveAudio(audio, pendingWaveformSeek, record.durationSeconds)
      }, { once: true })
    }
    waveformTrack.addEventListener('pointerdown', (event) => {
      if (event.target instanceof Element && event.target.closest('.transcript-marker')) return
      if (details.open && audio.dataset.archivePlaybackActivated !== 'true') activateArchivePlayback(details, audio, updatePlayback)
    }, true)

    bindArchivePlaybackButton(playButton, details, audio, () => {
      updatePlayback()
      renderWaveformPlayback()
    }, () => { void renderArchiveWaveform(waveformTrack, audioUrl, audio, record.durationSeconds, seekFromWaveform) }, playbackStatus, requestArchivePlayback, () => playButton.dataset.loading === 'true')
    bindArchiveSkipButton(skipButton, details, audio, updatePlayback, () => {
      void renderArchiveWaveform(waveformTrack, audioUrl, audio, record.durationSeconds, seekFromWaveform)
    }, record.durationSeconds)
    bindArchiveWaveformSeek(seek, details, audio, updatePlayback, () => {
      void renderArchiveWaveform(waveformTrack, audioUrl, audio, record.durationSeconds, seekFromWaveform)
    }, record.durationSeconds)

    const log = document.createElement('div')
    log.className = 'archive-log'
    log.setAttribute('aria-label', `Full transcript for ${time.textContent}`)
    for (const entry of record.records) {
      const offsetSeconds = archiveOffsetSeconds(record, entry)
      const line = document.createElement('div')
      line.id = transcriptMomentId(entry)
      line.className = 'archive-log-line'
      const stamp = document.createElement('a')
      stamp.className = 'transcript-time-link'
      stamp.href = `#${line.id}`
      stamp.dataset.audioOffset = String(offsetSeconds)
      const activityStartedAt = new Date(Date.parse(entry.startedAt) + archiveActivityStart(entry) * 1_000)
      stamp.textContent = activityStartedAt.toLocaleString([], {
        month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
      })
      stamp.setAttribute('aria-label', `Play transcript from ${stamp.textContent}`)
      bindTranscriptMoment(stamp, details, entry, offsetSeconds, updatePlayback)
      const text = document.createElement('span')
      text.textContent = entry.transcript || '[no speech recognized]'
      line.append(stamp, text)
      log.append(line)

      const marker = document.createElement('a')
      marker.className = 'transcript-marker'
      marker.href = stamp.href
      marker.style.setProperty('--marker-left', `${Math.min(99.5, offsetSeconds / Math.max(1, record.durationSeconds) * 100)}%`)
      marker.setAttribute('aria-label', `Transcript marker at ${stamp.textContent}`)
      const markerLabel = document.createElement('span')
      markerLabel.textContent = activityStartedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      marker.append(markerLabel)
      bindTranscriptMoment(marker, details, entry, offsetSeconds, updatePlayback)
      waveformTrack.append(marker)
    }

    const metadata = document.createElement('dl')
    metadata.className = 'archive-metadata'
    const quality = record.minimumDiscriminatorNoise === undefined ? '' : ` · RF noise ${record.minimumDiscriminatorNoise.toFixed(2)}`
    const audioBytes = record.records.reduce((sum, entry) => sum + entry.audioBytes, 0)
    const compressedBytes = record.records.reduce((sum, entry) => sum + entry.compressedBytes, 0)
    const metadataRows = [
      ['Recording', `${new Date(record.startedAt).toLocaleString()} – ${new Date(record.endedAt).toLocaleString()}`],
      ['Channel', `${channelDisplay(record.channel)} · ${channelFrequencyDisplay(record.channel)}`],
      ['Audio', `${record.durationSeconds.toFixed(1)} sec shown · ${record.sourceDurationSeconds.toFixed(1)} sec source retained · ${record.sampleRate.toLocaleString()} Hz mono${quality}`],
      ['Storage', `${record.ids.length} records · ${(compressedBytes / 1024).toFixed(0)} KiB compressed from ${(audioBytes / 1024).toFixed(0)} KiB`]
    ]
    for (const [term, value] of metadataRows) {
      const dt = document.createElement('dt')
      dt.textContent = term
      const dd = document.createElement('dd')
      dd.textContent = value
      metadata.append(dt, dd)
    }

    const actions = document.createElement('div')
    actions.className = 'archive-actions'
    const download = document.createElement('a')
    download.className = 'button-link'
    download.download = `vhf-${record.channel}-${record.startedAt.replace(/[:.]/g, '-')}.wav`
    download.textContent = 'Download current playback'
    const originalDownload = document.createElement('a')
    originalDownload.className = 'button-link'
    originalDownload.href = `${originalAudioUrl}&cleanup=raw&squelch=0`
    originalDownload.download = `vhf-${record.channel}-${record.startedAt.replace(/[:.]/g, '-')}-original.wav`
    originalDownload.textContent = 'Original WAV'
    const copy = document.createElement('button')
    copy.type = 'button'
    copy.textContent = 'Copy transcript'
    copy.addEventListener('click', async () => {
      try {
        const text = record.records.map((entry) => `[${entry.startedAt}] ${entry.transcript || '[no speech recognized]'}`).join('\n')
        await copyText(text)
        copy.textContent = 'Copied'
        window.setTimeout(() => { copy.textContent = 'Copy transcript' }, 1_500)
      } catch (error) {
        setConnection('error', `Could not copy transcript: ${error.message}`)
      }
    })
    actions.append(download, originalDownload, copy)
    cleanup.addEventListener('change', updatePlayback)
    squelch.addEventListener('change', updatePlayback)
    updatePlayback()
    details.addEventListener('toggle', () => {
      if (details.open) void renderArchiveWaveform(waveformTrack, audioUrl, audio, record.durationSeconds, seekFromWaveform)
    })
    body.append(waveform, audio, controls, log, metadata, actions)
    details.append(summary, body)
    const header = document.createElement('div')
    header.className = 'archive-item-header'
    const hop = document.createElement('button')
    hop.className = 'archive-hop button compact'
    hop.type = 'button'
    hop.textContent = 'View channel conversation'
    hop.setAttribute('aria-label', `View ${channelDisplay(record.channel)} channel conversation`)
    hop.addEventListener('click', () => switchConversation(record.channel, record.records[0]))
    header.append(details, hop)
    item.append(header)
    return item
  }

  function conversationDate(timestamp) {
    return new Date(timestamp).toLocaleString([], {
      month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit'
    })
  }

  function markConversationClip() {
    for (const clip of conversationView.querySelectorAll('[data-conversation-id]')) {
      clip.classList.toggle('is-selected', clip.dataset.conversationId === String(conversationSelectedId))
    }
  }

  function updateConversationChannels() {
    const ids = [...new Set(conversationRecords.map((record) => String(record.channel)))].sort((left, right) => {
      const leftNumber = Number(left)
      const rightNumber = Number(right)
      return Number.isFinite(leftNumber) && Number.isFinite(rightNumber) ? leftNumber - rightNumber : left.localeCompare(right)
    })
    const signature = ids.join(',')
    if (signature === conversationChannelSignature) return
    conversationChannelSignature = signature
    const previous = conversationChannel.value
    conversationChannel.replaceChildren(...ids.map((id) => {
      const option = document.createElement('option')
      option.value = id
      option.textContent = channelDisplay(id)
      return option
    }))
    if (ids.includes(previous)) conversationChannel.value = previous
    else if (ids.includes('16')) conversationChannel.value = '16'
    else conversationChannel.value = ids[0] || ''
    conversationChannel.disabled = ids.length === 0
  }

  function renderConversation() {
    const channel = conversationChannel.value
    const { window: timeWindow, clips } = window.VHFConversation.selectConversation(
      conversationRecords, channel, conversationRange.value, Date.now()
    )
    const span = Math.max(1, timeWindow.end - timeWindow.start)
    conversationScaleStart.textContent = conversationDate(timeWindow.start)
    conversationScaleEnd.textContent = conversationDate(timeWindow.end)
    conversationTimeline.replaceChildren(...clips.map((clip) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'conversation-mark'
      button.dataset.conversationId = String(clip.record.id)
      const visibleStart = Math.max(clip.start, timeWindow.start)
      const visibleEnd = Math.min(clip.end, timeWindow.end)
      button.style.setProperty('--clip-left', `${Math.max(0, Math.min(100, (visibleStart - timeWindow.start) / span * 100))}%`)
      button.style.setProperty('--clip-width', `${Math.max(.05, Math.min(100, (visibleEnd - visibleStart) / span * 100))}%`)
      button.title = `${conversationDate(clip.start)} · ${clip.record.transcript || 'No transcript'}`
      button.setAttribute('aria-label', `Play ${channelDisplay(channel)} clip at ${conversationDate(clip.start)}: ${clip.record.transcript || 'No transcript'}`)
      button.addEventListener('click', () => playConversationFrom(clip.record.id))
      return button
    }))

    const rows = []
    let furthestPreviousEnd = Number.NEGATIVE_INFINITY
    clips.forEach((clip, index) => {
      if (index > 0) {
        const gapSeconds = Math.max(0, (clip.start - furthestPreviousEnd) / 1_000)
        if (gapSeconds > 0) {
          const gap = document.createElement('li')
          gap.className = 'conversation-gap'
          gap.textContent = `Quiet gap · ${formatGap(gapSeconds)}`
          gap.setAttribute('aria-label', `${formatGap(gapSeconds)} gap between transmissions`)
          rows.push(gap)
        }
      }
      const item = document.createElement('li')
      item.className = 'conversation-clip-row'
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'conversation-clip'
      button.dataset.conversationId = String(clip.record.id)
      const time = document.createElement('time')
      time.dateTime = new Date(clip.start).toISOString()
      time.textContent = conversationDate(clip.start)
      const duration = document.createElement('span')
      duration.className = 'conversation-duration'
      duration.textContent = `${Math.max(0, (clip.end - clip.start) / 1_000).toFixed(1)} sec`
      const transcript = document.createElement('span')
      transcript.className = 'conversation-transcript'
      transcript.textContent = clip.record.transcript || '[No speech recognized]'
      button.append(time, duration, transcript)
      button.setAttribute('aria-label', `Play ${channelDisplay(channel)} clip at ${time.textContent}: ${transcript.textContent}`)
      button.addEventListener('click', () => playConversationFrom(clip.record.id))
      item.append(button)
      rows.push(item)
      furthestPreviousEnd = Math.max(furthestPreviousEnd, clip.end)
    })
    conversationClips.replaceChildren(...rows)
    conversationEmpty.hidden = clips.length > 0
    conversationTimeline.hidden = clips.length === 0
    conversationPlay.disabled = clips.length === 0
    if (conversationSelectedId && !clips.some((clip) => String(clip.record.id) === String(conversationSelectedId))) {
      conversationSelectedId = undefined
    }
    markConversationClip()
    conversationLastRenderMinute = Math.floor(Date.now() / 60_000)
  }

  function formatGap(seconds) {
    if (seconds < 1) return `${seconds.toFixed(1)} sec`
    if (seconds < 60) return `${Math.round(seconds)} sec`
    const minutes = Math.floor(seconds / 60)
    const remainingSeconds = Math.round(seconds % 60)
    if (minutes < 60) return remainingSeconds ? `${minutes} min ${remainingSeconds} sec` : `${minutes} min`
    const hours = Math.floor(minutes / 60)
    const remainingMinutes = minutes % 60
    return remainingMinutes ? `${hours} hr ${remainingMinutes} min` : `${hours} hr`
  }

  function stopConversation(message = 'Choose a clip or play the conversation.') {
    conversationPlayer.stop()
    conversationSelectedId = undefined
    if (message) conversationStatus.textContent = message
    markConversationClip()
  }

  function playConversationFrom(id) {
    const { clips } = window.VHFConversation.selectConversation(conversationRecords, conversationChannel.value, conversationRange.value, Date.now())
    const started = conversationPlayer.playFrom(clips.map((clip) => clip.record), id, true)
    if (!started) {
      stopConversation('That clip is no longer available in this time range.')
    }
  }

  function switchConversation(channel, record) {
    conversationPlayer.stop()
    archiveView = 'conversation'
    archiveAllView.hidden = true
    conversationView.hidden = false
    archiveViewAll.classList.remove('is-active')
    archiveViewAll.setAttribute('aria-pressed', 'false')
    archiveViewConversation.classList.add('is-active')
    archiveViewConversation.setAttribute('aria-pressed', 'true')
    updateConversationChannels()
    if ([...conversationChannel.options].some((option) => option.value === String(channel))) conversationChannel.value = String(channel)
    conversationSelectedId = undefined
    if (record) {
      const bounds = window.VHFConversation.clipBounds(record)
      const channelRecords = conversationRecords.filter((entry) => String(entry.channel) === String(channel))
      conversationRange.value = window.VHFConversation.rangeForSelection(channelRecords, conversationRange.value, record, Date.now())
      conversationSelectedId = record.id
      conversationStatus.textContent = `Selected ${conversationDate(bounds.start)}. Choose Play to start.`
    }
    renderConversation()
    conversationView.scrollIntoView({ block: 'start', behavior: 'smooth' })
    conversationChannel.focus({ preventScroll: true })
  }

  function showAllChannels() {
    stopConversation()
    archiveView = 'all'
    archiveAllView.hidden = false
    conversationView.hidden = true
    archiveViewAll.classList.add('is-active')
    archiveViewAll.setAttribute('aria-pressed', 'true')
    archiveViewConversation.classList.remove('is-active')
    archiveViewConversation.setAttribute('aria-pressed', 'false')
  }

  function refreshConversation(records, archive) {
    const signature = JSON.stringify(records.map((record) => [record.id, record.channel, record.startedAt, record.durationSeconds, record.activityStartSeconds, record.activityEndSeconds, record.transcript]))
    const previousIds = new Set(conversationRecords.map((record) => String(record.id)))
    conversationRecords = records
    conversationPlayer.updateRecords(records)
    updateConversationChannels()
    const currentId = conversationSelectedId
    if (currentId && previousIds.has(String(currentId)) && !records.some((record) => String(record.id) === String(currentId))) {
      stopConversation('The selected clip is no longer available.')
    }
    conversationLimit.textContent = archive?.records > 500
      ? `Showing the latest 500 of ${archive.records} archived records across all channels.`
      : `Showing ${records.length} of ${archive?.records ?? records.length} archived records across all channels.`
    const signatureChanged = signature !== conversationSignature
    if (signatureChanged) conversationSignature = signature
    const minuteChanged = conversationRange.value !== 'all' && Math.floor(Date.now() / 60_000) !== conversationLastRenderMinute
    if (signatureChanged || (archiveView === 'conversation' && minuteChanged)) {
      const focusedClipId = conversationView.contains(document.activeElement)
        ? document.activeElement?.getAttribute('data-conversation-id')
        : null
      renderConversation()
      if (focusedClipId) {
        const focusTarget = [...conversationView.querySelectorAll('[data-conversation-id]')]
          .find((element) => element.getAttribute('data-conversation-id') === focusedClipId)
        focusTarget?.focus({ preventScroll: true })
      }
    }
  }

  function openTranscriptFromHash() {
    const match = window.location.hash.match(/^#transcript-(\d+)$/)
    if (!match) return
    const line = document.getElementById(`transcript-${match[1]}`)
    if (!line) return
    const details = line.closest('details')
    const link = line.querySelector('.transcript-time-link')
    details.open = true
    selectTranscriptMoment(details, Number(match[1]), Number(link.dataset.audioOffset), false)
    window.requestAnimationFrame(() => line.scrollIntoView({ block: 'center' }))
  }

  async function updateArchive() {
    try {
      const { records, archive } = await request('transcripts?limit=500')
      refreshConversation(records, archive)
      const sessions = groupArchiveSessions(records)
      const signature = sessionRenderSignature(sessions, true)
      if (signature !== archiveRenderSignature && !hasPlayingAudio(archiveList)) {
        const expanded = new Set([...archiveList.querySelectorAll('details[open]')].map((details) => details.dataset.sessionKey))
        destroyArchiveWaveforms()
        archiveList.replaceChildren(...sessions.map(archiveRow))
        for (const details of archiveList.querySelectorAll('details')) {
          if (expanded.has(details.dataset.sessionKey)) details.open = true
        }
        archiveRenderSignature = signature
        openTranscriptFromHash()
      }
      archiveEmpty.hidden = sessions.length > 0
      voiceEventCount.textContent = String(sessions.length)
      archiveEmpty.textContent = 'No archived transcripts yet.'
      if (archive) {
        archiveSummary.textContent = `${archive.records} records · ${(archive.databaseBytes / 1024 / 1024).toFixed(1)} of ${(archive.maxBytes / 1024 / 1024).toFixed(0)} MiB · up to ${archive.retentionDays} days`
        archiveBytes.textContent = `${((archive.compressedBytes + archive.narrationBytes) / 1024 / 1024).toFixed(1)} MiB`
      }
    } catch (error) {
      archiveEmpty.hidden = false
      archiveEmpty.textContent = error.message
    }
  }

  async function configureSlots() {
    const selected = channels.find((channel) => channel.id === slotAChannel.value)
    if (selected?.requiresSingleFrequency) {
      slotAMode.value = 'fixed'
      slotBMode.value = 'fixed'
    }
    if (slotBMode.value === 'scan' && slotBChannel.value === '70') {
      const preferred = channels.find((channel) => channel.id === '68' && channel.availableSlotB !== false && channel.id !== slotAChannel.value) ||
        channels.find((channel) => !channel.weather && channel.availableSlotB !== false && channel.id !== slotAChannel.value)
      if (preferred) slotBChannel.value = preferred.id
    }
    const selection = { mode: slotAMode.value, slotAChannel: slotAChannel.value, slotBMode: slotBMode.value, slotBChannel: slotBChannel.value }
    slotConfigurationPending = true
    slotAMode.disabled = true
    slotAChannel.disabled = true
    slotBMode.disabled = true
    slotBChannel.disabled = true
    presetStandard.disabled = true
    presetSlotA16.disabled = true
    presetSlotB70.disabled = true
    try {
      const status = await request('slots', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(selection)
      })
      renderStatus(status)
    } catch (error) {
      setConnection('error', error.message)
    } finally {
      slotConfigurationPending = false
      slotAMode.disabled = singleFrequencyActive
      slotAChannel.disabled = false
      slotBMode.disabled = singleFrequencyActive
      slotBChannel.disabled = singleFrequencyActive
      presetStandard.disabled = false
      presetSlotA16.disabled = false
      presetSlotB70.disabled = false
    }
  }

  function applyChannelPreset(slot) {
    if (slot === 'standard' || slot === 'A') {
      slotAMode.value = 'fixed'
      slotAChannel.value = '16'
      if (slotBChannel.value === '16') slotBChannel.value = '70'
    }
    if (slot === 'standard' || slot === 'B') {
      slotBMode.value = 'fixed'
      slotBChannel.value = '70'
      const selectedA = channels.find((channel) => channel.id === slotAChannel.value)
      if (selectedA?.requiresSingleFrequency) {
        slotAMode.value = 'fixed'
        slotAChannel.value = '16'
      }
    }
    void configureSlots()
  }

  async function changeRegion() {
    const selectedRegion = regionSelect.value
    slotConfigurationPending = true
    regionSelect.disabled = true
    slotAChannel.disabled = true
    slotBMode.disabled = true
    slotBChannel.disabled = true
    try {
      const status = await request('region', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ region: selectedRegion })
      })
      await loadChannels()
      renderStatus(status)
    } catch (error) {
      setConnection('error', error.message)
    } finally {
      slotConfigurationPending = false
      regionSelect.disabled = false
      slotAChannel.disabled = false
      slotAMode.disabled = singleFrequencyActive
      slotBMode.disabled = singleFrequencyActive
      slotBChannel.disabled = singleFrequencyActive
    }
  }

  async function clearReplay() {
    try {
      await request('replay', { method: 'DELETE' })
      await updateReplay()
    } catch (error) {
      setConnection('error', error.message)
    }
  }

  async function clearDsc() {
    if (!window.confirm('Clear all retained decoded DSC calls?')) return
    try {
      await request('dsc', { method: 'DELETE' })
      await updateDsc()
    } catch (error) {
      setConnection('error', error.message)
    }
  }

  function startPolling() {
    if (pollingStarted) return
    pollingStarted = true
    poll = window.setInterval(updateStatus, 1000)
    pollTimers.add(poll)
    pollTimers.add(window.setInterval(updateReplay, 5000))
    pollTimers.add(window.setInterval(updateSpectrumActivity, 5000))
    pollTimers.add(window.setInterval(updateDsc, 5000))
    pollTimers.add(window.setInterval(updateArchive, 15_000))
    pollTimers.add(window.setInterval(() => {
      if (!channelsLoaded) void loadChannels().catch((error) => setConnection('error', error.message))
    }, 5_000))
  }

  async function initialize() {
    startPolling()
    const channelRequest = loadChannels().catch((error) => setConnection('error', error.message))
    await Promise.all([channelRequest, updateStatus(), updateReplay(), updateSpectrumActivity(), updateDsc(), updateArchive()])
  }

  slotAMode.addEventListener('change', configureSlots)
  slotAChannel.addEventListener('change', configureSlots)
  slotBMode.addEventListener('change', configureSlots)
  slotBChannel.addEventListener('change', configureSlots)
  presetStandard.addEventListener('click', () => applyChannelPreset('standard'))
  presetSlotA16.addEventListener('click', () => applyChannelPreset('A'))
  presetSlotB70.addEventListener('click', () => applyChannelPreset('B'))
  regionSelect.addEventListener('change', changeRegion)
  $('#clear').addEventListener('click', () => clearReplayDialog.showModal())
  archiveViewAll.addEventListener('click', showAllChannels)
  archiveViewConversation.addEventListener('click', () => switchConversation(conversationChannel.value))
  conversationChannel.addEventListener('change', () => {
    stopConversation()
    renderConversation()
  })
  conversationRange.addEventListener('change', () => {
    stopConversation()
    renderConversation()
  })
  conversationPlay.addEventListener('click', () => {
    const { clips } = window.VHFConversation.selectConversation(conversationRecords, conversationChannel.value, conversationRange.value, Date.now())
    if (!clips.length) return
    const startId = clips.some((clip) => String(clip.record.id) === String(conversationSelectedId))
      ? conversationSelectedId
      : clips[0].record.id
    playConversationFrom(startId)
  })
  clearReplayDialog.addEventListener('close', () => {
    if (clearReplayDialog.returnValue === 'delete') void clearReplay()
  })
  $('#clear-dsc').addEventListener('click', clearDsc)
  replaySquelch.addEventListener('change', () => {
    replaySquelchTouched = true
    savePreference('replay-squelch', replaySquelch.value)
    refreshTimelineAudio()
    if (liveListening) startLiveListening()
    void updateReplay()
  })
  timelineRange.addEventListener('input', () => {
    selectTimelineIndex(Number(timelineRange.value))
  })
  timelineLatest.addEventListener('click', () => {
    selectLatestActiveTimeline()
  })
  timelineCleanup.addEventListener('change', () => {
    savePreference('timeline-cleanup', timelineCleanup.value)
    replaySquelch.disabled = timelineCleanup.value === 'modified'
    refreshTimelineAudio()
    if (liveListening) startLiveListening()
  })
  liveListen.addEventListener('click', () => {
    if (liveListening) stopLiveListening()
    else startLiveListening()
  })
  timelinePlay.addEventListener('click', () => {
    if (timelineQueueIndex < 0 || !timelineQueue[timelineQueueIndex]) return
    if (timelineAudio.paused && !timelineWaveformSpinner.hidden) {
      timelinePlaybackGeneration += 1
      timelineAutoAdvance = false
      timelinePlaybackRequested = false
      timelineBusyVersion += 1
      setWaveformBusy($('#timeline-waveform'), timelineWaveformSpinner, timelinePlay, false)
      timelineAudio.pause()
      return
    }
    if (!timelineAudio.paused) {
      timelineAutoAdvance = false
      timelinePlaybackRequested = false
      setWaveformBusy($('#timeline-waveform'), timelineWaveformSpinner, timelinePlay, false)
      timelineAudio.pause()
    }
    else {
      pauseOtherAudio(timelineAudio)
      timelinePlaybackRequested = true
      timelineBusyVersion += 1
      setWaveformBusy($('#timeline-waveform'), timelineWaveformSpinner, timelinePlay, true)
      loadTimelineAudio(timelineQueue[timelineQueueIndex], true)
    }
  })
  timelineSkip.addEventListener('click', () => {
    const segment = timelineQueue[timelineQueueIndex]
    if (!segment) return
    const target = (timelineAudio.currentTime || 0) + 5
    seekTimelineAudio(target)
  })
  timelineSeek.addEventListener('input', () => {
    seekTimelineAudio(Number(timelineSeek.value))
  })
  timelineWaveformTrack.addEventListener('pointerdown', () => {
    const segment = timelineQueue[timelineQueueIndex]
    if (segment && !timelineAudioSource) loadTimelineAudio(segment)
  }, true)
  replaySquelch.disabled = timelineCleanup.value === 'modified'
  for (const event of ['loadedmetadata', 'durationchange', 'timeupdate', 'play', 'pause', 'seeked']) timelineAudio.addEventListener(event, updateTimelinePlayback)
  timelineAudio.addEventListener('play', () => {
    timelineAutoAdvance = true
    timelinePlaybackRequested = true
    timelinePlaybackStatus.textContent = ''
  })
  timelineAudio.addEventListener('playing', () => {
    if (timelinePlaybackRequested) setWaveformBusy($('#timeline-waveform'), timelineWaveformSpinner, timelinePlay, false)
  })
  timelineAudio.addEventListener('waiting', () => {
    if (timelinePlaybackRequested && !timelineAudio.paused) setWaveformBusy($('#timeline-waveform'), timelineWaveformSpinner, timelinePlay, true)
  })
  timelineAudio.addEventListener('pause', () => {
    if (timelineAudio.paused) {
      timelinePlaybackRequested = false
      setWaveformBusy($('#timeline-waveform'), timelineWaveformSpinner, timelinePlay, false)
    }
  })
  timelineAudio.addEventListener('ended', () => {
    timelinePlaybackRequested = false
    setWaveformBusy($('#timeline-waveform'), timelineWaveformSpinner, timelinePlay, false)
    if (timelineAutoAdvance && timelineQueueIndex + 1 < timelineQueue.length) {
      timelineQueueSegment(timelineQueueIndex + 1)
      pauseOtherAudio(timelineAudio)
      loadTimelineAudio(timelineQueue[timelineQueueIndex], true)
    } else {
      timelineAutoAdvance = false
      timelinePlaybackStatus.textContent = 'Historical playback ended.'
    }
  })
  timelineAudio.addEventListener('error', () => {
    const expectedCurrentSrc = timelineAudioSource && new URL(timelineAudioSource, window.location.href).href
    if (!expectedCurrentSrc || (timelineAudio.currentSrc && timelineAudio.currentSrc !== expectedCurrentSrc)) return
    timelinePlaybackRequested = false
    setWaveformBusy($('#timeline-waveform'), timelineWaveformSpinner, timelinePlay, false)
    if (timelineAutoAdvance && timelineQueueIndex + 1 < timelineQueue.length) {
      timelinePlaybackStatus.textContent = 'Recording unavailable; skipping to the next segment.'
      timelineQueueSegment(timelineQueueIndex + 1)
      loadTimelineAudio(timelineQueue[timelineQueueIndex], true)
    } else {
      timelineAutoAdvance = false
      timelinePlaybackStatus.textContent = 'Recording playback is unavailable.'
    }
  })
  liveAudio.addEventListener('error', () => {
    const expectedCurrentSrc = liveAudioSource && new URL(liveAudioSource, window.location.href).href
    if (liveListening && expectedCurrentSrc && (!liveAudio.currentSrc || liveAudio.currentSrc === expectedCurrentSrc)) stopLiveListening('Live audio stopped because the stream is unavailable.')
  })
  liveAudio.addEventListener('ended', () => {
    if (liveListening) stopLiveListening('Live stream ended. Tap Listen live to reconnect.')
  })
  window.addEventListener('pagehide', () => {
    destroyTimelineWaveform()
    destroyArchiveWaveforms()
  })
  document.addEventListener('play', (event) => {
    if (event.target instanceof HTMLAudioElement) {
      pauseOtherAudio(event.target)
    }
  }, true)
  transcriptionEnabled.addEventListener('change', async () => {
    transcriptionEnabled.disabled = true
    try {
      const status = await request('transcription', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: transcriptionEnabled.checked })
      })
      renderStatus(status)
      await updateReplay()
      await updateArchive()
    } catch (error) {
      setConnection('error', error.message)
      await updateStatus()
    } finally {
      transcriptionEnabled.disabled = false
    }
  })

  async function saveTranscriptionRuntime(patch, controls) {
    for (const control of controls) {
      control.dataset.saving = 'true'
      control.disabled = true
    }
    try {
      const status = await request('transcription', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch)
      })
      renderStatus(status)
    } catch (error) {
      transcriptionStatus.textContent = error.message
      await updateStatus()
    } finally {
      for (const control of controls) delete control.dataset.saving
      if (latestStatus) renderStatus(latestStatus)
    }
  }

  transcriptionModel.addEventListener('change', () => saveTranscriptionRuntime({ model: transcriptionModel.value }, [transcriptionModel]))
  transcriptionThreads.addEventListener('change', () => saveTranscriptionRuntime({ threads: Number(transcriptionThreads.value) }, [transcriptionThreads]))
  weatherTranscriptionModel.addEventListener('change', () => saveTranscriptionRuntime({ weatherModel: weatherTranscriptionModel.value }, [weatherTranscriptionModel]))
  weatherTranscriptionThreads.addEventListener('change', () => saveTranscriptionRuntime({ weatherThreads: Number(weatherTranscriptionThreads.value) }, [weatherTranscriptionThreads]))
  transcriptionOverlap.addEventListener('change', () => saveTranscriptionRuntime({ overlapSeconds: Number(transcriptionOverlap.value) }, [transcriptionOverlap]))
  transcriptionKeepLoaded.addEventListener('change', () => saveTranscriptionRuntime({ keepModelsLoaded: transcriptionKeepLoaded.checked }, [transcriptionKeepLoaded]))
  settingsPanel.addEventListener('toggle', () => savePreference('settings-open', settingsPanel.open))
  window.addEventListener('hashchange', openTranscriptFromHash)
  window.addEventListener('pagehide', () => {
    for (const timer of pollTimers) window.clearInterval(timer)
    pollTimers.clear()
    stopConversation('Playback stopped.')
  })
  initialize()
})()
