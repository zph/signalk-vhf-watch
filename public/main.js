(() => {
  'use strict'
  const CLIENT_BUILD = 47
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
  const timelineQuieting = $('#timeline-quieting')
  const timelineQuietingControl = $('#timeline-quieting-control')
  const timelineQuietingValue = $('#timeline-quieting-value')
  const frequencyMap = $('#frequency-map')
  const frequencyEmpty = $('#frequency-empty')
  const transcriptionEnabled = $('#transcription-enabled')
  const transcriptionModel = $('#transcription-model')
  const transcriptionThreads = $('#transcription-threads')
  const transcriptionStatus = $('#transcription-status')
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
  let replaySquelchTouched = false
  let replayTimeline = []
  let spectrumTimeline = []
  let dscTimeline = []
  let timelineSegmentId
  let timelineFollowingLive = true
  let timelineWaitingAtEdge = false
  let timelineWindowMinutes = 1_440
  let timelineReceiverRows = []
  let timelineActiveSlotAChannel
  let timelineAwaitingChannel
  let archiveRenderSignature = ''
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
    sourceFor: (record) => `${API}transcripts/${record.id}.wav?activity=1&cleanup=${encodeURIComponent(timelineCleanup.value)}&squelch=${encodeURIComponent(replaySquelch.value)}&quieting=${encodeURIComponent(timelineQuieting.value)}`,
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
  const storedTimelineQuieting = Number(storedPreference('timeline-quieting', '100'))
  timelineQuieting.value = String(Number.isFinite(storedTimelineQuieting) ? Math.min(100, Math.max(0, storedTimelineQuieting)) : 100)
  timelineQuietingValue.value = `${timelineQuieting.value}%`
  timelineQuietingValue.textContent = `${timelineQuieting.value}%`
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
    const hadActiveSlotAChannel = Boolean(timelineActiveSlotAChannel)
    handleTimelineSlotARetune(activeSlotAChannel)
    timelineActiveSlotAChannel = activeSlotAChannel
    if (!hadActiveSlotAChannel && replayTimeline.length > 0) selectLatestActiveTimeline()
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
    timelineDescription.textContent = `Past ${replayWindow} · select a burst to listen`
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
    const modelSignature = JSON.stringify(transcription.availableModels)
    if (transcriptionModel.dataset.models !== modelSignature) {
      transcriptionModel.replaceChildren(...transcription.availableModels.map((model) => {
        const option = document.createElement('option')
        option.value = model.id
        option.textContent = `${model.label} · ${(model.bytes / 1024 / 1024).toFixed(0)} MiB`
        return option
      }))
      transcriptionModel.dataset.models = modelSignature
    }
    transcriptionModel.value = transcription.model
    transcriptionThreads.value = String(transcription.threads)
    transcriptionModel.disabled = transcription.availableModels.length === 0
    transcriptionThreads.disabled = transcription.availableModels.length === 0
    transcriptionEnabled.checked = transcription.enabled
    transcriptionEnabled.disabled = !transcription.available && !transcription.enabled
    transcriptionStatus.textContent = transcription.error
      ? `Transcription needs attention · ${transcription.error}`
      : transcription.enabled
      ? `Local transcription on · ${transcription.state}${transcription.queued ? ` · ${transcription.queued} queued` : ''} · ${transcription.engine} · ${transcription.threads} threads`
      : transcription.available
        ? `Local transcription off · ${transcription.engine} is installed and ready`
        : 'Local transcription off · install vhf-whisper-runtime to enable it'
    if (transcription.archive) {
      archiveSummary.textContent = `${transcription.archive.records} records · ${(transcription.archive.databaseBytes / 1024 / 1024).toFixed(1)} of ${(transcription.archive.maxBytes / 1024 / 1024).toFixed(0)} MiB · up to ${transcription.archive.retentionDays} days`
    }
    setConnection(status.error ? 'error' : 'ok', status.error ? 'Receiver error' : 'Connected')
  }

  function handleTimelineSlotARetune(activeSlotAChannel) {
    if (!timelineFollowingLive || !timelineActiveSlotAChannel || timelineActiveSlotAChannel === activeSlotAChannel) return false
    timelineAwaitingChannel = activeSlotAChannel
    timelineFollowingLive = true
    timelineWaitingAtEdge = false
    timelineSegmentId = undefined
    timelineAudio.pause()
    timelineAudio.removeAttribute('src')
    timelineAudio.load()
    timelineTime.textContent = `Waiting for ${channelDisplay(activeSlotAChannel)} audio…`
    timelineOffset.textContent = channelFrequencyDisplay(activeSlotAChannel)
    return true
  }

  async function loadChannels() {
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
      renderStatus(await request('status'))
    } catch (error) {
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

  function activateArchivePlayback(details, audio, updatePlayback) {
    if (!details.open || audio.dataset.archivePlaybackActivated === 'true') return false
    audio.dataset.archivePlaybackActivated = 'true'
    audio.preload = 'metadata'
    updatePlayback()
    return true
  }

  function pauseOtherAudio(activeAudio) {
    for (const audio of document.querySelectorAll('audio')) {
      if (audio !== activeAudio && !audio.paused) audio.pause()
    }
  }

  function sessionRenderSignature(sessions, includeTranscript = false) {
    return JSON.stringify(sessions.map((session) => ({
      ids: session.ids,
      durationSeconds: session.durationSeconds,
      ...(includeTranscript ? {
        transcript: session.transcript,
        transcription: session.transcription,
        narration: session.records.map((record) => [record.narrationBytes, record.narrationVoice, record.narrationError])
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
    timelineFollowingLive = false
    timelineWaitingAtEdge = false
    timelineAudio.pause()
    timelineAudio.removeAttribute('src')
    timelineAudio.load()
    timelineTime.textContent = new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    timelineOffset.textContent = `${description} · no playable voice was captured`
    timelineLatest.textContent = 'Go live'
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
          timelineFollowingLive = false
          timelineWaitingAtEdge = false
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

  function selectTimelineIndex(requestedIndex, autoplay = false) {
    if (replayTimeline.length === 0) return
    const index = Math.max(0, Math.min(replayTimeline.length - 1, requestedIndex))
    const segment = replayTimeline[index]
    const startedAt = new Date(segment.startedAt)
    const ageMinutes = Math.max(0, Math.round((Date.now() - startedAt.getTime()) / 60_000))
    timelineRange.value = String(index)
    timelineSegmentId = segment.id
    timelineTime.textContent = startedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    timelineOffset.textContent = `${ageMinutes === 0 ? 'Less than a minute' : `${ageMinutes} min`} ago · Slot ${segment.slot} · ${channelDisplay(segment.channel)} · ${channelFrequencyDisplay(segment.channel)}`
    const source = `${API}replay/${segment.id}/continuous.wav?squelch=${encodeURIComponent(replaySquelch.value)}&cleanup=${encodeURIComponent(timelineCleanup.value)}&quieting=${encodeURIComponent(timelineQuieting.value)}`
    if (timelineAudio.getAttribute('src') !== source) timelineAudio.src = source
    if (autoplay) void timelineAudio.play().catch(() => {})
    timelineLatest.textContent = timelineFollowingLive ? 'Following live' : 'Go live'
    timelineLatest.setAttribute('aria-pressed', String(timelineFollowingLive))
    highlightFrequencyBurst()
  }

  function latestActiveTimelineIndex() {
    return replayTimeline.findLastIndex((segment) => timelineReceiverRows.some((receiver) => (
      segment.slot === receiver.slot && segment.channel === receiver.channel
    )))
  }

  function selectLatestActiveTimeline(autoplay = false) {
    if (!timelineActiveSlotAChannel) {
      timelineTime.textContent = 'Waiting for receiver status…'
      timelineOffset.textContent = 'Starting receiver…'
      return
    }
    const index = latestActiveTimelineIndex()
    if (index < 0) {
      timelineAwaitingChannel = timelineActiveSlotAChannel
      timelineRange.disabled = true
      timelineLatest.disabled = true
      timelineTime.textContent = `Waiting for ${channelDisplay(timelineActiveSlotAChannel)} audio…`
      timelineOffset.textContent = channelFrequencyDisplay(timelineActiveSlotAChannel)
      timelineAudio.pause()
      timelineAudio.removeAttribute('src')
      timelineAudio.load()
      renderFrequencyMap()
      return
    }
    timelineAwaitingChannel = undefined
    timelineFollowingLive = true
    timelineWaitingAtEdge = false
    timelineRange.disabled = false
    timelineLatest.disabled = false
    selectTimelineIndex(index, autoplay)
  }

  function updateTimeline(segments) {
    replayTimeline = segments.slice().reverse()
    timelineRange.disabled = replayTimeline.length === 0
    timelineRange.max = String(Math.max(0, replayTimeline.length - 1))
    timelineLatest.disabled = replayTimeline.length === 0
    if (replayTimeline.length === 0) {
      timelineAudio.removeAttribute('src')
      timelineAudio.load()
      timelineSegmentId = undefined
      timelineTime.textContent = 'Waiting for audio…'
      timelineOffset.textContent = 'The rolling buffer is filling.'
      renderFrequencyMap()
      return
    }
    if (timelineAwaitingChannel) {
      const matchingIndex = replayTimeline.findLastIndex((segment) =>
        segment.slot === 'A' && segment.channel === timelineAwaitingChannel
      )
      if (matchingIndex < 0) {
        timelineRange.disabled = true
        timelineLatest.disabled = true
        timelineTime.textContent = `Waiting for ${channelDisplay(timelineAwaitingChannel)} audio…`
        timelineOffset.textContent = channelFrequencyDisplay(timelineAwaitingChannel)
        renderFrequencyMap()
        return
      }
      timelineAwaitingChannel = undefined
      timelineRange.disabled = false
      timelineLatest.disabled = false
      selectTimelineIndex(matchingIndex)
      renderFrequencyMap()
      return
    }
    const oldest = new Date(replayTimeline[0].startedAt)
    timelineOldest.textContent = oldest.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    const currentIndex = replayTimeline.findIndex((segment) => segment.id === timelineSegmentId)
    if (timelineFollowingLive && timelineWaitingAtEdge && currentIndex >= 0 && currentIndex < replayTimeline.length - 1) {
      timelineWaitingAtEdge = false
      selectTimelineIndex(currentIndex + 1, true)
      renderFrequencyMap()
      return
    }
    const selectedIndex = timelineFollowingLive
      ? (currentIndex >= 0 && replayTimeline[currentIndex]?.channel === timelineActiveSlotAChannel
          ? currentIndex
          : latestActiveTimelineIndex())
      : Math.max(0, currentIndex)
    if (selectedIndex < 0) selectLatestActiveTimeline()
    else selectTimelineIndex(selectedIndex)
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

  function bindTranscriptMoment(link, details, entry, offsetSeconds) {
    link.addEventListener('click', (event) => {
      event.preventDefault()
      details.open = true
      window.history.pushState(null, '', link.hash)
      selectTranscriptMoment(details, entry.id, offsetSeconds, true)
      document.getElementById(transcriptMomentId(entry))?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    })
  }

  function wavSamples(arrayBuffer) {
    const view = new DataView(arrayBuffer)
    let offset = 12
    while (offset + 8 <= view.byteLength) {
      const chunk = String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3))
      const length = view.getUint32(offset + 4, true)
      if (chunk === 'data') return { view, offset: offset + 8, samples: Math.floor(length / 2) }
      offset += 8 + length + (length % 2)
    }
    throw new Error('WAV data chunk is missing')
  }

  async function renderArchiveWaveform(waveform, audioUrl) {
    if (waveform.dataset.loaded) return
    waveform.dataset.loaded = 'loading'
    try {
      const response = await fetch(`${audioUrl}&cleanup=raw&squelch=0`, { credentials: 'include' })
      if (!response.ok) throw new Error(`Waveform request failed (${response.status})`)
      const { view, offset, samples } = wavSamples(await response.arrayBuffer())
      const bars = document.createElement('div')
      bars.className = 'waveform-bars'
      bars.setAttribute('role', 'img')
      bars.setAttribute('aria-label', 'Audio waveform')
      const binCount = 120
      const peaks = []
      for (let bin = 0; bin < binCount; bin += 1) {
        const start = Math.floor(samples * bin / binCount)
        const end = Math.max(start + 1, Math.floor(samples * (bin + 1) / binCount))
        let peak = 0
        for (let sample = start; sample < end; sample += Math.max(1, Math.floor((end - start) / 80))) {
          peak = Math.max(peak, Math.abs(view.getInt16(offset + sample * 2, true)))
        }
        peaks.push(peak)
      }
      const maximum = Math.max(1, ...peaks)
      for (const peak of peaks) {
        const bar = document.createElement('i')
        bar.className = 'waveform-bar'
        bar.style.setProperty('--level', String(Math.max(.06, peak / maximum)))
        bars.append(bar)
      }
      waveform.querySelector('.waveform-loading')?.remove()
      waveform.prepend(bars)
      waveform.dataset.loaded = 'true'
    } catch (error) {
      waveform.dataset.loaded = 'error'
      waveform.querySelector('.waveform-loading').textContent = 'Waveform unavailable'
    }
  }

  function setArchivePlayback(audio, download, cleanup, squelch, quieting) {
    const currentTime = audio.currentTime
    const wasPlaying = !audio.paused
    const source = `${audio.dataset.baseUrl}&cleanup=${encodeURIComponent(cleanup)}&squelch=${encodeURIComponent(squelch)}&quieting=${encodeURIComponent(quieting)}`
    audio.src = source
    download.href = source
    audio.load()
    if (currentTime > 0 || wasPlaying) {
      audio.addEventListener('loadedmetadata', () => {
        audio.currentTime = Math.min(currentTime, Number.isFinite(audio.duration) ? audio.duration : currentTime)
        if (wasPlaying) void audio.play().catch(() => {})
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
    const audioUrl = `${API}transcript-session.wav?ids=${encodeURIComponent(record.ids.join(','))}&activity=1`
    const waveform = document.createElement('div')
    waveform.className = 'archive-waveform'
    const loading = document.createElement('span')
    loading.className = 'waveform-loading'
    loading.textContent = 'Open to load waveform…'
    waveform.append(loading)

    const audio = document.createElement('audio')
    audio.controls = true
    audio.preload = 'none'
    audio.dataset.baseUrl = audioUrl

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
    const quietingLabel = document.createElement('label')
    quietingLabel.className = 'quieting-control'
    const quietingTitle = document.createElement('span')
    quietingTitle.textContent = 'Between-transmission quieting'
    const quietingValue = document.createElement('output')
    const quieting = document.createElement('input')
    quieting.type = 'range'
    quieting.min = '0'
    quieting.max = '100'
    quieting.step = '1'
    quieting.setAttribute('aria-label', 'Between-transmission quieting')
    const storedQuieting = Number(storedPreference(`${preferenceKey}:quieting`, timelineQuieting.value))
    quieting.value = String(Number.isFinite(storedQuieting) ? Math.min(100, Math.max(0, storedQuieting)) : 100)
    quietingValue.value = `${quieting.value}%`
    quietingValue.textContent = `${quieting.value}%`
    quietingTitle.append(' ', quietingValue)
    quietingLabel.append(quietingTitle, quieting)
    controls.append(squelchLabel, cleanupLabel, quietingLabel)

    const transcriptPlayback = document.createElement('div')
    transcriptPlayback.className = 'transcript-playback'
    const transcriptPlaybackTitle = document.createElement('div')
    const transcriptPlaybackHeading = document.createElement('strong')
    transcriptPlaybackHeading.textContent = 'Transcript reader'
    const transcriptPlaybackNote = document.createElement('span')
    const narrationReady = record.records.every((entry) => entry.narrationBytes > 0)
    const narrationError = record.records.find((entry) => entry.narrationError)?.narrationError
    transcriptPlaybackNote.textContent = narrationReady
      ? 'Sarah · cached Opus · separate from the original recording'
      : narrationError
        ? `Sarah unavailable · ${narrationError}`
        : 'Sarah · preparing when the Pi is idle; Whisper takes priority'
    transcriptPlaybackTitle.append(transcriptPlaybackHeading, transcriptPlaybackNote)
    const transcriptAudio = document.createElement('audio')
    transcriptAudio.controls = true
    transcriptAudio.preload = 'metadata'
    transcriptAudio.setAttribute('aria-label', 'Transcript reader using the Sarah voice')
    if (narrationReady) transcriptAudio.src = `${API}transcript-session.opus?ids=${encodeURIComponent(record.ids.join(','))}`
    transcriptPlayback.append(transcriptPlaybackTitle, transcriptAudio)

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
      bindTranscriptMoment(stamp, details, entry, offsetSeconds)
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
      bindTranscriptMoment(marker, details, entry, offsetSeconds)
      waveform.append(marker)
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
    originalDownload.href = `${audioUrl}&cleanup=raw&squelch=0`
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
    const updatePlayback = () => {
      savePreference(`${preferenceKey}:cleanup`, cleanup.value)
      savePreference(`${preferenceKey}:squelch`, squelch.value)
      squelch.disabled = cleanup.value === 'modified'
      quieting.disabled = cleanup.value === 'raw'
      if (audio.dataset.archivePlaybackActivated === 'true') setArchivePlayback(audio, download, cleanup.value, squelch.value, quieting.value)
    }
    quieting.addEventListener('input', () => {
      quietingValue.value = `${quieting.value}%`
      quietingValue.textContent = `${quieting.value}%`
      savePreference(`${preferenceKey}:quieting`, quieting.value)
    })
    quieting.addEventListener('change', updatePlayback)
    cleanup.addEventListener('change', updatePlayback)
    squelch.addEventListener('change', updatePlayback)
    updatePlayback()
    details.addEventListener('toggle', () => {
      if (details.open) {
        activateArchivePlayback(details, audio, updatePlayback)
        void renderArchiveWaveform(waveform, audioUrl)
      }
    })
    body.append(waveform, audio, transcriptPlayback, controls, log, metadata, actions)
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

  async function initialize() {
    try {
      await loadChannels()
      await Promise.all([updateStatus(), updateReplay(), updateSpectrumActivity(), updateDsc(), updateArchive()])
      poll = window.setInterval(updateStatus, 1000)
      window.setInterval(updateReplay, 5000)
      window.setInterval(updateSpectrumActivity, 5000)
      window.setInterval(updateDsc, 5000)
      window.setInterval(updateArchive, 15_000)
    } catch (error) {
      setConnection('error', error.message)
    }
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
    void updateReplay()
  })
  timelineRange.addEventListener('input', () => {
    timelineFollowingLive = false
    timelineWaitingAtEdge = false
    selectTimelineIndex(Number(timelineRange.value))
  })
  timelineLatest.addEventListener('click', () => {
    selectLatestActiveTimeline(true)
  })
  timelineCleanup.addEventListener('change', () => {
    savePreference('timeline-cleanup', timelineCleanup.value)
    replaySquelch.disabled = timelineCleanup.value === 'modified'
    timelineQuietingControl.hidden = timelineCleanup.value === 'raw'
    timelineQuieting.disabled = timelineCleanup.value === 'raw'
    const index = replayTimeline.findIndex((segment) => segment.id === timelineSegmentId)
    if (index >= 0) selectTimelineIndex(index, !timelineAudio.paused)
  })
  timelineQuieting.addEventListener('input', () => {
    timelineQuietingValue.value = `${timelineQuieting.value}%`
    timelineQuietingValue.textContent = `${timelineQuieting.value}%`
    savePreference('timeline-quieting', timelineQuieting.value)
  })
  timelineQuieting.addEventListener('change', () => {
    const index = replayTimeline.findIndex((segment) => segment.id === timelineSegmentId)
    if (index >= 0) selectTimelineIndex(index, !timelineAudio.paused)
  })
  replaySquelch.disabled = timelineCleanup.value === 'modified'
  timelineQuietingControl.hidden = timelineCleanup.value === 'raw'
  timelineQuieting.disabled = timelineCleanup.value === 'raw'
  timelineAudio.addEventListener('ended', () => {
    const index = replayTimeline.findIndex((segment) => segment.id === timelineSegmentId)
    if (index >= 0 && index < replayTimeline.length - 1) selectTimelineIndex(index + 1, true)
    else if (timelineFollowingLive) timelineWaitingAtEdge = true
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

  async function saveTranscriptionRuntime() {
    transcriptionModel.disabled = true
    transcriptionThreads.disabled = true
    try {
      const status = await request('transcription', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: transcriptionModel.value,
          threads: Number(transcriptionThreads.value)
        })
      })
      renderStatus(status)
    } catch (error) {
      transcriptionStatus.textContent = error.message
      await updateStatus()
    }
  }

  transcriptionModel.addEventListener('change', saveTranscriptionRuntime)
  transcriptionThreads.addEventListener('change', saveTranscriptionRuntime)
  settingsPanel.addEventListener('toggle', () => savePreference('settings-open', settingsPanel.open))
  window.addEventListener('hashchange', openTranscriptFromHash)
  window.addEventListener('pagehide', () => {
    window.clearInterval(poll)
    stopConversation('Playback stopped.')
    stopNarration()
  })
  initialize()
})()
