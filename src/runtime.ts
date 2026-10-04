import { EventEmitter } from 'node:events'
import { channelById, channelPlan, type ChannelRegion, type VhfChannel } from './channels'
import type { SlotBMode, VhfWatchConfig } from './config'
import { DscAudioDecoder, type DscMessage } from './dsc'
import type { DscMessageCache } from './dsc-cache'
import { enrichDscMessages, findDscCallerIdentity } from './dsc-identity'
import {
  canChannelize,
  DemoReceiver,
  DSC_CHANNEL_HZ,
  WIDEBAND_CENTER_HZ,
  WIDEBAND_SAMPLE_RATE,
  NativeSidecarReceiver,
  type AudioReceiver,
  type ReceiverMetrics,
  type ReceiverQualitySpan
} from './receiver'
import { RollingReplay, type ReplayPlaybackCursor, type ReplayPlaybackPayload, type ReplayPlaybackRead, type ReplaySegment, type ReplaySegmentSummary } from './rolling-buffer'
import { rmsLevel } from './wav'
import { TranscriptionManager, type TranscriptionSettingsPatch, type TranscriptionStatus } from './transcription'
import { discriminatorThreshold } from './squelch'
import type { TuningSettings } from './tuning-settings'
import { RnnoiseDenoiser } from './rnnoise'
import { SpectrumActivityLog, type SpectrumActivityEvent, type SpectrumActivitySample } from './activity-log'
import { ReplayHistoryStore } from './replay-history-store'

const SPECTRUM_ACTIVITY_THRESHOLD = 2
const DSC_IDENTITY_REFRESH_MS = 10 * 60 * 1000

export class ScanRecoveryWindow {
  #cutoffAt = 0
  #storedSinceCallStart = false

  target(at: number): void {
    this.#cutoffAt = Math.max(this.#cutoffAt, at)
  }

  reset(at: number): void {
    this.#cutoffAt = at
    this.#storedSinceCallStart = false
  }

  endCall(at: number): void {
    this.#cutoffAt = at
  }

  beginCall(): void {
    this.#storedSinceCallStart = false
  }

  markStored(): void {
    this.#storedSinceCallStart = true
  }

  accepts(capturedAt: number, byteLength: number, sampleRate: number, targetFrequencyHz: number, capturedFrequencyHz?: number): boolean {
    if (capturedFrequencyHz !== undefined && capturedFrequencyHz !== targetFrequencyHz) return false
    const endsAt = capturedAt + byteLength / 2 / sampleRate * 1_000
    return Number.isFinite(endsAt) && endsAt + 1 >= this.#cutoffAt
  }

  canPrepend(capturedAt: number, byteLength: number, sampleRate: number, targetFrequencyHz: number, capturedFrequencyHz?: number): boolean {
    return !this.#storedSinceCallStart && this.accepts(capturedAt, byteLength, sampleRate, targetFrequencyHz, capturedFrequencyHz)
  }
}

export interface ScanPreRollChunk {
  chunk: Buffer
  discriminatorNoise: number
  at: number
  recovered?: boolean
  qualitySpans?: ReceiverQualitySpan[]
}

export function mergeTimestampedScanPreRoll(target: ScanPreRollChunk[], entry: ScanPreRollChunk, sampleRate: number, maximumSeconds = 7): void {
  let at = entry.at
  if (!entry.recovered) {
    const latestLive = target.filter((current) => !current.recovered).at(-1)
    if (latestLive) at = Math.max(at, latestLive.at + latestLive.chunk.length / 2 / sampleRate * 1_000)
  }
  target.push({ ...entry, at, chunk: Buffer.from(entry.chunk),
    ...(entry.qualitySpans ? { qualitySpans: entry.qualitySpans.map((span) => ({ ...span })) } : {}) })
  const liveEntries = target.filter((current) => !current.recovered)
  const firstLiveAt = liveEntries.reduce((earliest, current) => Math.min(earliest, current.at), Number.POSITIVE_INFINITY)
  const normalized = target.flatMap((current) => {
    if (!current.recovered || !Number.isFinite(firstLiveAt)) return [current]
    const keepBytes = Math.min(current.chunk.length, Math.max(0,
      Math.floor((firstLiveAt - current.at) * sampleRate / 1_000) * 2))
    if (keepBytes === 0) return []
    if (keepBytes === current.chunk.length) return [current]
    return [{ ...current, chunk: current.chunk.subarray(0, keepBytes),
      ...(current.qualitySpans ? { qualitySpans: sliceScanQualitySpans(current.qualitySpans, 0, keepBytes) } : {}) }]
  })
  normalized.sort((left, right) => left.at - right.at || Number(Boolean(right.recovered)) - Number(Boolean(left.recovered)))
  let previousEnd = Number.NEGATIVE_INFINITY
  let previousLiveEnd = Number.NEGATIVE_INFINITY
  const merged: ScanPreRollChunk[] = []
  for (const current of normalized) {
    if (!current.recovered) {
      const at = Math.max(current.at, previousLiveEnd)
      const live = { ...current, at }
      merged.push(live)
      previousLiveEnd = at + live.chunk.length / 2 / sampleRate * 1_000
      previousEnd = Math.max(previousEnd, previousLiveEnd)
      continue
    }
    const overlapBytes = Math.min(current.chunk.length, Math.max(0,
      Math.ceil((previousEnd - current.at) * sampleRate / 1_000) * 2))
    if (overlapBytes >= current.chunk.length) continue
    const chunk = overlapBytes === 0 ? current.chunk : current.chunk.subarray(overlapBytes)
    const qualitySpans = current.qualitySpans && overlapBytes > 0
      ? sliceScanQualitySpans(current.qualitySpans, overlapBytes, current.chunk.length)
      : current.qualitySpans
    const at = current.at + overlapBytes / 2 / sampleRate * 1_000
    merged.push({ ...current, chunk, at, ...(qualitySpans ? { qualitySpans } : {}) })
    previousEnd = at + chunk.length / 2 / sampleRate * 1_000
  }
  target.splice(0, target.length, ...merged)
  const maximumBytes = sampleRate * 2 * maximumSeconds
  let total = target.reduce((sum, current) => sum + current.chunk.length, 0)
  while (total > maximumBytes && target.length > 1) total -= target.shift()!.chunk.length
}

