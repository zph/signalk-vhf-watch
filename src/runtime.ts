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
import { TranscriptionManager, type TranscriptionStatus } from './transcription'
import { discriminatorThreshold } from './squelch'

export type ReceiverSlotChannel = VhfChannel | { id: '70'; label: '70'; frequencyHz: number; purpose: string; countries: ('US' | 'CA')[] }

export interface RuntimeStatus {
  enabled: boolean
  mode: VhfWatchConfig['receiverMode']
  channelRegion: ChannelRegion
  channel: VhfChannel
  slots: {
    A: { mode: 'fixed' | 'scan'; configuredChannel: VhfChannel; currentChannel: VhfChannel; state: 'fixed' | 'scanning' | 'holding' }
    B: { channel: ReceiverSlotChannel; kind: 'voice' | 'dsc' }
  }
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
  transcription: TranscriptionStatus
  receiveOnly: true
}

export class VhfRuntime extends EventEmitter<{
  audio: [Buffer]
  rawAudio: [Buffer, number]
  status: [RuntimeStatus]
}> {
  readonly config: VhfWatchConfig
  readonly replay: RollingReplay
  readonly replayB: RollingReplay
  readonly transcription: TranscriptionManager
  #channel: VhfChannel
  #slotAMode: 'fixed' | 'scan'
  #slotAConfigured: VhfChannel
  #slotB: ReceiverSlotChannel
  #scanLocked = false
  #scanOpenMs = 0
  #scanQuietMs = 0
  #scanIndex = 0
  #scanPriorityTurn = false
  #scanTimer?: ReturnType<typeof setTimeout>
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

  constructor(config: VhfWatchConfig, dscCache?: DscMessageCache, transcription?: TranscriptionManager) {
    super()
    this.config = config
    this.#channelRegion = config.channelRegion
    const configuredChannel = channelById(config.initialChannel, this.#channelRegion)!
    this.#channel = config.receiverMode === 'rtl_sdr' && !canChannelize(configuredChannel.frequencyHz)
      ? channelById('16', this.#channelRegion)!
      : configuredChannel
    this.#slotAConfigured = this.#channel
    this.#slotAMode = config.slotAMode
    const configuredSlotB = config.slotBChannel === '70' ? undefined : channelById(config.slotBChannel, this.#channelRegion)
    this.#slotB = configuredSlotB && (config.receiverMode !== 'rtl_sdr' || canChannelize(configuredSlotB.frequencyHz))
      ? configuredSlotB
      : this.#dscChannel()
    this.#dscCache = dscCache
    this.transcription = transcription ?? new TranscriptionManager(`/tmp/signalk-vhf-watch-transcription-${process.pid}.json`)
    this.#dscMessages = dscCache?.list() ?? []
    this.replay = new RollingReplay(
      config.sampleRate,
      config.segmentSeconds,
      config.replayMinutes,
      this.#channel.id,
      config.maxBufferMiB * 1024 * 1024,
      'A', -1, 2
    )
    this.replayB = new RollingReplay(
      config.sampleRate, config.segmentSeconds, config.replayMinutes, this.#slotB.id,
      config.maxBufferMiB * 1024 * 1024, 'B', 0, 2
    )
  }

  start(): void {
    if (!this.config.enabled) {
      this.#receiverState = 'Disabled'
      this.#emitStatus()
      return
    }
    this.#startReceiver()
    if (this.#slotAMode === 'scan') this.#scheduleScan(0)
  }

  stop(): void {
    this.#stopReceiver()
    if (this.#scanTimer) clearTimeout(this.#scanTimer)
    this.transcription.stop()
    this.replay.flush()
    this.replayB.flush()
    this.#receiverState = 'Stopped'
    this.#emitStatus()
  }

  tune(channelId: string): RuntimeStatus {
    const channel = channelById(channelId, this.#channelRegion)
    if (!channel) throw new Error(`Unknown VHF channel: ${channelId}`)
    this.#slotAMode = 'fixed'
    this.#slotAConfigured = channel
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

  configureSlots(mode: 'fixed' | 'scan', slotAChannelId: string, slotBChannelId: string): RuntimeStatus {
    const slotA = channelById(slotAChannelId, this.#channelRegion)
    if (!slotA) throw new Error(`Unknown Slot A VHF channel: ${slotAChannelId}`)
    const slotB = slotBChannelId.toUpperCase() === '70' ? this.#dscChannel() : channelById(slotBChannelId, this.#channelRegion)
    if (!slotB) throw new Error(`Unknown Slot B VHF channel: ${slotBChannelId}`)
    for (const channel of [slotA, ...(slotB.id === '70' ? [] : [slotB])]) {
      if (this.config.receiverMode === 'rtl_sdr' && !canChannelize(channel.frequencyHz)) {
        throw new Error(`${channel.label} is outside this RTL-SDR's wideband capture window`)
      }
    }
    if (slotB.id !== '70' && slotB.frequencyHz === slotA.frequencyHz) throw new Error('Slots A and B must use different channels')
    const slotBChanged = slotB.id !== this.#slotB.id || slotB.frequencyHz !== this.#slotB.frequencyHz
    if (this.#scanTimer) clearTimeout(this.#scanTimer)
    this.#scanTimer = undefined
    this.#scanLocked = false
    this.#scanOpenMs = 0
    this.#scanQuietMs = 0
    this.#slotAMode = mode
    this.#slotAConfigured = slotA
    this.#channel = slotA
    this.#slotB = slotB
    this.replay.setChannel(slotA.id)
    this.replayB.setChannel(slotB.id)
    if (slotBChanged && this.#receiver) {
      this.#stopReceiver()
      this.#startReceiver()
    } else if (this.#receiver instanceof NativeSidecarReceiver) this.#receiver.tune(slotA)
    if (mode === 'scan' && this.config.enabled) this.#scheduleScan(0)
    this.#emitStatus()
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
    const segments = this.segments()
    return {
      enabled: this.config.enabled,
      mode: this.config.receiverMode,
      channelRegion: this.#channelRegion,
      channel: this.#channel,
      slots: {
        A: {
          mode: this.#slotAMode,
          configuredChannel: this.#slotAConfigured,
          currentChannel: this.#channel,
          state: this.#slotAMode === 'fixed' ? 'fixed' : this.#scanLocked ? 'holding' : 'scanning'
        },
        B: { channel: this.#slotB, kind: this.#slotB.id === '70' ? 'dsc' : 'voice' }
      },
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
        enabled: this.config.receiverMode === 'rtl_sdr' && this.config.enabled && this.#slotB.id === '70',
        frequencyHz: DSC_CHANNEL_HZ,
        continuous: this.#slotB.id === '70' && this.#dscContinuous,
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
      transcription: this.transcription.status(),
      receiveOnly: true
    }
  }

  segments(squelch?: number): ReplaySegmentSummary[] {
    return [...this.replay.list(squelch), ...this.replayB.list(squelch)]
      .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))
  }

  replaySegment(id: number) { return this.replay.get(id) ?? this.replayB.get(id) }
  replayWavFor(id: number, squelch: number) { return this.replay.wavFor(id, squelch) ?? this.replayB.wavFor(id, squelch) }
  deleteReplay(id: number): boolean { return this.replay.delete(id) || this.replayB.delete(id) }
  clearReplay(): void { this.replay.clear(); this.replayB.clear() }

  dscMessages(): DscMessage[] {
    return [...this.#dscMessages]
  }

  clearDscMessages(): void {
    this.#dscMessages = []
    this.#dscCache?.clear()
    this.#emitStatus()
  }

  async setTranscriptionEnabled(enabled: boolean): Promise<RuntimeStatus> {
    await this.transcription.setEnabled(enabled)
    this.#emitStatus()
    return this.status()
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
      ? new NativeSidecarReceiver(this.config, this.#channel, this.#slotB.id === '70' ? '70' : this.#slotB)
      : new DemoReceiver(this.config.sampleRate)
    this.#receiver = receiver
    receiver.on('audio', (chunk) => {
      this.#lastAudioAt = new Date().toISOString()
      this.#level = this.#level * 0.7 + rmsLevel(chunk) * 0.3
      if (!(receiver instanceof NativeSidecarReceiver)) {
        for (const segment of this.replay.append(chunk)) {
          this.transcription.enqueue(segment, this.config.squelch)
        }
      }
      this.emit('audio', chunk)
    })
    receiver.on('replayAudio', (chunk, discriminatorNoise) => {
      if (this.#slotAMode === 'scan') {
        this.#handleScanAudio(chunk, discriminatorNoise)
        this.emit('rawAudio', chunk, discriminatorNoise)
        return
      }
      for (const segment of this.replay.append(chunk, Date.now(), discriminatorNoise)) {
        this.transcription.enqueue(segment, this.config.squelch)
      }
      this.emit('rawAudio', chunk, discriminatorNoise)
    })
    receiver.on('slotBReplayAudio', (chunk, discriminatorNoise) => {
      for (const segment of this.replayB.append(chunk, Date.now(), discriminatorNoise)) {
        this.transcription.enqueue(segment, this.config.squelch)
      }
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
      if (this.#slotB.id !== '70') return
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

  #dscChannel(): ReceiverSlotChannel {
    return { id: '70', label: '70', frequencyHz: DSC_CHANNEL_HZ, purpose: 'Digital selective calling', countries: ['US', 'CA'] }
  }

  #scanChannels(): VhfChannel[] {
    return channelPlan(this.#channelRegion).filter((channel) =>
      !channel.weather && canChannelize(channel.frequencyHz) &&
      (this.#slotB.id === '70' || channel.frequencyHz !== this.#slotB.frequencyHz) && channel.id !== '16'
    )
  }

  #scheduleScan(delayMs: number): void {
    if (this.#scanTimer) clearTimeout(this.#scanTimer)
    this.#scanTimer = setTimeout(() => {
      this.#scanTimer = undefined
      if (this.#slotAMode !== 'scan' || this.#scanLocked) return
      const others = this.#scanChannels()
      this.#scanPriorityTurn = !this.#scanPriorityTurn
      const next = this.#scanPriorityTurn || others.length === 0
        ? channelById('16', this.#channelRegion)!
        : others[this.#scanIndex++ % others.length]!
      this.#channel = next
      this.#scanOpenMs = 0
      if (this.#receiver instanceof NativeSidecarReceiver) this.#receiver.tune(next)
      this.#emitStatus()
      this.#scheduleScan(650)
    }, delayMs)
  }

  #handleScanAudio(chunk: Buffer, discriminatorNoise: number): void {
    const milliseconds = chunk.length / 2 / this.config.sampleRate * 1_000
    const open = discriminatorNoise < discriminatorThreshold(this.config.squelch)
    if (!this.#scanLocked) {
      this.#scanOpenMs = open ? this.#scanOpenMs + milliseconds : 0
      if (this.#scanOpenMs < 200) return
      this.#scanLocked = true
      this.#scanQuietMs = 0
      if (this.#scanTimer) clearTimeout(this.#scanTimer)
      this.#scanTimer = undefined
      this.replay.setChannel(this.#channel.id)
      this.#emitStatus()
    }
    for (const segment of this.replay.append(chunk, Date.now(), discriminatorNoise)) {
      this.transcription.enqueue(segment, this.config.squelch)
    }
    this.#scanQuietMs = open ? 0 : this.#scanQuietMs + milliseconds
    if (this.#scanQuietMs >= 1_200) {
      this.replay.flush()
      this.#scanLocked = false
      this.#scanOpenMs = 0
      this.#scanQuietMs = 0
      this.#scheduleScan(0)
    }
  }

  #emitStatus(): void {
    this.emit('status', this.status())
  }
}
