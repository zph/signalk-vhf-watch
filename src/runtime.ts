import { EventEmitter } from 'node:events'
import { channelById, type VhfChannel } from './channels'
import type { VhfWatchConfig } from './config'
import { DemoReceiver, RtlFmReceiver, type AudioReceiver } from './receiver'
import { RollingReplay, type ReplaySegmentSummary } from './rolling-buffer'
import { rmsLevel } from './wav'

export interface RuntimeStatus {
  enabled: boolean
  mode: VhfWatchConfig['receiverMode']
  channel: VhfChannel
  receiverState: string
  receiving: boolean
  level: number
  sampleRate: number
  replayMinutes: number
  maxBufferMiB: number
  replaySegments: number
  liveListeners: number
  lastAudioAt?: string
  error?: string
  receiveOnly: true
}

export class VhfRuntime extends EventEmitter<{ audio: [Buffer]; status: [RuntimeStatus] }> {
  readonly config: VhfWatchConfig
  readonly replay: RollingReplay
  #channel: VhfChannel
  #receiver?: AudioReceiver
  #receiverState = 'Stopped'
  #level = 0
  #lastAudioAt?: string
  #error?: string
  #liveListeners = 0

  constructor(config: VhfWatchConfig) {
    super()
    this.config = config
    this.#channel = channelById(config.initialChannel)!
    this.replay = new RollingReplay(
      config.sampleRate,
      config.segmentSeconds,
      config.replayMinutes,
      this.#channel.id,
      config.maxBufferMiB * 1024 * 1024
    )
  }

  start(): void {
    if (!this.config.enabled) {
      this.#receiverState = 'Disabled'
      this.#emitStatus()
      return
    }
    this.#startReceiver()
  }

  stop(): void {
    this.#receiver?.stop()
    this.#receiver = undefined
    this.replay.flush()
    this.#receiverState = 'Stopped'
    this.#emitStatus()
  }

  tune(channelId: string): RuntimeStatus {
    const channel = channelById(channelId)
    if (!channel) throw new Error(`Unknown VHF channel: ${channelId}`)
    if (channel.id === this.#channel.id) return this.status()
    this.#receiver?.stop()
    this.#receiver = undefined
    this.#channel = channel
    this.replay.setChannel(channel.id)
    this.#level = 0
    this.#error = undefined
    if (this.config.enabled) this.#startReceiver()
    return this.status()
  }

  status(): RuntimeStatus {
    const segments = this.replay.list()
    return {
      enabled: this.config.enabled,
      mode: this.config.receiverMode,
      channel: this.#channel,
      receiverState: this.#receiverState,
      receiving: this.#level > 0.003,
      level: this.#level,
      sampleRate: this.config.sampleRate,
      replayMinutes: this.config.replayMinutes,
      maxBufferMiB: this.config.maxBufferMiB,
      replaySegments: segments.length,
      liveListeners: this.#liveListeners,
      ...(this.#lastAudioAt ? { lastAudioAt: this.#lastAudioAt } : {}),
      ...(this.#error ? { error: this.#error } : {}),
      receiveOnly: true
    }
  }

  segments(): ReplaySegmentSummary[] {
    return this.replay.list()
  }

  listenerJoined(): void {
    this.#liveListeners += 1
    this.#emitStatus()
  }

  listenerLeft(): void {
    this.#liveListeners = Math.max(0, this.#liveListeners - 1)
    this.#emitStatus()
  }

  #startReceiver(): void {
    const receiver = this.config.receiverMode === 'rtl_fm'
      ? new RtlFmReceiver(this.config, this.#channel)
      : new DemoReceiver(this.config.sampleRate)
    this.#receiver = receiver
    receiver.on('audio', (chunk) => {
      this.#lastAudioAt = new Date().toISOString()
      this.#level = this.#level * 0.7 + rmsLevel(chunk) * 0.3
      this.replay.append(chunk)
      this.emit('audio', chunk)
    })
    receiver.on('state', (state) => {
      this.#receiverState = state
      this.#emitStatus()
    })
    receiver.on('error', (error) => {
      this.#error = error.message
      this.#receiverState = 'Receiver unavailable'
      this.#emitStatus()
    })
    receiver.start()
  }

  #emitStatus(): void {
    this.emit('status', this.status())
  }
}
