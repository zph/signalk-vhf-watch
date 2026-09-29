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
  let channels = []
  let listening = false
  let liveAbort
  let liveContext
  let liveGeneration = 0
  let poll
  let replaySquelchTouched = false

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
    detail.textContent = `CH ${segment.channel} · ${segment.durationSeconds.toFixed(1)} sec · raw level ${Math.round(segment.level * 650)}%${quality}`
    const audio = document.createElement('audio')
    audio.controls = true
    audio.preload = 'none'
    audio.src = `${API}replay/${segment.id}.wav?squelch=${encodeURIComponent(replaySquelch.value)}`
    item.append(time, detail, audio)
    return item
  }

  async function updateReplay() {
    try {
      const { segments } = await request('replay')
      replayList.replaceChildren(...segments.map(replayRow))
      empty.hidden = segments.length > 0
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
    if (!window.confirm('Clear the private rolling VHF replay buffer?')) return
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
  $('#clear').addEventListener('click', clearReplay)
  $('#refresh-dsc').addEventListener('click', updateDsc)
  $('#clear-dsc').addEventListener('click', clearDsc)
  replaySquelch.addEventListener('change', () => {
    replaySquelchTouched = true
    void updateReplay()
  })
  window.addEventListener('pagehide', () => {
    window.clearInterval(poll)
    stopLiveStream()
  })
  initialize()
})()