function sliceScanQualitySpans(spans: ReceiverQualitySpan[], start: number, end: number): ReceiverQualitySpan[] {
  const trimmed: ReceiverQualitySpan[] = []
  let offset = 0
  for (const span of spans) {
    const bytes = Math.max(0, Math.min(end, offset + span.bytes) - Math.max(start, offset))
    if (bytes > 0) trimmed.push({ bytes, discriminatorNoise: span.discriminatorNoise })
    offset += span.bytes
    if (offset >= end) break
  }
  return trimmed
}

export type ReceiverSlotChannel = VhfChannel | { id: '70'; label: '70'; frequencyHz: number; purpose: string; countries: ('US' | 'CA')[] }

export function selectAdaptiveScanChannel(
  candidates: VhfChannel[],
  activityScores: ReadonlyMap<string, number>,
  lastVisited: ReadonlyMap<string, number>,
  now: number,
  currentId?: string
): VhfChannel | undefined {
  return candidates
    .filter((channel) => channel.id !== currentId || candidates.length === 1)
    .map((channel, index) => {
      const last = lastVisited.get(channel.id)
      const ageMs = last === undefined ? 86_400_000 - index : Math.max(1, now - last)
      const activity = Math.max(0, activityScores.get(channel.id) ?? 0)
      return { channel, priority: ageMs * (1 + activity * 0.75) }
    })
    .sort((left, right) => right.priority - left.priority)[0]?.channel
}

export interface RuntimeStatus {
  enabled: boolean
  mode: VhfWatchConfig['receiverMode']
  channelRegion: ChannelRegion
  channel: VhfChannel
  slots: {
    A: { mode: 'fixed' | 'scan'; configuredChannel: VhfChannel; currentChannel: VhfChannel; state: 'fixed' | 'scanning' | 'holding' }
    B: {
      mode: SlotBMode
      configuredChannel: ReceiverSlotChannel
      channel: ReceiverSlotChannel
      kind: 'voice' | 'dsc' | 'paused'
      state: 'fixed' | 'scanning' | 'holding' | 'paused'
      activityScore: number
    }
  }
  captureMode: 'wideband' | 'single_frequency'
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
    activity: { channel: string; frequencyHz: number; score: number; active: boolean }[]
  }
  error?: string
  transcription: TranscriptionStatus
  receiveOnly: true
}

