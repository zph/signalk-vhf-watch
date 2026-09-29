(() => {
  'use strict'
  const API = new URL('../plugins/signalk-vhf-watch/api/', window.location.href).pathname
  const $ = (selector) => document.querySelector(selector)
  const connection = $('#connection')
  const regionSelect = $('#region')
  const slotAMode = $('#slot-a-mode')
  const slotAChannel = $('#slot-a-channel')
  const slotBChannel = $('#slot-b-channel')
  const slotAPurpose = $('#slot-a-purpose')
  const slotBPurpose = $('#slot-b-purpose')
  const signalBar = $('#signal-bar')
  const signalValue = $('#signal-value')
  const receiverState = $('#receiver-state')
  const replayList = $('#replay-list')
  const dscList = $('#dsc-list')
  const dscEmpty = $('#dsc-empty')
  const dscModeLabel = $('#dsc-mode-label')
  const empty = $('#empty')
  const retention = $('#retention')
  const replaySquelch = $('#replay-squelch')
  const clearReplayDialog = $('#clear-replay-dialog')
  const timelineRange = $('#timeline-range')
  const timelineTime = $('#timeline-time')
  const timelineOffset = $('#timeline-offset')
  const timelineOldest = $('#timeline-oldest')
  const timelineAudio = $('#timeline-audio')
  const timelineOlder = $('#timeline-older')
  const timelineNewer = $('#timeline-newer')
  const timelineLatest = $('#timeline-latest')
  const frequencyMap = $('#frequency-map')
  const frequencyEmpty = $('#frequency-empty')
  const transcriptionEnabled = $('#transcription-enabled')
  const transcriptionModel = $('#transcription-model')
  const transcriptionThreads = $('#transcription-threads')
  const transcriptionStatus = $('#transcription-status')
  const archiveList = $('#archive-list')
  const archiveEmpty = $('#archive-empty')
  const archiveSummary = $('#archive-summary')
  const MINIMUM_REPLAY_SIGNAL_SECONDS = 0.35
  const SESSION_BREAK_SECONDS = 6
  let channels = []
  let poll
  let replaySquelchTouched = false
  let replayTimeline = []
  let timelineSegmentId
  let timelineFollowingLive = true
  let timelineWaitingAtEdge = false
  let timelineWindowMinutes = 120
  let timelineReceiverRows = []
  let timelineActiveSlotAChannel
  let timelineAwaitingChannel
  let singleFrequencyActive = false

  async function request(path, options) {
    const response = await fetch(API + path, { credentials: 'include', ...options })
    if (!response.ok) {
      const body = await response.json().catch(() => ({}))
      throw new Error(body.error || `Request failed (${response.status})`)
    }
    if (response.status === 204) return undefined
    return response.json()
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
    singleFrequencyActive = status.captureMode === 'single_frequency'
    const activeSlotAChannel = status.slots.A.currentChannel.id
    if (timelineActiveSlotAChannel && timelineActiveSlotAChannel !== activeSlotAChannel) {
      timelineAwaitingChannel = activeSlotAChannel
      timelineFollowingLive = true
      timelineWaitingAtEdge = false
      timelineSegmentId = undefined
      timelineAudio.pause()
      timelineAudio.removeAttribute('src')
      timelineAudio.load()
      timelineTime.textContent = `Waiting for ${channelDisplay(activeSlotAChannel)} audio…`
      timelineOffset.textContent = channelFrequencyDisplay(activeSlotAChannel)
    }
    timelineActiveSlotAChannel = activeSlotAChannel
    regionSelect.value = status.channelRegion
    slotAMode.value = status.slots.A.mode
    slotAChannel.value = status.slots.A.configuredChannel.id
    slotBChannel.value = status.slots.B.channel.id
    slotAPurpose.textContent = status.slots.A.mode === 'scan'
      ? `Scanning now: CH ${status.slots.A.currentChannel.label} · ${status.slots.A.state}`
      : status.slots.A.configuredChannel.purpose
    slotBPurpose.textContent = status.slots.B.kind === 'paused'
      ? `Paused while Slot A receives ${status.slots.A.currentChannel.label} outside the marine band`
      : status.slots.B.kind === 'dsc'
        ? 'Continuous digital selective calling watch'
        : status.slots.B.channel.purpose
    slotAMode.disabled = singleFrequencyActive
    slotBChannel.disabled = singleFrequencyActive
    dscModeLabel.textContent = singleFrequencyActive ? 'CHANNEL 70 · PAUSED FOR WEATHER' : 'CHANNEL 70 · CONTINUOUS'
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
    retention.textContent = `Up to ${status.replayMinutes} minutes / ${status.maxBufferMiB} MiB per voice slot · ${status.replaySegments} private segments across both slots`
    timelineWindowMinutes = status.replayMinutes
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
    transcriptionStatus.textContent = transcription.enabled
      ? `Local transcription on · ${transcription.state}${transcription.queued ? ` · ${transcription.queued} queued` : ''} · ${transcription.engine} · ${transcription.threads} threads`
      : transcription.available
        ? `Local transcription off · ${transcription.engine} is installed and ready`
        : 'Local transcription off · install vhf-whisper-runtime to enable it'
    if (transcription.archive) {
      archiveSummary.textContent = `${transcription.archive.records} records · ${(transcription.archive.databaseBytes / 1024 / 1024).toFixed(1)} of ${(transcription.archive.maxBytes / 1024 / 1024).toFixed(0)} MiB · up to ${transcription.archive.retentionDays} days`
    }
    setConnection(status.error ? 'error' : 'ok', status.error ? 'Receiver error' : 'Connected')
  }

  async function loadChannels() {
    const response = await request('channels')
    channels = response.channels
    regionSelect.value = response.region
    const voiceOptions = (slot) => channels.map((channel) => {
      const option = document.createElement('option')
      option.value = channel.id
      const singleFrequency = slot === 'A' && channel.requiresSingleFrequency ? ' · single-frequency; pauses Slot B + DSC' : ''
      option.textContent = `${channel.label} · ${channel.countries.join('+')} — ${channel.purpose}${singleFrequency}`
      option.disabled = slot === 'B' ? channel.availableSlotB === false : channel.availableSlotA === false
      return option
    })
    slotAChannel.replaceChildren(...voiceOptions('A'))
    const dscOption = document.createElement('option')
    dscOption.value = '70'
    dscOption.textContent = '70 · US+CA — Digital selective calling'
    slotBChannel.replaceChildren(dscOption, ...voiceOptions('B'))
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
      return {
        ...first,
        ids: group.map((record) => record.id),
        endedAt: last.endedAt,
        durationSeconds: group.reduce((sum, record) => sum + record.durationSeconds, 0),
        transcript: group.map((record) => record.transcript).filter(Boolean).join(' '),
        ...(measured.length > 0 ? { minimumDiscriminatorNoise: Math.min(...measured) } : {})
      }
    }).reverse()
  }

  function timelineIndexNear(timestamp) {
    if (replayTimeline.length === 0) return -1
    let nearest = 0
    let nearestDistance = Number.POSITIVE_INFINITY
    for (const [index, segment] of replayTimeline.entries()) {
      const distance = Math.abs(Date.parse(segment.startedAt) - timestamp)
      if (distance < nearestDistance) {
        nearest = index
        nearestDistance = distance
      }
    }
    return nearest
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

  function renderFrequencyMap() {
    const endTime = Date.now()
    const startTime = endTime - timelineWindowMinutes * 60_000
    const timeSpan = endTime - startTime
    const rows = new Map()

    for (const receiver of timelineReceiverRows) {
      rows.set(`${receiver.slot}:${receiver.frequencyHz || receiver.channel}`, { ...receiver, marks: [], floorMarks: [] })
    }

    for (const [segmentIndex, segment] of replayTimeline.entries()) {
      const frequencyHz = channelFrequency(segment.channel)
      const key = `${segment.slot}:${frequencyHz || segment.channel}`
      if (!rows.has(key)) rows.set(key, { slot: segment.slot, channel: segment.channel, frequencyHz, marks: [], floorMarks: [] })
      const segmentStart = Date.parse(segment.startedAt)
      const segmentDuration = Math.max(1, segment.durationSeconds * 1000)
      const segmentEnd = segmentStart + segmentDuration
      if (segment.minimumDiscriminatorNoise !== undefined && segmentEnd >= startTime && segmentStart <= endTime) {
        rows.get(key).floorMarks.push({ segmentStart, segmentEnd, strength: rfStrength(segment) })
      }
      for (const run of activityRuns(segment)) {
        const runStart = segmentStart + segmentDuration * run.start / segment.activity.length
        const runEnd = segmentStart + segmentDuration * run.end / segment.activity.length
        if (runEnd < startTime || runStart > endTime) continue
        rows.get(key).marks.push({ segment, segmentIndex, runStart, runEnd, activity: run.activity })
      }
    }

    const visibleRows = [...rows.values()]
      .sort((left, right) => (left.frequencyHz || Number.MAX_SAFE_INTEGER) - (right.frequencyHz || Number.MAX_SAFE_INTEGER) || left.slot.localeCompare(right.slot))

    const rowElements = visibleRows.map((row) => {
      const wrapper = document.createElement('div')
      wrapper.className = 'frequency-row'
      const label = document.createElement('div')
      label.className = 'frequency-label'
      const channel = document.createElement('strong')
      channel.textContent = `Slot ${row.slot} · ${channelDisplay(row.channel)}`
      const frequency = document.createElement('span')
      frequency.textContent = row.frequencyHz ? `${(row.frequencyHz / 1_000_000).toFixed(3)} MHz` : 'Frequency unavailable'
      label.append(channel, frequency)
      const track = document.createElement('div')
      track.className = 'frequency-track'
      track.setAttribute('aria-label', row.marks.length > 0
        ? `${row.marks.length} detected activity bursts; faint trace is below squelch`
        : 'Listening; faint trace is below squelch; no activity bursts above squelch yet')
      for (const floor of row.floorMarks) {
        const left = Math.max(0, Math.min(100, (floor.segmentStart - startTime) / timeSpan * 100))
        const right = Math.max(left, Math.min(100, (floor.segmentEnd - startTime) / timeSpan * 100))
        const trace = document.createElement('span')
        trace.className = 'frequency-floor'
        trace.setAttribute('aria-hidden', 'true')
        trace.style.setProperty('--burst-left', `${left}%`)
        trace.style.setProperty('--burst-width', `${Math.max(0.08, right - left)}%`)
        trace.style.setProperty('--floor-opacity', (0.05 + floor.strength * 0.2).toFixed(2))
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
        button.setAttribute('aria-label', `Listen to Slot ${row.slot}, ${channelDisplay(row.channel)}, ${frequency.textContent}, activity burst at ${time}`)
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
    const hasActivity = visibleRows.some((row) => row.marks.length > 0)
    frequencyMap.hidden = visibleRows.length === 0
    frequencyEmpty.hidden = hasActivity
    frequencyEmpty.textContent = visibleRows.length === 0
      ? 'Starting receiver…'
      : 'Listening — no bursts above squelch yet.'
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
    timelineOlder.disabled = index === 0
    timelineNewer.disabled = index === replayTimeline.length - 1
    const source = `${API}replay/${segment.id}/continuous.wav?squelch=${encodeURIComponent(replaySquelch.value)}`
    if (timelineAudio.getAttribute('src') !== source) timelineAudio.src = source
    if (autoplay) void timelineAudio.play().catch(() => {})
    highlightFrequencyBurst()
  }

  function latestActiveTimelineIndex() {
    return replayTimeline.findLastIndex((segment) =>
      segment.slot === 'A' && segment.channel === timelineActiveSlotAChannel
    )
  }

  function selectLatestActiveTimeline(autoplay = false) {
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
      timelineOlder.disabled = true
      timelineNewer.disabled = true
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

  function moveTimeline(milliseconds) {
    const current = replayTimeline.find((segment) => segment.id === timelineSegmentId)
    if (!current) return
    timelineFollowingLive = false
    selectTimelineIndex(timelineIndexNear(Date.parse(current.startedAt) + milliseconds))
  }

  function replayRow(segment) {
    const item = document.createElement('li')
    item.className = 'replay-item'
    const time = document.createElement('div')
    time.className = 'replay-time'
    time.textContent = new Date(segment.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    const detail = document.createElement('div')
    detail.className = 'replay-detail'
    const quality = segment.minimumDiscriminatorNoise === undefined
      ? ''
      : ` · RF noise ${segment.minimumDiscriminatorNoise.toFixed(2)}`
    const label = document.createElement('div')
    label.textContent = `Slot ${segment.slot} · ${channelDisplay(segment.channel)} · ${channelFrequencyDisplay(segment.channel)} · ${segment.durationSeconds.toFixed(1)} sec${quality}`
    detail.append(label)
    if (Array.isArray(segment.activity)) {
      const namespace = 'http://www.w3.org/2000/svg'
      const chart = document.createElementNS(namespace, 'svg')
      chart.classList.add('activity-chart')
      chart.setAttribute('viewBox', `0 0 ${segment.activity.length * 2} 20`)
      chart.setAttribute('role', 'img')
      const activeSeconds = replayActiveSeconds(segment) ?? 0
      chart.setAttribute('aria-label', `${activeSeconds.toFixed(1)} seconds of detected sound`)
      for (const [index, value] of segment.activity.entries()) {
        const bar = document.createElementNS(namespace, 'rect')
        const height = Math.max(1, value * 18)
        bar.setAttribute('x', String(index * 2))
        bar.setAttribute('y', String(20 - height))
        bar.setAttribute('width', '1.5')
        bar.setAttribute('height', String(height))
        chart.append(bar)
      }
      const caption = document.createElement('span')
      caption.className = 'activity-caption'
      caption.textContent = `${activeSeconds.toFixed(1)} sec passes squelch ${replaySquelch.value}`
      detail.append(chart, caption)
    }
    if (segment.transcription?.status === 'complete' && segment.transcription.text) {
      const transcript = document.createElement('div')
      transcript.className = 'transcript'
      const heading = document.createElement('strong')
      heading.textContent = 'Transcript: '
      transcript.append(heading, document.createTextNode(segment.transcription.text))
      detail.append(transcript)
    } else if (['queued', 'transcribing'].includes(segment.transcription?.status)) {
      const transcript = document.createElement('div')
      transcript.className = 'transcript'
      transcript.textContent = segment.transcription.status === 'queued' ? 'Transcript queued…' : 'Transcribing locally…'
      detail.append(transcript)
    } else if (segment.transcription?.status === 'error') {
      const transcript = document.createElement('div')
      transcript.className = 'transcript'
      transcript.textContent = `Transcription failed: ${segment.transcription.error}`
      detail.append(transcript)
    }
    const audio = document.createElement('audio')
    audio.controls = true
    audio.preload = 'none'
    audio.src = `${API}replay-session.wav?ids=${encodeURIComponent(segment.ids.join(','))}&squelch=${encodeURIComponent(replaySquelch.value)}`
    const deleteButton = document.createElement('button')
    deleteButton.className = 'danger replay-delete'
    deleteButton.type = 'button'
    deleteButton.textContent = 'Delete'
    deleteButton.setAttribute('aria-label', `Delete radio session from ${time.textContent}`)
    deleteButton.addEventListener('click', async () => {
      deleteButton.disabled = true
      try {
        for (const id of segment.ids) await request(`replay/${id}`, { method: 'DELETE' })
        await updateReplay()
      } catch (error) {
        deleteButton.disabled = false
        setConnection('error', error.message)
      }
    })
    item.append(time, detail, audio, deleteButton)
    return item
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
      replayList.replaceChildren(...visibleSessions.map(replayRow))
      empty.hidden = visibleSessions.length > 0
      empty.textContent = segments.length === 0
        ? 'Waiting for the first replay segment…'
        : `No radio activity passes squelch ${replaySquelch.value} yet.`
    } catch (error) {
      empty.hidden = false
      empty.textContent = error.message
    }
  }

  function dscRow(message) {
    const item = document.createElement('li')
    item.className = `replay-item dsc-${message.category}`
    const time = document.createElement('div')
    time.className = 'replay-time'
    time.textContent = new Date(message.receivedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    const detail = document.createElement('div')
    detail.className = 'replay-detail'
    const source = message.selfMmsi ? `MMSI ${message.selfMmsi}` : 'unknown station'
    const position = message.position ? ` · ${message.position.latitude.toFixed(4)}, ${message.position.longitude.toFixed(4)}` : ''
    detail.textContent = `${message.category.toUpperCase()} · ${message.format} · ${source}${message.nature ? ` · ${message.nature}` : ''}${position}${message.validCharacters ? '' : ' · CHECK DECODE'}`
    item.append(time, detail)
    return item
  }

  async function updateDsc() {
    try {
      const { messages } = await request('dsc')
      dscList.replaceChildren(...messages.map(dscRow))
      dscEmpty.hidden = messages.length > 0
      dscEmpty.textContent = 'Waiting for a decoded DSC call…'
    } catch (error) {
      dscEmpty.hidden = false
      dscEmpty.textContent = error.message
    }
  }

  function archiveRow(record) {
    const item = document.createElement('li')
    item.className = 'replay-item archive-item'
    const time = document.createElement('div')
    time.className = 'replay-time'
    time.textContent = new Date(record.startedAt).toLocaleString([], {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit'
    })
    const detail = document.createElement('div')
    detail.className = 'replay-detail'
    const metadata = document.createElement('div')
    const quality = record.minimumDiscriminatorNoise === undefined ? '' : ` · RF noise ${record.minimumDiscriminatorNoise.toFixed(2)}`
    metadata.textContent = `CH ${record.channel} · ${record.durationSeconds.toFixed(1)} sec${quality}`
    const transcript = document.createElement('div')
    transcript.className = 'transcript archive-transcript'
    transcript.textContent = record.transcript || 'No speech recognized.'
    detail.append(metadata, transcript)
    const audio = document.createElement('audio')
    audio.controls = true
    audio.preload = 'none'
    audio.src = `${API}transcript-session.wav?ids=${encodeURIComponent(record.ids.join(','))}`
    item.append(time, detail, audio)
    return item
  }

  async function updateArchive() {
    try {
      const { records, archive } = await request('transcripts?limit=500')
      const sessions = groupArchiveSessions(records)
      archiveList.replaceChildren(...sessions.map(archiveRow))
      archiveEmpty.hidden = sessions.length > 0
      archiveEmpty.textContent = 'No archived transcripts yet.'
      if (archive) {
        archiveSummary.textContent = `${archive.records} records · ${(archive.databaseBytes / 1024 / 1024).toFixed(1)} of ${(archive.maxBytes / 1024 / 1024).toFixed(0)} MiB · up to ${archive.retentionDays} days`
      }
    } catch (error) {
      archiveEmpty.hidden = false
      archiveEmpty.textContent = error.message
    }
  }

  async function configureSlots() {
    const selected = channels.find((channel) => channel.id === slotAChannel.value)
    if (selected?.requiresSingleFrequency) slotAMode.value = 'fixed'
    slotAMode.disabled = true
    slotAChannel.disabled = true
    slotBChannel.disabled = true
    try {
      const status = await request('slots', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: slotAMode.value, slotAChannel: slotAChannel.value, slotBChannel: slotBChannel.value })
      })
      renderStatus(status)
    } catch (error) {
      setConnection('error', error.message)
    } finally {
      slotAMode.disabled = singleFrequencyActive
      slotAChannel.disabled = false
      slotBChannel.disabled = singleFrequencyActive
    }
  }

  async function changeRegion() {
    regionSelect.disabled = true
    slotAChannel.disabled = true
    slotBChannel.disabled = true
    try {
      const status = await request('region', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ region: regionSelect.value })
      })
      await loadChannels()
      renderStatus(status)
    } catch (error) {
      setConnection('error', error.message)
    } finally {
      regionSelect.disabled = false
      slotAChannel.disabled = false
      slotAMode.disabled = singleFrequencyActive
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
      await Promise.all([updateStatus(), updateReplay(), updateDsc(), updateArchive()])
      poll = window.setInterval(updateStatus, 1000)
      window.setInterval(updateReplay, 5000)
      window.setInterval(updateDsc, 5000)
      window.setInterval(updateArchive, 15_000)
    } catch (error) {
      setConnection('error', error.message)
    }
  }

  slotAMode.addEventListener('change', configureSlots)
  slotAChannel.addEventListener('change', configureSlots)
  slotBChannel.addEventListener('change', configureSlots)
  regionSelect.addEventListener('change', changeRegion)
  $('#refresh').addEventListener('click', updateReplay)
  $('#clear').addEventListener('click', () => clearReplayDialog.showModal())
  clearReplayDialog.addEventListener('close', () => {
    if (clearReplayDialog.returnValue === 'delete') void clearReplay()
  })
  $('#refresh-dsc').addEventListener('click', updateDsc)
  $('#clear-dsc').addEventListener('click', clearDsc)
  $('#refresh-archive').addEventListener('click', updateArchive)
  replaySquelch.addEventListener('change', () => {
    replaySquelchTouched = true
    void updateReplay()
  })
  timelineRange.addEventListener('input', () => {
    timelineFollowingLive = false
    timelineWaitingAtEdge = false
    selectTimelineIndex(Number(timelineRange.value))
  })
  timelineOlder.addEventListener('click', () => moveTimeline(-60_000))
  timelineNewer.addEventListener('click', () => moveTimeline(60_000))
  timelineLatest.addEventListener('click', () => {
    selectLatestActiveTimeline(true)
  })
  timelineAudio.addEventListener('ended', () => {
    const index = replayTimeline.findIndex((segment) => segment.id === timelineSegmentId)
    if (index >= 0 && index < replayTimeline.length - 1) selectTimelineIndex(index + 1, true)
    else if (timelineFollowingLive) timelineWaitingAtEdge = true
  })
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
  window.addEventListener('pagehide', () => {
    window.clearInterval(poll)
  })
  initialize()
})()
