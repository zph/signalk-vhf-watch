(() => {
  'use strict'
  const API = new URL('../plugins/signalk-vhf-watch/api/', window.location.href).pathname
  const $ = (selector) => document.querySelector(selector)
  const connection = $('#connection')
  const regionSelect = $('#region')
  const channelSelect = $('#channel')
  const purpose = $('#channel-purpose')
  const signalBar = $('#signal-bar')
  const signalValue = $('#signal-value')
  const receiverState = $('#receiver-state')
  const listenButton = $('#listen')
  const liveSquelch = $('#live-squelch')
  const liveStatus = $('#live-status')
  const replayList = $('#replay-list')
  const dscList = $('#dsc-list')
  const dscEmpty = $('#dsc-empty')
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
  const transcriptionEnabled = $('#transcription-enabled')
  const transcriptionStatus = $('#transcription-status')
  const MINIMUM_REPLAY_SIGNAL_SECONDS = 0.35
  let channels = []
  let listening = false
  let liveAbort
  let liveContext
  let liveGeneration = 0
  let poll
  let replaySquelchTouched = false
  let replayTimeline = []
  let timelineSegmentId
  let timelineFollowingLive = true

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

  function renderStatus(status) {
    regionSelect.value = status.channelRegion
    if (channelSelect.value !== status.channel.id) channelSelect.value = status.channel.id
    purpose.textContent = status.channel.purpose
    const percentage = Math.min(100, Math.round(status.level * 650))
    signalBar.style.width = `${percentage}%`
    signalValue.textContent = `${percentage}%`
    if (!replaySquelchTouched) replaySquelch.value = String(status.squelch)
    const dsc = status.dscWatch?.continuous ? ' · DSC 70 continuous' : ''
    const metrics = status.receiverMetrics
    const health = metrics && (metrics.restarts || metrics.droppedIqChunks)
      ? ` · ${metrics.restarts} restarts · ${metrics.droppedIqChunks} IQ drops`
      : ''
    receiverState.textContent = status.error || `${status.receiverState} · ${status.mode === 'demo' ? 'Demo source' : 'Wideband RTL-SDR'}${dsc}${health}`
    retention.textContent = `Up to ${status.replayMinutes} minutes / ${status.maxBufferMiB} MiB private buffer · ${status.replaySegments} segments · ${status.liveListeners} live listener${status.liveListeners === 1 ? '' : 's'}`
    const transcription = status.transcription
    transcriptionEnabled.checked = transcription.enabled
    transcriptionEnabled.disabled = !transcription.available && !transcription.enabled
    transcriptionStatus.textContent = transcription.enabled
      ? `Local transcription on · ${transcription.state}${transcription.queued ? ` · ${transcription.queued} queued` : ''} · ${transcription.engine}`
      : transcription.available
        ? `Local transcription off · ${transcription.engine} is installed and ready`
        : 'Local transcription off · install vhf-whisper-runtime to enable it'
    setConnection(status.error ? 'error' : 'ok', status.error ? 'Receiver error' : 'Connected')
  }

  async function loadChannels() {
    const response = await request('channels')
    channels = response.channels
    regionSelect.value = response.region
    channelSelect.replaceChildren(...channels.map((channel) => {
      const option = document.createElement('option')
      option.value = channel.id
      option.textContent = `${channel.label} · ${channel.countries.join('+')} — ${channel.purpose}`
      option.disabled = channel.available === false
      return option
    }))
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

  function selectTimelineIndex(requestedIndex, autoplay = false) {
    if (replayTimeline.length === 0) return
    const index = Math.max(0, Math.min(replayTimeline.length - 1, requestedIndex))
    const segment = replayTimeline[index]
    const startedAt = new Date(segment.startedAt)
    const ageMinutes = Math.max(0, Math.round((Date.now() - startedAt.getTime()) / 60_000))
    timelineRange.value = String(index)
    timelineSegmentId = segment.id
    timelineTime.textContent = startedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    timelineOffset.textContent = `${ageMinutes === 0 ? 'Less than a minute' : `${ageMinutes} min`} ago · CH ${segment.channel}`
    timelineOlder.disabled = index === 0
    timelineNewer.disabled = index === replayTimeline.length - 1
    const source = `${API}replay/${segment.id}.wav?squelch=${encodeURIComponent(replaySquelch.value)}`
    if (timelineAudio.getAttribute('src') !== source) timelineAudio.src = source
    if (autoplay) void timelineAudio.play().catch(() => {})
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
      return
    }
    const oldest = new Date(replayTimeline[0].startedAt)
    timelineOldest.textContent = oldest.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    const selectedIndex = timelineFollowingLive
      ? replayTimeline.length - 1
      : Math.max(0, replayTimeline.findIndex((segment) => segment.id === timelineSegmentId))
    selectTimelineIndex(selectedIndex)
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
    const rawPercentage = Math.min(100, Math.round(segment.level * 650))
    label.textContent = `CH ${segment.channel} · ${segment.durationSeconds.toFixed(1)} sec · raw level ${rawPercentage}%${quality}`
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
    audio.src = `${API}replay/${segment.id}.wav?squelch=${encodeURIComponent(replaySquelch.value)}`
    const deleteButton = document.createElement('button')
    deleteButton.className = 'danger replay-delete'
    deleteButton.type = 'button'
    deleteButton.textContent = 'Delete'
    deleteButton.setAttribute('aria-label', `Delete radio segment from ${time.textContent}`)
    deleteButton.addEventListener('click', async () => {
      deleteButton.disabled = true
      try {
        await request(`replay/${segment.id}`, { method: 'DELETE' })
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
      const visibleSegments = segments.filter((segment) => {
        const activeSeconds = replayActiveSeconds(segment)
        return activeSeconds === undefined || activeSeconds >= MINIMUM_REPLAY_SIGNAL_SECONDS
      })
      replayList.replaceChildren(...visibleSegments.map(replayRow))
      empty.hidden = visibleSegments.length > 0
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

  async function tune() {
    channelSelect.disabled = true
    try {
      const status = await request('channel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: channelSelect.value })
      })
      renderStatus(status)
      purpose.textContent = channelPurpose(channelSelect.value)
      if (listening) {
        await restartLiveStream()
      }
    } catch (error) {
      setConnection('error', error.message)
    } finally {
      channelSelect.disabled = false
    }
  }

  async function changeRegion() {
    regionSelect.disabled = true
    channelSelect.disabled = true
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
      channelSelect.disabled = false
    }
  }

  function stopLiveStream() {
    liveGeneration += 1
    liveAbort?.abort()
    liveAbort = undefined
    if (liveContext) void liveContext.close()
    liveContext = undefined
    listening = false
    listenButton.textContent = 'Listen live'
    listenButton.classList.remove('listening')
    liveStatus.textContent = 'Not streaming'
  }

  async function pumpLivePcm(response, context, generation) {
    const reader = response.body.getReader()
    let pending = new Uint8Array(0)
    let headerBytes = 44
    let playAt = context.currentTime + 0.12
    while (generation === liveGeneration) {
      const { value, done } = await reader.read()
      if (done) throw new Error('Live stream ended')
      let chunk = value
      if (headerBytes > 0) {
        const skipped = Math.min(headerBytes, chunk.length)
        chunk = chunk.subarray(skipped)
        headerBytes -= skipped
      }
      if (chunk.length === 0) continue
      const joined = new Uint8Array(pending.length + chunk.length)
      joined.set(pending)
      joined.set(chunk, pending.length)
      const usable = joined.length - joined.length % 2
      pending = joined.slice(usable)
      if (usable === 0) continue
      const samples = usable / 2
      const audioBuffer = context.createBuffer(1, samples, 16_000)
      const output = audioBuffer.getChannelData(0)
      const view = new DataView(joined.buffer, joined.byteOffset, usable)
      for (let index = 0; index < samples; index += 1) {
        output[index] = view.getInt16(index * 2, true) / 32_768
      }
      const source = context.createBufferSource()
      source.buffer = audioBuffer
      source.connect(context.destination)
      playAt = Math.max(playAt, context.currentTime + 0.06)
      source.start(playAt)
      playAt += audioBuffer.duration
    }
  }

  async function startLiveStream() {
    const generation = ++liveGeneration
    liveAbort = new AbortController()
    liveContext = new AudioContext({ sampleRate: 16_000 })
    try {
      await liveContext.resume()
      const response = await fetch(
        `${API}live.wav?squelch=${encodeURIComponent(liveSquelch.value)}&t=${Date.now()}`,
        { credentials: 'include', signal: liveAbort.signal }
      )
      if (!response.ok || !response.body) throw new Error(`Live stream failed (${response.status})`)
      listening = true
      listenButton.textContent = 'Stop listening'
      listenButton.classList.add('listening')
      liveStatus.textContent = liveSquelch.value === '0'
        ? 'Streaming raw audio'
        : `Streaming · squelch ${liveSquelch.value} · silence means the channel is quiet`
      void pumpLivePcm(response, liveContext, generation).catch((error) => {
        if (generation !== liveGeneration || error.name === 'AbortError') return
        stopLiveStream()
        liveStatus.textContent = `Stream failed: ${error.message}`
      })
    } catch (error) {
      stopLiveStream()
      liveStatus.textContent = 'Stream failed'
      setConnection('error', `Audio could not start: ${error.message}`)
    }
  }

  async function restartLiveStream() {
    stopLiveStream()
    await startLiveStream()
  }

  async function toggleListen() {
    if (listening) {
      stopLiveStream()
      return
    }
    await startLiveStream()
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
      await Promise.all([updateStatus(), updateReplay(), updateDsc()])
      poll = window.setInterval(updateStatus, 1000)
      window.setInterval(updateReplay, 5000)
      window.setInterval(updateDsc, 5000)
    } catch (error) {
      setConnection('error', error.message)
    }
  }

  channelSelect.addEventListener('change', tune)
  regionSelect.addEventListener('change', changeRegion)
  listenButton.addEventListener('click', toggleListen)
  liveSquelch.addEventListener('change', async () => {
    if (!listening) return
    await restartLiveStream()
  })
  $('#refresh').addEventListener('click', updateReplay)
  $('#clear').addEventListener('click', () => clearReplayDialog.showModal())
  clearReplayDialog.addEventListener('close', () => {
    if (clearReplayDialog.returnValue === 'delete') void clearReplay()
  })
  $('#refresh-dsc').addEventListener('click', updateDsc)
  $('#clear-dsc').addEventListener('click', clearDsc)
  replaySquelch.addEventListener('change', () => {
    replaySquelchTouched = true
    void updateReplay()
  })
  timelineRange.addEventListener('input', () => {
    timelineFollowingLive = false
    selectTimelineIndex(Number(timelineRange.value))
  })
  timelineOlder.addEventListener('click', () => moveTimeline(-60_000))
  timelineNewer.addEventListener('click', () => moveTimeline(60_000))
  timelineLatest.addEventListener('click', () => {
    timelineFollowingLive = true
    selectTimelineIndex(replayTimeline.length - 1)
  })
  timelineAudio.addEventListener('ended', () => {
    const index = replayTimeline.findIndex((segment) => segment.id === timelineSegmentId)
    if (index >= 0 && index < replayTimeline.length - 1) selectTimelineIndex(index + 1, true)
  })
  timelineAudio.addEventListener('play', () => { timelineFollowingLive = false })
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
    } catch (error) {
      setConnection('error', error.message)
      await updateStatus()
    } finally {
      transcriptionEnabled.disabled = false
    }
  })
  window.addEventListener('pagehide', () => {
    window.clearInterval(poll)
    stopLiveStream()
  })
  initialize()
})()