export class VhfRuntime extends EventEmitter<{
  audio: [Buffer]
  rawAudio: [Buffer, number]
  rawSlotBAudio: [Buffer, number]
  status: [RuntimeStatus]
}> {
  readonly config: VhfWatchConfig
  readonly replay: RollingReplay
  readonly replayB: RollingReplay
  readonly transcription: TranscriptionManager
  readonly denoiser?: RnnoiseDenoiser
  #channel: VhfChannel
  #slotAMode: 'fixed' | 'scan'
  #slotAConfigured: VhfChannel
  #slotBMode: SlotBMode
  #slotBConfigured: ReceiverSlotChannel
  #slotB: ReceiverSlotChannel
  #singleFrequency = false
  #scanLocked = false
  #scanOpenMs = 0
  #scanQuietMs = 0
  #scanTimer?: ReturnType<typeof setTimeout>
  #scanPreRoll: { chunk: Buffer; discriminatorNoise: number; at: number; qualitySpans?: ReceiverQualitySpan[] }[] = []
  #scanTargetedAt = 0
  readonly #scanRecovery = new ScanRecoveryWindow()
  readonly #scanRejectedUntil = new Map<string, number>()
  #slotBScanLocked = false
  #slotBScanOpenMs = 0
  #slotBScanQuietMs = 0
  #slotBScanTimer?: ReturnType<typeof setTimeout>
  #slotBScanPreRoll: { chunk: Buffer; discriminatorNoise: number; at: number; qualitySpans?: ReceiverQualitySpan[] }[] = []
  #slotBScanTargetedAt = 0
  readonly #slotBScanRecovery = new ScanRecoveryWindow()
  readonly #slotBScanRejectedUntil = new Map<string, number>()
  readonly #slotBActivityScores = new Map<string, number>()
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
  readonly #spectrumActivityScores = new Map<string, number>()
  readonly #spectrumActivityLog: SpectrumActivityLog
  readonly #historyStore?: ReplayHistoryStore
  #historyTimer?: ReturnType<typeof setInterval>
  readonly #dscDecoder = new DscAudioDecoder()
  readonly #dscCache?: DscMessageCache
  readonly #getDscVessels?: () => unknown
  readonly #saveTuning?: (settings: TuningSettings) => void
  #dscMessages: DscMessage[] = []
  #resolvedDscMessages: DscMessage[] = []
  #dscIdentityRefreshTimer?: ReturnType<typeof setInterval>

  constructor(
    config: VhfWatchConfig,
    dscCache?: DscMessageCache,
    transcription?: TranscriptionManager,
    saveTuning?: (settings: TuningSettings) => void,
    denoiser?: RnnoiseDenoiser,
    replayOpusCommand?: string,
    getDscVessels?: () => unknown,
    historyStore?: ReplayHistoryStore
  ) {
    super()
    this.config = config
    this.#channelRegion = config.channelRegion
    const configuredChannel = channelById(config.initialChannel, this.#channelRegion)!
    this.#channel = configuredChannel
    this.#singleFrequency = config.receiverMode === 'rtl_sdr' && !canChannelize(configuredChannel.frequencyHz)
    this.#slotAConfigured = this.#channel
    this.#slotAMode = this.#singleFrequency ? 'fixed' : config.slotAMode
    const configuredSlotB = config.slotBChannel === '70' ? undefined : channelById(config.slotBChannel, this.#channelRegion)
    this.#slotB = configuredSlotB && (config.receiverMode !== 'rtl_sdr' || canChannelize(configuredSlotB.frequencyHz))
      ? configuredSlotB
      : this.#dscChannel()
    this.#slotBMode = this.#singleFrequency ? 'fixed' : config.slotBMode
    if (this.#slotBMode === 'scan' && this.#slotB.id === '70') {
      this.#slotB = this.#preferredSlotBScanChannel() ?? this.#dscChannel()
      if (this.#slotB.id === '70') this.#slotBMode = 'fixed'
    }
    this.#slotBConfigured = this.#slotB
    this.#dscCache = dscCache
    this.#getDscVessels = getDscVessels
    this.#saveTuning = saveTuning
    this.#historyStore = historyStore
    const history = historyStore?.load()
    this.#spectrumActivityLog = new SpectrumActivityLog(config.replayMinutes, 5_000, 3_000, history?.activityEvents)
    this.transcription = transcription ?? new TranscriptionManager(`/tmp/signalk-vhf-watch-transcription-${process.pid}.json`)
    this.denoiser = denoiser
    this.#dscMessages = dscCache?.list() ?? []
    this.#refreshDscIdentities()
    this.replay = new RollingReplay(
      config.sampleRate,
      config.segmentSeconds,
      config.replayMinutes,
      this.#channel.id,
      Math.floor(config.maxBufferMiB / 2) * 1024 * 1024,
      'A', -1, 2, config.squelch, replayOpusCommand
    )
    this.replayB = new RollingReplay(
      config.sampleRate, config.segmentSeconds, config.replayMinutes, this.#slotB.id,
      Math.ceil(config.maxBufferMiB / 2) * 1024 * 1024, 'B', 0, 2, config.squelch, replayOpusCommand
    )
    if (history) {
      this.replay.restore(history.segments)
      this.replayB.restore(history.segments)
    }
  }

  start(): void {
    if (this.#historyStore && !this.#historyTimer) {
      this.#historyTimer = setInterval(() => this.#scheduleHistorySnapshot(), 3_000)
      this.#historyTimer.unref?.()
      this.#scheduleHistorySnapshot()
    }
    this.#refreshDscIdentities()
    if (this.#getDscVessels && !this.#dscIdentityRefreshTimer) {
      this.#dscIdentityRefreshTimer = setInterval(() => this.#refreshDscIdentities(), DSC_IDENTITY_REFRESH_MS)
      this.#dscIdentityRefreshTimer.unref?.()
    }
    if (!this.config.enabled) {
      this.#receiverState = 'Disabled'
      this.#emitStatus()
      return
    }
    this.#startReceiver()
    if (this.#slotAMode === 'scan' && !this.#singleFrequency) this.#scheduleScan(0)
    if (this.#slotBMode === 'scan' && !this.#singleFrequency) this.#scheduleSlotBScan(0)
  }

  async stop(): Promise<void> {
    if (this.#historyTimer) clearInterval(this.#historyTimer)
    this.#historyTimer = undefined
    if (this.#dscIdentityRefreshTimer) clearInterval(this.#dscIdentityRefreshTimer)
    this.#dscIdentityRefreshTimer = undefined
    this.#stopReceiver()
    if (this.#scanTimer) clearTimeout(this.#scanTimer)
    if (this.#slotBScanTimer) clearTimeout(this.#slotBScanTimer)
    await this.transcription.stop()
    this.replay.flush()
    this.replayB.flush()
    this.#receiverState = 'Stopped'
    this.#emitStatus()
    await this.transcription.close()
    this.#scheduleHistorySnapshot()
    await this.#historyStore?.flush()
  }

  tune(channelId: string): RuntimeStatus {
    const channel = channelById(channelId, this.#channelRegion)
    if (!channel) throw new Error(`Unknown VHF channel: ${channelId}`)
    this.#slotAMode = 'fixed'
    this.#slotAConfigured = channel
    const wasSingleFrequency = this.#singleFrequency
    const singleFrequency = this.config.receiverMode === 'rtl_sdr' && !canChannelize(channel.frequencyHz)
    if (channel.id === this.#channel.id && singleFrequency === wasSingleFrequency) return this.status()
    this.#channel = channel
    this.#singleFrequency = singleFrequency
    this.config.initialChannel = channel.id
    this.config.slotAMode = 'fixed'
    this.replay.setChannel(channel.id)
    this.#level = 0
    this.#error = undefined
    if (this.#receiver) {
      if (wasSingleFrequency || singleFrequency) {
        this.#stopReceiver()
        this.#startReceiver()
      } else if (this.#receiver instanceof NativeSidecarReceiver) this.#receiver.tune(channel)
    }
    this.#persistTuning()
    return this.status()
  }

  configureSlots(mode: 'fixed' | 'scan', slotAChannelId: string, slotBMode: SlotBMode, slotBChannelId: string): RuntimeStatus {
    const slotA = channelById(slotAChannelId, this.#channelRegion)
    if (!slotA) throw new Error(`Unknown Slot A VHF channel: ${slotAChannelId}`)
    let slotB = slotBChannelId.toUpperCase() === '70' ? this.#dscChannel() : channelById(slotBChannelId, this.#channelRegion)
    if (!slotB) throw new Error(`Unknown Slot B VHF channel: ${slotBChannelId}`)
    const singleFrequency = this.config.receiverMode === 'rtl_sdr' && !canChannelize(slotA.frequencyHz)
    if (singleFrequency && (mode === 'scan' || slotBMode === 'scan')) throw new Error(`${slotA.label} requires Fixed mode because DSC and nearby-channel scanning are paused`)
    if (slotBMode === 'scan' && slotB.id === '70') {
      slotB = this.#preferredSlotBScanChannel(slotA) ?? slotB
      if (slotB.id === '70') throw new Error('No nearby voice channels are available for Slot B adaptive scan')
    }
    if (slotB.id !== '70' && this.config.receiverMode === 'rtl_sdr' && !canChannelize(slotB.frequencyHz)) {
      throw new Error(`Slot B channel ${slotB.label} is outside this RTL-SDR's marine wideband capture window`)
    }
    if (!singleFrequency && slotB.id !== '70' && slotB.frequencyHz === slotA.frequencyHz) throw new Error('Slots A and B must use different channels')
    const slotBChanged = slotB.id !== this.#slotB.id || slotB.frequencyHz !== this.#slotB.frequencyHz || slotBMode !== this.#slotBMode
    const captureModeChanged = singleFrequency !== this.#singleFrequency
    const configuredAt = Date.now()
    if (this.#scanTimer) clearTimeout(this.#scanTimer)
    this.#scanTimer = undefined
    this.#scanLocked = false
    this.#scanOpenMs = 0
    this.#scanQuietMs = 0
    this.#scanPreRoll = []
    this.#scanRecovery.reset(configuredAt)
    if (this.#slotBScanTimer) clearTimeout(this.#slotBScanTimer)
    this.#slotBScanTimer = undefined
    this.#slotBScanLocked = false
    this.#slotBScanOpenMs = 0
    this.#slotBScanQuietMs = 0
    this.#slotBScanPreRoll = []
    this.#slotBScanRecovery.reset(configuredAt)
    this.#slotAMode = mode
    this.#slotAConfigured = slotA
    this.#channel = slotA
    this.#slotBMode = slotBMode
    this.#slotBConfigured = slotB
    this.#slotB = slotB
    this.#singleFrequency = singleFrequency
    this.config.initialChannel = slotA.id
    this.config.slotAMode = mode
    this.config.slotBMode = slotBMode
    this.config.slotBChannel = slotB.id
    this.replay.setChannel(slotA.id)
    this.replayB.setChannel(slotB.id)
    if ((slotBChanged || captureModeChanged || singleFrequency) && this.#receiver) {
      this.#stopReceiver()
      this.#startReceiver()
    } else if (this.#receiver instanceof NativeSidecarReceiver) this.#receiver.tune(slotA)
    if (mode === 'scan' && !singleFrequency && this.config.enabled) this.#scheduleScan(0)
    if (slotBMode === 'scan' && !singleFrequency && this.config.enabled) this.#scheduleSlotBScan(0)
    this.#persistTuning()
    this.#emitStatus()
    return this.status()
  }

  setRegion(region: ChannelRegion): RuntimeStatus {
    if (!['US', 'CA', 'US_CA'].includes(region)) throw new Error(`Unknown channel plan: ${region}`)
    this.#channelRegion = region
    this.config.channelRegion = region
    const channel = channelById(this.#channel.id, region) ?? channelById('16', region)!
    const wasSingleFrequency = this.#singleFrequency
    const singleFrequency = this.config.receiverMode === 'rtl_sdr' && !canChannelize(channel.frequencyHz)
    if (channel.id !== this.#channel.id || channel.frequencyHz !== this.#channel.frequencyHz) {
      this.#channel = channel
      this.#slotAConfigured = channel
      this.#singleFrequency = singleFrequency
      this.replay.setChannel(channel.id)
      if (this.#receiver) {
        if (wasSingleFrequency || singleFrequency) {
          this.#stopReceiver()
          this.#startReceiver()
        } else if (this.#receiver instanceof NativeSidecarReceiver) this.#receiver.tune(channel)
      }
    } else {
      this.#channel = channel
      this.#slotAConfigured = channel
      this.#singleFrequency = singleFrequency
    }
    this.config.initialChannel = this.#slotAConfigured.id
    this.#persistTuning()
    this.#emitStatus()
    return this.status()
  }

  region(): ChannelRegion {
    return this.#channelRegion
  }

  channels(): VhfChannel[] {
    return channelPlan(this.#channelRegion)
  }

  #persistTuning(): void {
    this.#saveTuning?.({
      channelRegion: this.#channelRegion,
      slotAMode: this.#slotAMode,
      slotAChannel: this.#slotAConfigured.id,
      slotBMode: this.#slotBMode,
      slotBChannel: this.#slotBConfigured.id
    })
  }

  status(): RuntimeStatus {
    return {
      enabled: this.config.enabled,
      mode: this.config.receiverMode,
      channelRegion: this.#channelRegion,
      channel: this.#channel,
      captureMode: this.#singleFrequency ? 'single_frequency' : 'wideband',
      slots: {
        A: {
          mode: this.#slotAMode,
          configuredChannel: this.#slotAConfigured,
          currentChannel: this.#channel,
          state: this.#singleFrequency || this.#slotAMode === 'fixed' ? 'fixed' : this.#scanLocked ? 'holding' : 'scanning'
        },
        B: {
          mode: this.#slotBMode,
          configuredChannel: this.#slotBConfigured,
          channel: this.#slotB,
          kind: this.#singleFrequency ? 'paused' : this.#slotB.id === '70' ? 'dsc' : 'voice',
          state: this.#singleFrequency ? 'paused' : this.#slotBMode === 'fixed' ? 'fixed' : this.#slotBScanLocked ? 'holding' : 'scanning',
          activityScore: this.#slotBActivityScores.get(this.#slotB.id) ?? 0
        }
      },
      receiverState: this.#receiverState,
      receiving: this.#level > 0.003,
      level: this.#level,
      sampleRate: this.config.sampleRate,
      squelch: this.config.squelch,
      replayMinutes: this.config.replayMinutes,
      maxBufferMiB: this.config.maxBufferMiB,
      replaySegments: this.replay.segmentCount + this.replayB.segmentCount,
      liveListeners: this.#liveListeners,
      receiverMetrics: { ...this.#receiverMetrics },
      ...(this.#lastAudioAt ? { lastAudioAt: this.#lastAudioAt } : {}),
      dscWatch: {
        enabled: !this.#singleFrequency && this.config.receiverMode === 'rtl_sdr' && this.config.enabled,
        frequencyHz: DSC_CHANNEL_HZ,
        continuous: !this.#singleFrequency && this.#dscContinuous,
        level: this.#dscLevel,
        messages: this.#dscMessages.length,
        ...(this.#lastDscSignalAt ? { lastSignalAt: this.#lastDscSignalAt } : {})
      },
      ...(this.config.receiverMode === 'rtl_sdr' ? {
        wideband: {
          centerHz: this.#singleFrequency ? this.#channel.frequencyHz : WIDEBAND_CENTER_HZ,
          sampleRate: WIDEBAND_SAMPLE_RATE,
          minimumHz: (this.#singleFrequency ? this.#channel.frequencyHz : WIDEBAND_CENTER_HZ) - WIDEBAND_SAMPLE_RATE / 2,
          maximumHz: (this.#singleFrequency ? this.#channel.frequencyHz : WIDEBAND_CENTER_HZ) + WIDEBAND_SAMPLE_RATE / 2,
          activity: channelPlan(this.#channelRegion)
            .filter((channel) => !channel.weather && canChannelize(channel.frequencyHz))
            .map((channel) => {
              const score = this.#spectrumActivityScores.get(channel.id) ?? 0
              return { channel: channel.id, frequencyHz: channel.frequencyHz, score, active: score >= SPECTRUM_ACTIVITY_THRESHOLD }
            })
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
  replayPlaybackSnapshotFrom(id: number) {
    if (this.replay.get(id)) return this.replay.snapshotFrom(id)
    if (this.replayB.get(id)) return this.replayB.snapshotFrom(id)
    return undefined
  }
  replayPlaybackSnapshotPcm(segment: ReplaySegment) {
    return (segment.slot === 'A' ? this.replay : this.replayB).snapshotPcm(segment)
  }
  replayPlaybackCursorFrom(id: number): ReplayPlaybackCursor | undefined {
    if (this.replay.get(id)) return this.replay.playbackCursor(id)
    if (this.replayB.get(id)) return this.replayB.playbackCursor(id)
    return undefined
  }
  replayPlaybackCursorRead(cursor: ReplayPlaybackCursor, maximumBytes = 64_000, payload?: ReplayPlaybackPayload): Promise<ReplayPlaybackRead> {
    return (cursor.slot === 'A' ? this.replay : this.replayB).readPlaybackCursor(cursor, maximumBytes, payload)
  }
  replayPlaybackCursorHasData(cursor: ReplayPlaybackCursor): boolean {
    return (cursor.slot === 'A' ? this.replay : this.replayB).playbackCursorHasData(cursor)
  }
  replayPlaybackCursorSuccessor(cursor: ReplayPlaybackCursor): ReplayPlaybackCursor | undefined {
    return (cursor.slot === 'A' ? this.replay : this.replayB).playbackCursorSuccessor(cursor)
  }
  canTailPlaybackCursor(cursor: ReplayPlaybackCursor): boolean {
    if (!this.config.enabled) return false
    if (cursor.slot === 'A') return cursor.channel === this.#channel.id
    return !this.#singleFrequency && this.#slotB.id !== '70' && cursor.channel === this.#slotB.id
  }
  replayStillCurrent(id: number, startedAt: string): boolean { return this.replaySegment(id)?.startedAt === startedAt }
  async replayWavFor(id: number, squelch: number) {
    if (this.replay.get(id)) return this.replay.wavFor(id, squelch)
    if (this.replayB.get(id)) return this.replayB.wavFor(id, squelch)
    return undefined
  }
  replayPcmFrom(id: number, squelch: number) {
    if (this.replay.get(id)) return this.replay.pcmFrom(id, squelch)
    if (this.replayB.get(id)) return this.replayB.pcmFrom(id, squelch)
    return undefined
  }
  canTailReplay(id: number): boolean {
    const segment = this.replaySegment(id)
    if (!segment || !this.config.enabled) return false
    if (segment.slot === 'A') return segment.channel === this.#channel.id
    return !this.#singleFrequency && this.#slotB.id !== '70' && segment.channel === this.#slotB.id
  }
  deleteReplay(id: number): boolean {
    const deleted = this.replay.delete(id) || this.replayB.delete(id)
    if (deleted) this.#scheduleHistorySnapshot()
    return deleted
  }
  clearReplay(): void {
    this.replay.clear()
    this.replayB.clear()
    this.#scheduleHistorySnapshot()
  }

  dscMessages(): DscMessage[] {
    this.#refreshDscIdentities()
    return this.#resolvedDscMessages.map((message) => ({ ...message, rawSymbols: [...message.rawSymbols] }))
  }

  activityEvents(): SpectrumActivityEvent[] {
    return this.#spectrumActivityLog.list()
  }

  #scheduleHistorySnapshot(): void {
    if (!this.#historyStore) return
    const segments = [this.replay, this.replayB].flatMap((replay) =>
      replay.list().flatMap(({ id }) => {
        const segment = replay.get(id)
        return segment ? [{
          ...segment,
          wav: segment.wav,
          ...(segment.opus ? { opus: segment.opus } : {}),
          qualitySpans: segment.qualitySpans.map((span) => ({ ...span })),
          ...(segment.transcription ? { transcription: { ...segment.transcription } } : {})
        }] : []
      })
    )
    const checkpoint = new Date().toISOString()
    const activityEvents = this.#spectrumActivityLog.list().map((event) => ({
      ...event,
      ...(event.endedAt ? {} : { endedAt: checkpoint })
    }))
    this.#historyStore.schedule({ segments, activityEvents })
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

  async configureTranscription(patch: TranscriptionSettingsPatch): Promise<RuntimeStatus> {
    await this.transcription.configure(patch)
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
      ? new NativeSidecarReceiver(this.config, this.#channel, this.#slotB.id === '70' ? '70' : this.#slotB, this.#singleFrequency)
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
    receiver.on('replayAudio', (chunk, discriminatorNoise, capturedAt, frequencyHz, qualitySpans) => {
      if (this.#slotAMode === 'scan') {
        this.#handleScanAudio(chunk, discriminatorNoise, capturedAt, frequencyHz, qualitySpans)
        if (capturedAt === undefined) this.emit('rawAudio', chunk, discriminatorNoise)
        return
      }
      if (capturedAt !== undefined) return
      for (const segment of this.replay.append(chunk, Date.now(), discriminatorNoise)) {
        this.transcription.enqueue(segment, this.config.squelch)
      }
      this.emit('rawAudio', chunk, discriminatorNoise)
    })
    receiver.on('slotBReplayAudio', (chunk, discriminatorNoise, capturedAt, frequencyHz, qualitySpans) => {
      if (this.#singleFrequency) return
      if (this.#slotBMode === 'scan') {
        this.#handleSlotBScanAudio(chunk, discriminatorNoise, capturedAt, frequencyHz, qualitySpans)
        if (capturedAt === undefined) this.emit('rawSlotBAudio', chunk, discriminatorNoise)
        return
      }
      if (capturedAt !== undefined) return
      for (const segment of this.replayB.append(chunk, Date.now(), discriminatorNoise)) {
        this.transcription.enqueue(segment, this.config.squelch)
      }
      this.emit('rawSlotBAudio', chunk, discriminatorNoise)
    })
    receiver.on('state', (state) => {
      this.#receiverState = state
      if (state.includes('capture')) this.#error = undefined
      this.#emitStatus()
    })
    receiver.on('metrics', (metrics) => {
      this.#receiverMetrics = metrics
      if (metrics.spectrumActivity) {
        this.#spectrumActivityScores.clear()
        const active: SpectrumActivitySample[] = []
        for (const channel of channelPlan(this.#channelRegion)) {
          const score = metrics.spectrumActivity[String(channel.frequencyHz)]
          if (score !== undefined) {
            this.#spectrumActivityScores.set(channel.id, score)
            if (score >= SPECTRUM_ACTIVITY_THRESHOLD && !active.some((entry) => entry.frequencyHz === channel.frequencyHz)) {
              active.push({ channel: channel.id, frequencyHz: channel.frequencyHz, score })
            }
          }
        }
        this.#spectrumActivityLog.update(active)
        this.#retargetSpectrumScans()
      }
      if (!this.#singleFrequency && metrics.dscDiscriminatorNoise !== undefined) {
        this.#dscLevel = Math.max(0, Math.min(1, 1 - metrics.dscDiscriminatorNoise / 0.35))
      }
      this.#emitStatus()
    })
    receiver.on('dscAudio', (chunk) => {
      if (this.#singleFrequency) return
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
        this.#refreshDscIdentities()
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

  #refreshDscIdentities(): void {
    if (!this.#getDscVessels) {
      this.#resolvedDscMessages = this.#dscMessages
      return
    }
    try {
      const vessels = this.#getDscVessels()
      this.#resolvedDscMessages = enrichDscMessages(this.#dscMessages, (mmsi) => findDscCallerIdentity(vessels, mmsi))
    } catch {
      this.#resolvedDscMessages = enrichDscMessages(this.#dscMessages, () => undefined)
    }
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

  #slotBScanChannels(slotA = this.#channel): VhfChannel[] {
    return channelPlan(this.#channelRegion).filter((channel) =>
      !channel.weather && canChannelize(channel.frequencyHz) && channel.frequencyHz !== slotA.frequencyHz
    )
  }

  #preferredSlotBScanChannel(slotA = this.#channel): VhfChannel | undefined {
    const candidates = this.#slotBScanChannels(slotA)
    return candidates.find((channel) => channel.id === '68') ?? candidates[0]
  }

  #scheduleScan(delayMs: number): void {
    if (this.#scanTimer) clearTimeout(this.#scanTimer)
    this.#scanTimer = setTimeout(() => {
      this.#scanTimer = undefined
      if (this.#slotAMode !== 'scan' || this.#scanLocked) return
      this.#retargetSpectrumScans()
      this.#scheduleScan(500)
    }, delayMs)
  }

  #handleScanAudio(chunk: Buffer, discriminatorNoise: number, capturedAt?: number, frequencyHz?: number, qualitySpans?: ReceiverQualitySpan[]): void {
    if (capturedAt !== undefined && !this.#scanRecovery.accepts(capturedAt, chunk.length, this.config.sampleRate, this.#channel.frequencyHz, frequencyHz)) return
    if (this.#scanLocked && capturedAt !== undefined) {
      if (!this.#scanRecovery.canPrepend(capturedAt, chunk.length, this.config.sampleRate, this.#channel.frequencyHz, frequencyHz)) return
      const segments = this.replay.prepend(chunk, capturedAt, discriminatorNoise, qualitySpans)
      if (segments.length > 0) this.#scanRecovery.markStored()
      for (const segment of segments) {
        this.transcription.enqueue(segment, this.config.squelch)
      }
      return
    }
    const milliseconds = chunk.length / 2 / this.config.sampleRate * 1_000
    const open = discriminatorNoise < discriminatorThreshold(this.config.squelch)
    if (!this.#scanLocked) {
      this.#appendScanPreRoll(this.#scanPreRoll, chunk, discriminatorNoise, capturedAt, qualitySpans)
      if (capturedAt !== undefined) return
      this.#scanOpenMs = open ? this.#scanOpenMs + milliseconds : 0
      if (this.#scanOpenMs < 200) return
      this.#scanLocked = true
      this.#scanQuietMs = 0
      if (this.#scanTimer) clearTimeout(this.#scanTimer)
      this.#scanTimer = undefined
      this.replay.setChannel(this.#channel.id)
      this.#scanRecovery.beginCall()
      for (const buffered of this.#scanPreRoll) {
        const segments = this.replay.append(buffered.chunk, buffered.at, buffered.discriminatorNoise, buffered.qualitySpans)
        if (segments.length > 0) this.#scanRecovery.markStored()
        for (const segment of segments) {
          this.transcription.enqueue(segment, this.config.squelch)
        }
      }
      this.#scanPreRoll = []
      this.#emitStatus()
    } else {
      const segments = this.replay.append(chunk, Date.now(), discriminatorNoise)
      if (segments.length > 0) this.#scanRecovery.markStored()
      for (const segment of segments) {
        this.transcription.enqueue(segment, this.config.squelch)
      }
    }
    this.#scanQuietMs = open ? 0 : this.#scanQuietMs + milliseconds
    if (this.#scanQuietMs >= 5_000) {
      const segment = this.replay.flush()
      if (segment) this.transcription.enqueue(segment, this.config.squelch)
      this.#scanLocked = false
      this.#scanOpenMs = 0
      this.#scanQuietMs = 0
      this.#scanRecovery.endCall(Date.now())
      this.#scheduleScan(0)
    }
  }

  #scheduleSlotBScan(delayMs: number): void {
    if (this.#slotBScanTimer) clearTimeout(this.#slotBScanTimer)
    this.#slotBScanTimer = setTimeout(() => {
      this.#slotBScanTimer = undefined
      if (this.#slotBMode !== 'scan' || this.#slotBScanLocked || this.#singleFrequency) return
      this.#retargetSpectrumScans()
      this.#scheduleSlotBScan(500)
    }, delayMs)
  }

  #handleSlotBScanAudio(chunk: Buffer, discriminatorNoise: number, capturedAt?: number, frequencyHz?: number, qualitySpans?: ReceiverQualitySpan[]): void {
    if (capturedAt !== undefined && !this.#slotBScanRecovery.accepts(capturedAt, chunk.length, this.config.sampleRate, this.#slotB.frequencyHz, frequencyHz)) return
    if (this.#slotBScanLocked && capturedAt !== undefined) {
      if (!this.#slotBScanRecovery.canPrepend(capturedAt, chunk.length, this.config.sampleRate, this.#slotB.frequencyHz, frequencyHz)) return
      const segments = this.replayB.prepend(chunk, capturedAt, discriminatorNoise, qualitySpans)
      if (segments.length > 0) this.#slotBScanRecovery.markStored()
      for (const segment of segments) {
        this.transcription.enqueue(segment, this.config.squelch)
      }
      return
    }
    const milliseconds = chunk.length / 2 / this.config.sampleRate * 1_000
    const open = discriminatorNoise < discriminatorThreshold(this.config.squelch)
    if (!this.#slotBScanLocked) {
      this.#appendScanPreRoll(this.#slotBScanPreRoll, chunk, discriminatorNoise, capturedAt, qualitySpans)
      if (capturedAt !== undefined) return
      this.#slotBScanOpenMs = open ? this.#slotBScanOpenMs + milliseconds : 0
      if (this.#slotBScanOpenMs < 200) return
      this.#slotBScanLocked = true
      this.#slotBScanQuietMs = 0
      const previous = this.#slotBActivityScores.get(this.#slotB.id) ?? 0
      this.#slotBActivityScores.set(this.#slotB.id, Math.min(8, previous + 2))
      if (this.#slotBScanTimer) clearTimeout(this.#slotBScanTimer)
      this.#slotBScanTimer = undefined
      this.replayB.setChannel(this.#slotB.id)
      this.#slotBScanRecovery.beginCall()
      for (const buffered of this.#slotBScanPreRoll) {
        const segments = this.replayB.append(buffered.chunk, buffered.at, buffered.discriminatorNoise, buffered.qualitySpans)
        if (segments.length > 0) this.#slotBScanRecovery.markStored()
        for (const segment of segments) {
          this.transcription.enqueue(segment, this.config.squelch)
        }
      }
      this.#slotBScanPreRoll = []
      this.#emitStatus()
    } else {
      const segments = this.replayB.append(chunk, Date.now(), discriminatorNoise)
      if (segments.length > 0) this.#slotBScanRecovery.markStored()
      for (const segment of segments) {
        this.transcription.enqueue(segment, this.config.squelch)
      }
    }
    this.#slotBScanQuietMs = open ? 0 : this.#slotBScanQuietMs + milliseconds
    if (this.#slotBScanQuietMs >= 5_000) {
      const segment = this.replayB.flush()
      if (segment) this.transcription.enqueue(segment, this.config.squelch)
      this.#slotBScanLocked = false
      this.#slotBScanOpenMs = 0
      this.#slotBScanQuietMs = 0
      this.#slotBScanRecovery.endCall(Date.now())
      this.#scheduleSlotBScan(0)
    }
  }

  #bestSpectrumChannel(candidates: VhfChannel[], rejectedUntil: ReadonlyMap<string, number>, now: number, excludedFrequency?: number): VhfChannel | undefined {
    return candidates
      .filter((channel) => channel.frequencyHz !== excludedFrequency && (rejectedUntil.get(channel.id) ?? 0) <= now)
      .map((channel) => ({ channel, score: (this.#spectrumActivityScores.get(channel.id) ?? 0) * (channel.id === '16' ? 1.2 : 1) }))
      .filter(({ score }) => score >= SPECTRUM_ACTIVITY_THRESHOLD)
      .sort((left, right) => right.score - left.score)[0]?.channel
  }

  #retargetSpectrumScans(): void {
    if (this.#singleFrequency || !(this.#receiver instanceof NativeSidecarReceiver)) return
    const now = Date.now()
    if (this.#slotAMode === 'scan' && !this.#scanLocked) {
      if (this.#scanTargetedAt > 0 && now - this.#scanTargetedAt >= 1_500) {
        this.#scanRejectedUntil.set(this.#channel.id, now + 8_000)
        this.#scanTargetedAt = 0
      }
      const next = this.#bestSpectrumChannel(
        this.#scanChannels().concat(channelById('16', this.#channelRegion)!), this.#scanRejectedUntil, now,
        this.#slotB.id === '70' ? undefined : this.#slotB.frequencyHz
      )
      if (next && next.frequencyHz !== this.#channel.frequencyHz) {
        this.#channel = next
        this.#scanOpenMs = 0
        this.#scanPreRoll = []
        this.#scanTargetedAt = now
        this.#scanRecovery.target(now)
        this.#receiver.tune(next)
      } else if (next && this.#scanTargetedAt === 0) this.#scanTargetedAt = now
    }
    if (this.#slotBMode === 'scan' && !this.#slotBScanLocked) {
      if (this.#slotBScanTargetedAt > 0 && now - this.#slotBScanTargetedAt >= 1_500) {
        this.#slotBScanRejectedUntil.set(this.#slotB.id, now + 8_000)
        this.#slotBScanTargetedAt = 0
      }
      const next = this.#bestSpectrumChannel(this.#slotBScanChannels(), this.#slotBScanRejectedUntil, now, this.#channel.frequencyHz)
      if (next && next.frequencyHz !== this.#slotB.frequencyHz) {
        this.#slotB = next
        this.#slotBScanOpenMs = 0
        this.#slotBScanPreRoll = []
        this.#slotBScanTargetedAt = now
        this.#slotBScanRecovery.target(now)
        this.#receiver.tuneSlotB(next)
      } else if (next && this.#slotBScanTargetedAt === 0) this.#slotBScanTargetedAt = now
    }
  }

  #appendScanPreRoll(target: ScanPreRollChunk[], chunk: Buffer, discriminatorNoise: number, capturedAt?: number, qualitySpans?: ReceiverQualitySpan[]): void {
    const durationMs = chunk.length / 2 / this.config.sampleRate * 1_000
    mergeTimestampedScanPreRoll(target, { chunk, discriminatorNoise, at: capturedAt ?? Date.now() - durationMs, recovered: capturedAt !== undefined,
      ...(qualitySpans ? { qualitySpans: qualitySpans.map((span) => ({ ...span })) } : {}) }, this.config.sampleRate)
  }

  #emitStatus(): void {
    this.emit('status', this.status())
  }
}
