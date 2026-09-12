(() => {
  'use strict'
  const API = new URL('../plugins/signalk-vhf-watch/api/', window.location.href).pathname
  const $ = (selector) => document.querySelector(selector)
  const connection = $('#connection')
  const channelSelect = $('#channel')
  const purpose = $('#channel-purpose')
  const signalBar = $('#signal-bar')
  const signalValue = $('#signal-value')
  const receiverState = $('#receiver-state')
  const listenButton = $('#listen')
  const liveAudio = $('#live-audio')
  const replayList = $('#replay-list')
  const empty = $('#empty')
  const retention = $('#retention')
  let channels = []
  let listening = false
  let poll

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
    if (channelSelect.value !== status.channel.id) channelSelect.value = status.channel.id
    purpose.textContent = status.channel.purpose
    const percentage = Math.min(100, Math.round(status.level * 650))
    signalBar.style.width = `${percentage}%`
    signalValue.textContent = `${percentage}%`
    receiverState.textContent = status.error || `${status.receiverState} · ${status.mode === 'demo' ? 'Demo source' : 'RTL-SDR'}`
    retention.textContent = `Up to ${status.replayMinutes} minutes / ${status.maxBufferMiB} MiB private buffer · ${status.replaySegments} segments · ${status.liveListeners} live listener${status.liveListeners === 1 ? '' : 's'}`
    setConnection(status.error ? 'error' : 'ok', status.error ? 'Receiver error' : 'Connected')
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
    detail.textContent = `CH ${segment.channel} · ${segment.durationSeconds.toFixed(1)} sec · level ${Math.round(segment.level * 650)}%`
    const audio = document.createElement('audio')
    audio.controls = true
    audio.preload = 'none'
    audio.src = `${API}replay/${segment.id}.wav`
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
        liveAudio.src = `${API}live.wav?channel=${encodeURIComponent(channelSelect.value)}&t=${Date.now()}`
        await liveAudio.play()
      }
    } catch (error) {
      setConnection('error', error.message)
    } finally {
      channelSelect.disabled = false
    }
  }

  async function toggleListen() {
    if (listening) {
      liveAudio.pause()
      liveAudio.removeAttribute('src')
      liveAudio.load()
      listening = false
      listenButton.textContent = 'Listen live'
      listenButton.classList.remove('listening')
      return
    }
    liveAudio.src = `${API}live.wav?t=${Date.now()}`
    try {
      await liveAudio.play()
      listening = true
      listenButton.textContent = 'Stop listening'
      listenButton.classList.add('listening')
    } catch (error) {
      setConnection('error', `Audio could not start: ${error.message}`)
    }
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

  async function initialize() {
    try {
      const channelResponse = await request('channels')
      channels = channelResponse.channels
      channelSelect.replaceChildren(...channels.map((channel) => {
        const option = document.createElement('option')
        option.value = channel.id
        option.textContent = `${channel.label} — ${channel.purpose}`
        return option
      }))
      await Promise.all([updateStatus(), updateReplay()])
      poll = window.setInterval(updateStatus, 1000)
      window.setInterval(updateReplay, 5000)
    } catch (error) {
      setConnection('error', error.message)
    }
  }

  channelSelect.addEventListener('change', tune)
  listenButton.addEventListener('click', toggleListen)
  $('#refresh').addEventListener('click', updateReplay)
  $('#clear').addEventListener('click', clearReplay)
  window.addEventListener('pagehide', () => {
    window.clearInterval(poll)
    liveAudio.pause()
  })
  initialize()
})()
