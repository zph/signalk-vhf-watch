import { EventEmitter } from 'node:events'
import { channelById, channelPlan, type ChannelRegion, type VhfChannel } from './channels'
import type { VhfWatchConfig } from './config'
import { DscAudioDecoder, type DscMessage } from './dsc'
import type { DscMessageCache } from './dsc-cache'
import {
  canChannelize,
  DemoReceiver,
  DSC_CHANNEL_HZ,
  WIDEBAND_CENTER_HZ,
  WIDEBAND_SAMPLE_RATE,
  NativeSidecarReceiver,
  type AudioReceiver,
  type ReceiverMetrics
} from './receiver'
import { RollingReplay, type ReplaySegmentSummary } from './rolling-buffer'
import { rmsLevel } from './wav'

export interface RuntimeStatus {
  enabled: boolean
  mode: VhfWatchConfig['receiverMode']
  channelRegion: ChannelRegion
  channel: VhfChannel
  receiverState: string
  receiving: boolean
  level: number
  sampleRate: number
  squelch: number
  replayMinutes: number
  maxBufferMiB: number
  replaySegments: number
  liveListeners: number
  receiverMetrics: ReceiverMetrics
  lastAudioAt?: string
  dscWatch: {
    enabled: boolean
    frequencyHz: number
    continuous: boolean
    level: number
    lastSignalAt?: string
    messages: number
  }
  wideband?: {
    centerHz: number
    sampleRate: number
    minimumHz: number
    maximumHz: number
  }
  error?: string
  receiveOnly: true
}

