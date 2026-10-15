(() => {
  'use strict'

  class MessageListener {
    constructor(audio, { request, sourceFor, onStatus = () => {}, onActive = () => {} }) {
      Object.assign(this, { audio, request, sourceFor, onStatus, onActive })
      this.active = false
      this.generation = 0
      this.queue = []
      this.skipped = 0
      const finish = () => {
        if (!this.active || !this.playing || audio.currentSrc !== this.source) return
        this.playing = false
        this.currentId = undefined
        void this.advance()
      }
      audio.addEventListener('ended', finish)
      audio.addEventListener('error', () => { void this.audioError() })
    }

    async start() {
      this.stop('')
      const generation = this.generation
      this.active = true
      this.skipped = 0
      this.onActive(true)
      this.onStatus('Connecting to delayed listening…')
      try {
        const feed = await this.request('message-listen')
        if (generation !== this.generation) return
        if (!feed.enabled) throw new Error('Enable transcription in Settings to listen with message mutes.')
        this.session = feed.session
        this.cursor = feed.cursor
        this.onStatus('Waiting for completed messages · all captured channels · audio waits for recognition.')
        this.timer = setInterval(() => { void this.poll() }, 2_000)
      } catch (error) {
        if (generation === this.generation) this.stop(error.message)
      }
    }

    async poll() {
      const generation = this.generation
      if (!this.active || this.polling === generation) return
      this.polling = generation
      try {
        const feed = await this.request(`message-listen?after=${this.cursor}`)
        if (generation !== this.generation) return
        if (!feed.enabled) throw new Error('Transcription stopped. Message listening stopped; enable transcription to reconnect.')
        if (feed.session !== this.session) throw new Error('The receiver restarted. Tap Listen to reconnect.')
        if (feed.gap) throw new Error('Listening fell behind the retained audio. Review Recent activity, then tap Listen to reconnect.')
        this.cursor = feed.cursor
        this.queue.push(...feed.messages)
        if (this.queue.length > 128) throw new Error('Listening fell behind. Review Recent activity, then tap Listen to reconnect.')
        await this.recheckCurrent()
        if (!this.playing) await this.advance()
      } catch (error) {
        if (generation === this.generation) this.stop(`Listening stopped: ${error.message}`)
      } finally {
        if (this.polling === generation) this.polling = undefined
      }
    }

    async recheckCurrent() {
      const id = this.currentId
      if (!this.active || id === undefined) return
      const generation = this.generation
      const current = await this.request(`message-listen/${id}/status?session=${encodeURIComponent(this.session)}`)
      if (generation !== this.generation || this.currentId !== id || !current.mute) return
      this.audio.pause()
      this.audio.removeAttribute('src')
      this.audio.load()
      this.currentId = undefined
      this.playing = false
      this.skipped += 1
    }

    async audioError() {
      if (!this.active || !this.playing || this.audio.currentSrc !== this.source) return
      const generation = this.generation
      try {
        // A rule can be saved between the metadata check and the WAV request.
        await this.recheckCurrent()
        if (generation !== this.generation) return
        if (!this.playing) { await this.advance(); return }
        this.stop('Message audio is unavailable. Tap Listen to reconnect; recordings remain in Recent activity.')
      } catch (error) {
        if (generation === this.generation) this.stop(`Listening stopped: ${error.message}`)
      }
    }

    async advance() {
      const generation = this.generation
      if (!this.active || this.playing || this.advancing === generation) return
      this.advancing = generation
      try {
        while (this.active && generation === this.generation && this.queue.length) {
          const queued = this.queue.shift()
          // Recheck at playback time: a mute may have changed since this message was queued.
          const message = await this.request(`message-listen/${queued.id}/status?session=${encodeURIComponent(this.session)}`)
          if (generation !== this.generation) return
          if (message.mute) { this.skipped += 1; continue }
          this.playing = true
          this.currentId = message.id
          this.audio.src = this.sourceFor(message)
          this.source = this.audio.src
          this.audio.load()
          this.onStatus(`Listening with mutes · CH ${message.channel} · ${new Date(message.startedAt).toLocaleTimeString()}${message.transcript ? '' : ' · speech not recognized; playing original audio'}`)
          await this.audio.play()
          return
        }
        if (this.active && generation === this.generation) {
          this.onStatus(`Waiting for completed messages · all captured channels · ${this.skipped} muted this session.`)
        }
      } catch (error) {
        if (generation === this.generation) this.stop(`Listening stopped: ${error.message}`)
      } finally {
        if (this.advancing === generation) this.advancing = undefined
      }
    }

    stop(message = 'Listening stopped.') {
      this.generation += 1
      clearInterval(this.timer)
      this.active = false
      this.playing = false
      this.currentId = undefined
      this.queue = []
      this.audio.pause()
      this.audio.removeAttribute('src')
      this.audio.load()
      this.source = ''
      this.onActive(false)
      if (message) this.onStatus(message)
    }
  }

  window.VHFMessageListener = MessageListener
})()
