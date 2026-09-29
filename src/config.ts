import path from 'node:path'
import { channelById, type ChannelRegion } from './channels'

export type ReceiverMode = 'demo' | 'rtl_sdr'

export interface VhfWatchConfig {
  enabled: boolean
  receiverMode: ReceiverMode
  channelRegion: ChannelRegion
  initialChannel: string
  device: string
  sidecarPath: string
  ppm: number
  gainDb?: number
  squelch: number
  sampleRate: number
  replayMinutes: number
  segmentSeconds: number
  maxBufferMiB: number
  dscRetentionHours: number
  maxDscMessages: number
  maxDscCacheKiB: number
}

export function defaultSidecarPath(platform = process.platform, architecture = process.arch): string {
  return path.join(__dirname, '..', 'bin', `${platform}-${architecture}`, 'vhf-watch-sidecar')
}

export const DEFAULT_CONFIG: VhfWatchConfig = {
  enabled: true,
  receiverMode: 'demo',
  channelRegion: 'US_CA',
  initialChannel: '16',
  device: '0',
  sidecarPath: defaultSidecarPath(),
  ppm: 0,
  squelch: 20,
  sampleRate: 16_000,
  replayMinutes: 120,
  segmentSeconds: 5,
  maxBufferMiB: 256,
  dscRetentionHours: 168,
  maxDscMessages: 100,
  maxDscCacheKiB: 256
}

function finiteNumber(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

export function normalizeConfig(raw: unknown): VhfWatchConfig {
  const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const requestedChannel = String(value.initialChannel ?? DEFAULT_CONFIG.initialChannel).toUpperCase()
  // Migrate the original one-channel rtl_fm setting to the shared wideband receiver.
  const receiverMode: ReceiverMode = value.receiverMode === 'rtl_sdr' || value.receiverMode === 'rtl_fm'
    ? 'rtl_sdr'
    : 'demo'
  const channelRegion: ChannelRegion = value.channelRegion === 'US' || value.channelRegion === 'CA'
    ? value.channelRegion
    : 'US_CA'
  const gain = value.gainDb === undefined || value.gainDb === null || value.gainDb === ''
    ? undefined
    : Math.min(49.6, Math.max(0, finiteNumber(value.gainDb, 0)))
  return {
    enabled: value.enabled !== false,
    receiverMode,
    channelRegion,
    initialChannel: channelById(requestedChannel, channelRegion)?.id ?? DEFAULT_CONFIG.initialChannel,
    device: String(value.device ?? value.deviceIndex ?? DEFAULT_CONFIG.device).trim() || DEFAULT_CONFIG.device,
    sidecarPath: String(value.sidecarPath ?? DEFAULT_CONFIG.sidecarPath).trim() || DEFAULT_CONFIG.sidecarPath,
    ppm: Math.min(150, Math.max(-150, Math.round(finiteNumber(value.ppm, DEFAULT_CONFIG.ppm)))),
    ...(gain === undefined ? {} : { gainDb: gain }),
    squelch: Math.min(100, Math.max(0, Math.floor(finiteNumber(value.squelch, DEFAULT_CONFIG.squelch)))),
    sampleRate: [8_000, 16_000, 24_000, 32_000, 48_000].includes(Number(value.sampleRate))
      ? Number(value.sampleRate)
      : DEFAULT_CONFIG.sampleRate,
    replayMinutes: Math.min(120, Math.max(1, Math.floor(finiteNumber(value.replayMinutes, DEFAULT_CONFIG.replayMinutes)))),
    segmentSeconds: Math.min(30, Math.max(2, Math.floor(finiteNumber(value.segmentSeconds, DEFAULT_CONFIG.segmentSeconds)))),
    maxBufferMiB: Math.min(256, Math.max(16, Math.floor(finiteNumber(value.maxBufferMiB, DEFAULT_CONFIG.maxBufferMiB)))),
    dscRetentionHours: Math.min(720, Math.max(1, Math.floor(finiteNumber(value.dscRetentionHours, DEFAULT_CONFIG.dscRetentionHours)))),
    maxDscMessages: Math.min(1_000, Math.max(10, Math.floor(finiteNumber(value.maxDscMessages, DEFAULT_CONFIG.maxDscMessages)))),
    maxDscCacheKiB: Math.min(4_096, Math.max(64, Math.floor(finiteNumber(value.maxDscCacheKiB, DEFAULT_CONFIG.maxDscCacheKiB))))
  }
}

export const pluginSchema = {
  type: 'object',
  properties: {
    enabled: { type: 'boolean', title: 'Enable receiver', default: true },
    receiverMode: {
      type: 'string',
      title: 'Receiver source',
      enum: ['demo', 'rtl_sdr'],
      enumNames: ['Demo audio (no hardware)', 'RTL-SDR wideband (voice + continuous DSC watch)'],
      default: 'demo'
    },
    channelRegion: {
      type: 'string',
      title: 'Marine channel plan',
      enum: ['US_CA', 'US', 'CA'],
      enumNames: ['United States + Canada', 'United States', 'Canada'],
      default: 'US_CA'
    },
    initialChannel: { type: 'string', title: 'Channel at startup', default: '16' },
    device: {
      type: 'string',
      title: 'RTL-SDR device index or serial number',
      default: '0'
    },
    sidecarPath: {
      type: 'string',
      title: 'Native receiver sidecar path',
      default: DEFAULT_CONFIG.sidecarPath
    },
    ppm: {
      type: 'integer',
      title: 'Frequency correction (PPM)',
      minimum: -150,
      maximum: 150,
      default: 0
    },
    gainDb: { type: 'number', title: 'Manual tuner gain (dB; blank for automatic)', minimum: 0, maximum: 49.6 },
    squelch: { type: 'integer', title: 'Voice squelch level', minimum: 0, maximum: 100, default: 20 },
    sampleRate: { type: 'integer', title: 'Audio sample rate', enum: [8000, 16000, 24000, 32000, 48000], default: 16000 },
    replayMinutes: { type: 'integer', title: 'Private rolling replay (minutes)', minimum: 1, maximum: 120, default: 120 },
    segmentSeconds: { type: 'integer', title: 'Replay segment length (seconds)', minimum: 2, maximum: 30, default: 5 },
    maxBufferMiB: { type: 'integer', title: 'Maximum replay memory (MiB)', minimum: 16, maximum: 256, default: 256 },
    dscRetentionHours: { type: 'integer', title: 'DSC call retention (hours)', minimum: 1, maximum: 720, default: 168 },
    maxDscMessages: { type: 'integer', title: 'Maximum stored DSC calls', minimum: 10, maximum: 1000, default: 100 },
    maxDscCacheKiB: { type: 'integer', title: 'Maximum DSC cache (KiB)', minimum: 64, maximum: 4096, default: 256 }
  }
} as const