export class VhfRuntime extends EventEmitter<{
  audio: [Buffer]
  rawAudio: [Buffer, number]
  status: [RuntimeStatus]
}> {
  readonly config: VhfWatchConfig
  readonly replay: RollingReplay
  #channel: VhfChannel
  #channelRegion: ChannelRegion
  #receiver?: AudioReceiver
  #receiverState = 'Stopped'
  #level = 0
  #lastAudioAt?: string
  #error?: string
  #liveListeners = 0
  #dscLevel = 0
  #lastDscSignalAt?: string
  #dscContinuous = false
  #receiverMetrics: ReceiverMetrics = { droppedIqChunks: 0, droppedIqBytes: 0, restarts: 0 }
  readonly #dscDecoder = new DscAudioDecoder()
  readonly #dscCache?: DscMessageCache
  #dscMessages: DscMessage[] = []

  constructor(config: VhfWatchConfig, dscCache?: DscMessageCache) {
    super()
    this.config = config
    this.#channelRegion = config.channelRegion
    const configuredChannel = channelById(config.initialChannel, this.#channelRegion)!
    this.#channel = config.receiverMode === 'rtl_sdr' && !canChannelize(configuredChannel.frequencyHz)
      ? channelById('16', this.#channelRegion)!
      : configuredChannel
    this.#dscCache = dscCache
    this.#dscMessages = dscCache?.list() ?? []
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
    this.#stopReceiver()
    this.replay.flush()
    this.#receiverState = 'Stopped'
    this.#emitStatus()
  }

  tune(channelId: string): RuntimeStatus {
    const channel = channelById(channelId, this.#channelRegion)
    if (!channel) throw new Error(`Unknown VHF channel: ${channelId}`)
    if (channel.id === this.#channel.id) return this.status()
    if (this.config.receiverMode === 'rtl_sdr' && !canChannelize(channel.frequencyHz)) {
      throw new Error(`${channel.label} cannot share this RTL-SDR with continuous DSC Channel 70; use a second receiver`)
    }
    this.#channel = channel
    this.replay.setChannel(channel.id)
    this.#level = 0
    this.#error = undefined
    if (this.#receiver instanceof NativeSidecarReceiver) this.#receiver.tune(channel)
    return this.status()
  }

  setRegion(region: ChannelRegion): RuntimeStatus {
    if (!['US', 'CA', 'US_CA'].includes(region)) throw new Error(`Unknown channel plan: ${region}`)
    this.#channelRegion = region
    const channel = channelById(this.#channel.id, region) ?? channelById('16', region)!
    if (channel.id !== this.#channel.id || channel.frequencyHz !== this.#channel.frequencyHz) {
      this.#channel = channel
      this.replay.setChannel(channel.id)
      if (this.#receiver instanceof NativeSidecarReceiver) this.#receiver.tune(channel)
    } else {
      this.#channel = channel
    }
    this.#emitStatus()
    return this.status()
  }

  region(): ChannelRegion {
    return this.#channelRegion
  }

  channels(): VhfChannel[] {
    return channelPlan(this.#channelRegion)
  }

  status(): RuntimeStatus {
    const segments = this.replay.list()
    return {
      enabled: this.config.enabled,
      mode: this.config.receiverMode,
      channelRegion: this.#channelRegion,
      channel: this.#channel,
      receiverState: this.#receiverState,
      receiving: this.#level > 0.003,
      level: this.#level,
      sampleRate: this.config.sampleRate,
      squelch: this.config.squelch,
      replayMinutes: this.config.replayMinutes,
      maxBufferMiB: this.config.maxBufferMiB,
      replaySegments: segments.length,
      liveListeners: this.#liveListeners,
      receiverMetrics: { ...this.#receiverMetrics },
      ...(this.#lastAudioAt ? { lastAudioAt: this.#lastAudioAt } : {}),
      dscWatch: {
        enabled: this.config.receiverMode === 'rtl_sdr' && this.config.enabled,
        frequencyHz: DSC_CHANNEL_HZ,
        continuous: this.#dscContinuous,
        level: this.#dscLevel,
        messages: this.#dscMessages.length,
        ...(this.#lastDscSignalAt ? { lastSignalAt: this.#lastDscSignalAt } : {})
      },
      ...(this.config.receiverMode === 'rtl_sdr' ? {
        wideband: {
          centerHz: WIDEBAND_CENTER_HZ,
          sampleRate: WIDEBAND_SAMPLE_RATE,
          minimumHz: WIDEBAND_CENTER_HZ - WIDEBAND_SAMPLE_RATE / 2,
          maximumHz: WIDEBAND_CENTER_HZ + WIDEBAND_SAMPLE_RATE / 2
        }
      } : {}),
      ...(this.#error ? { error: this.#error } : {}),
      receiveOnly: true
    }
  }

  segments(): ReplaySegmentSummary[] {
    return this.replay.list()
  }

  dscMessages(): DscMessage[] {
    return [...this.#dscMessages]
  }

  clearDscMessages(): void {
    this.#dscMessages = []
    this.#dscCache?.clear()
    this.#emitStatus()
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
    const receiver = this.config.receiverMode === 'rtl_sdr'
      ? new NativeSidecarReceiver(this.config, this.#channel)
      : new DemoReceiver(this.config.sampleRate)
    this.#receiver = receiver
    receiver.on('audio', (chunk) => {
      this.#lastAudioAt = new Date().toISOString()
      this.#level = this.#level * 0.7 + rmsLevel(chunk) * 0.3
      if (!(receiver instanceof NativeSidecarReceiver)) this.replay.append(chunk)
      this.emit('audio', chunk)
    })
    receiver.on('replayAudio', (chunk, discriminatorNoise) => {
      this.replay.append(chunk, Date.now(), discriminatorNoise)
      this.emit('rawAudio', chunk, discriminatorNoise)
    })
    receiver.on('state', (state) => {
      this.#receiverState = state
      if (state.startsWith('Wideband capture')) this.#error = undefined
      this.#emitStatus()
    })
    receiver.on('metrics', (metrics) => {
      this.#receiverMetrics = metrics
      if (metrics.dscDiscriminatorNoise !== undefined) {
        this.#dscLevel = Math.max(0, Math.min(1, 1 - metrics.dscDiscriminatorNoise / 0.35))
      }
      this.#emitStatus()
    })
    receiver.on('dscAudio', (chunk) => {
      this.#dscContinuous = true
      const messages = this.#dscDecoder.push(chunk)
      if (messages.length > 0) {
        this.#lastDscSignalAt = new Date().toISOString()
        if (this.#dscCache) {
          this.#dscCache.add(messages.reverse())
          this.#dscMessages = this.#dscCache.list()
        } else {
          this.#dscMessages.unshift(...messages.reverse())
          this.#dscMessages.splice(100)
        }
        this.#emitStatus()
      }
    })
    receiver.on('error', (error) => {
      this.#dscContinuous = false
      this.#error = error.message
      this.#receiverState = 'Receiver unavailable'
      this.#emitStatus()
    })
    receiver.start()
  }

  #stopReceiver(): void {
    const receiver = this.#receiver
    this.#receiver = undefined
    // The capture process exits asynchronously. Detach it before shutdown so a late exit cannot
    // overwrite the final receiver state.
    receiver?.removeAllListeners()
    receiver?.stop()
    this.#dscContinuous = false
  }

  #emitStatus(): void {
    this.emit('status', this.status())
  }
}
