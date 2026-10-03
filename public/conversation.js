(() => {
  'use strict'

  function clipBounds(record) {
    const startedAt = Date.parse(record.startedAt)
    const duration = Math.max(0, Number(record.durationSeconds) || 0)
    const startOffset = Math.max(0, Math.min(duration, Number(record.activityStartSeconds) || 0))
    const endOffset = Math.max(startOffset, Math.min(duration, record.activityEndSeconds === undefined ? duration : Number(record.activityEndSeconds)))
    return { start: startedAt + startOffset * 1_000, end: startedAt + endOffset * 1_000 }
  }

  function rangeBounds(records, range, now = Date.now()) {
    if (range === 'hour') return { start: now - 60 * 60_000, end: now }
    if (range === 'day') return { start: now - 24 * 60 * 60_000, end: now }
    const bounds = records.map(clipBounds).filter((clip) => Number.isFinite(clip.start) && Number.isFinite(clip.end))
    if (!bounds.length) return { start: now - 60 * 60_000, end: now }
    const start = Math.min(...bounds.map((clip) => clip.start))
    const end = Math.max(...bounds.map((clip) => clip.end))
    const padding = Math.max(30_000, (end - start) * .04)
    return { start: start - padding, end: end + padding }
  }

  function selectConversation(records, channel, range, now = Date.now()) {
    const channelRecords = records
      .filter((record) => String(record.channel) === String(channel))
      .map((record) => ({ record, ...clipBounds(record) }))
      .filter((clip) => Number.isFinite(clip.start) && Number.isFinite(clip.end) && clip.end > clip.start)
      .sort((left, right) => left.start - right.start || left.record.id - right.record.id)
    const window = rangeBounds(channelRecords.map((clip) => clip.record), range, now)
    return { window, clips: channelRecords.filter((clip) => clip.end >= window.start && clip.start <= window.end) }
  }

  function rangeForSelection(records, range, record, now = Date.now()) {
    const window = rangeBounds(records, range, now)
    const bounds = clipBounds(record)
    return bounds.end < window.start || bounds.start > window.end ? 'all' : range
  }

  class ConversationPlayer {
    constructor(audio, { sourceFor, onCurrent = () => {}, onStatus = () => {} }) {
      this.audio = audio
      this.sourceFor = sourceFor
      this.onCurrent = onCurrent
      this.onStatus = onStatus
      this.queue = []
      this.index = -1
      this.failures = 0
      this.token = 0
      this.activeSource = ''
      audio.addEventListener('ended', () => { if (this.queue.length && audio.currentSrc === this.activeSource) this.advance() })
      audio.addEventListener('error', () => { if (this.queue.length && audio.currentSrc === this.activeSource) this.skipUnavailable() })
    }

    play(records, startIndex = 0, sequence = false) {
      this.stop()
      this.queue = sequence ? records.slice(startIndex) : records.slice(startIndex, startIndex + 1)
      this.index = -1
      this.failures = 0
      if (!this.queue.length) {
        this.onStatus('No playable clips in this time range.')
        return
      }
      this.advance()
    }

    playFrom(records, recordId, sequence = true) {
      const index = records.findIndex((record) => String(record.id) === String(recordId))
      if (index < 0) {
        this.onStatus('That clip is no longer available in this time range.')
        return false
      }
      this.play(records, index, sequence)
      return true
    }

    updateRecords(records) {
      if (!this.queue.length) return
      const active = this.queue[this.index]
      if (!records.some((record) => String(record.id) === String(active?.id))) {
        this.stop()
        this.onCurrent(null)
        this.onStatus('The playing clip is no longer available.')
      }
    }

    advance() {
      if (this.index + 1 >= this.queue.length) {
        this.finish()
        return
      }
      this.index += 1
      this.token += 1
      const record = this.queue[this.index]
      const token = this.token
      this.onCurrent(record)
      this.onStatus(`Playing ${new Date(clipBounds(record).start).toLocaleString()}`)
      this.audio.src = this.sourceFor(record)
      this.activeSource = this.audio.src
      this.audio.load()
      Promise.resolve(this.audio.play()).catch((error) => {
        if (token !== this.token) return
        this.stop()
        this.onStatus(`Playback could not start: ${error?.message || 'try again'}`)
      })
    }

    skipUnavailable() {
      this.failures += 1
      if (this.index + 1 < this.queue.length) this.advance()
      else this.finish()
    }

    finish() {
      const failures = this.failures
      this.stop()
      this.onCurrent(null)
      this.onStatus(failures ? `${failures} clip${failures === 1 ? '' : 's'} unavailable; conversation ended.` : 'Conversation ended.')
    }

    stop() {
      this.token += 1
      this.audio.pause()
      this.audio.removeAttribute('src')
      this.audio.load()
      this.activeSource = ''
      this.queue = []
      this.index = -1
    }
  }

  window.VHFConversation = { clipBounds, rangeBounds, selectConversation, rangeForSelection, ConversationPlayer }
})()
