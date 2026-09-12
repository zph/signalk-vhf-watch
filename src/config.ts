import { channelById, type ChannelRegion } from './channels'

export type ReceiverMode = 'demo' | 'rtl_fm'

export interface VhfWatchConfig {
  enabled: boolean
  receiverMode: ReceiverMode
  channelRegion: ChannelRegion
  initialChannel: string
  deviceIndex: number
  gainDb?: number
  squelch: number
  sampleRate: number
  replayMinutes: number
  segmentSeconds: number
  maxBufferMiB: number
}

export const DEFAULT_CONFIG: VhfWatchConfig = {
  enabled: true,
  receiverMode: 'demo',
  channelRegion: 'US_CA',
  initialChannel: '16',
  deviceIndex: 0,
  squelch: 20,
  sampleRate: 16_000,
  replayMinutes: 30,
  segmentSeconds: 5,
  maxBufferMiB: 64
}

function finiteNumber(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

export function normalizeConfig(raw: unknown): VhfWatchConfig {
  const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const requestedChannel = String(value.initialChannel ?? DEFAULT_CONFIG.initialChannel).toUpperCase()
  const receiverMode: ReceiverMode = value.receiverMode === 'rtl_fm' ? 'rtl_fm' : 'demo'
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
    deviceIndex: Math.max(0, Math.floor(finiteNumber(value.deviceIndex, DEFAULT_CONFIG.deviceIndex))),
    ...(gain === undefined ? {} : { gainDb: gain }),
    squelch: Math.min(100, Math.max(0, Math.floor(finiteNumber(value.squelch, DEFAULT_CONFIG.squelch)))),
    sampleRate: [8_000, 16_000, 24_000, 32_000, 48_000].includes(Number(value.sampleRate))
      ? Number(value.sampleRate)
      : DEFAULT_CONFIG.sampleRate,
    replayMinutes: Math.min(120, Math.max(1, Math.floor(finiteNumber(value.replayMinutes, DEFAULT_CONFIG.replayMinutes)))),
    segmentSeconds: Math.min(30, Math.max(2, Math.floor(finiteNumber(value.segmentSeconds, DEFAULT_CONFIG.segmentSeconds)))),
    maxBufferMiB: Math.min(256, Math.max(16, Math.floor(finiteNumber(value.maxBufferMiB, DEFAULT_CONFIG.maxBufferMiB))))
  }
}

export const pluginSchema = {
  type: 'object',
  properties: {
    enabled: { type: 'boolean', title: 'Enable receiver', default: true },
    receiverMode: {
      type: 'string',
      title: 'Receiver source',
      enum: ['demo', 'rtl_fm'],
      enumNames: ['Demo audio (no hardware)', 'RTL-SDR using rtl_fm'],
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
    deviceIndex: { type: 'integer', title: 'RTL-SDR device index', minimum: 0, default: 0 },
    gainDb: { type: 'number', title: 'Manual tuner gain (dB; blank for automatic)', minimum: 0, maximum: 49.6 },
    squelch: { type: 'integer', title: 'rtl_fm squelch level', minimum: 0, maximum: 100, default: 20 },
    sampleRate: { type: 'integer', title: 'Audio sample rate', enum: [8000, 16000, 24000, 32000, 48000], default: 16000 },
    replayMinutes: { type: 'integer', title: 'Private rolling replay (minutes)', minimum: 1, maximum: 120, default: 30 },
    segmentSeconds: { type: 'integer', title: 'Replay segment length (seconds)', minimum: 2, maximum: 30, default: 5 },
    maxBufferMiB: { type: 'integer', title: 'Maximum replay memory (MiB)', minimum: 16, maximum: 256, default: 64 }
  }
} as const
