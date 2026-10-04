import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { channelPlan, type VhfChannel } from './channels'
import type { VhfWatchConfig } from './config'
import { discriminatorThreshold } from './squelch'

export const WIDEBAND_CENTER_HZ = 156_750_000
export const WIDEBAND_SAMPLE_RATE = 2_400_000
export const DSC_CHANNEL_HZ = 156_525_000
export const CHANNEL_GUARD_HZ = 25_000
const SIDECAR_STDERR_LIMIT = 4 * 1024
const SIDECAR_NO_OUTPUT_TIMEOUT_MS = 15_000
const SIDECAR_HEALTHY_RESET_MS = 10_000

interface SidecarAttemptOptions {
  noOutputTimeoutMs?: number
  healthyResetMs?: number
  retryDelayMs?: number
}

function signalSidecarGroup(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (process.platform !== 'win32' && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal)
      return
    } catch { /* Fall back to the direct child if group signaling is unavailable. */ }
  }
  child.kill(signal)
}

function sidecarDiagnostic(stderr: string): string | undefined {
  const lines = stderr.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const causes = lines.filter((line) =>
    /error|failed|failure|lost|denied|unable|cannot|no device|not found|busy|permission|timeout|timed out|usb|rtl_sdr/i.test(line) &&
    !/^exit status \d+$/i.test(line) &&
    !/^(?:rtl_sdr stopped|sidecar stopped):?\s*exit status \d+$/i.test(line)
  )
  const claimFailure = causes.filter((line) => /busy|claim[_ ]interface|interface.*claim|resource.*busy/i.test(line)).at(-1)
  const useful = claimFailure ?? causes.at(-1) ?? lines.at(-1)
  if (!useful) return undefined
  const busy = /busy|claim[_ ]interface|interface.*claim|resource.*busy/i.test(useful)
  const details = causes.length > 1 && !claimFailure ? `${causes.at(-2)}\n${useful}` : useful
  return `${details.split('\n').map((line) => line.slice(-500)).join('\n').slice(-1_000)}${busy ? '; the SDR may be in use by AIS-Catcher; disable one receiver before enabling the other' : ''}`
}

export interface ReceiverQualitySpan {
  bytes: number
  discriminatorNoise: number
}

export interface ReceiverEvents {
  audio: [Buffer]
  replayAudio: [Buffer, number, number?, number?, ReceiverQualitySpan[]?]
  slotBReplayAudio: [Buffer, number, number?, number?, ReceiverQualitySpan[]?]
  dscAudio: [Buffer]
  error: [Error]
  metrics: [ReceiverMetrics]
  state: [string]
}

export interface ReceiverMetrics {
  droppedIqChunks: number
  droppedIqBytes: number
  restarts: number
  voiceDiscriminatorNoise?: number
  slotBDiscriminatorNoise?: number
  dscDiscriminatorNoise?: number
  voiceCarrierOffsetHz?: number
  slotBCarrierOffsetHz?: number
  iqEdgeFraction?: number
  spectrumActivity?: Record<string, number>
}

export abstract class AudioReceiver extends EventEmitter<ReceiverEvents> {
  abstract start(): void
  abstract stop(): void
}

export function rtlSdrArgs(config: VhfWatchConfig): string[] {
  return [
    '-d', config.device,
    '-f', String(WIDEBAND_CENTER_HZ),
    '-s', String(WIDEBAND_SAMPLE_RATE),
    '-p', String(config.ppm),
    ...(config.gainDb === undefined ? [] : ['-g', String(config.gainDb)]),
    '-'
  ]
}

export function canChannelize(frequencyHz: number): boolean {
  return Math.abs(frequencyHz - WIDEBAND_CENTER_HZ) <= WIDEBAND_SAMPLE_RATE / 2 - CHANNEL_GUARD_HZ
}

export function nativeSidecarArgs(
  config: VhfWatchConfig,
  channel: VhfChannel,
  slotB: VhfChannel | '70' = '70',
  singleFrequency = false
): string[] {
  const centerHz = singleFrequency ? channel.frequencyHz : WIDEBAND_CENTER_HZ
  const secondaryHz = singleFrequency ? channel.frequencyHz : slotB === '70' ? DSC_CHANNEL_HZ : slotB.frequencyHz
  const scanFrequencies = [...new Set(channelPlan('US_CA')
    .filter((candidate) => !candidate.weather && candidate.frequencyHz !== DSC_CHANNEL_HZ && canChannelize(candidate.frequencyHz))
    .map((candidate) => candidate.frequencyHz))]
    .sort((left, right) => left - right)
  return [
    '--mode', 'stream',
    '--device', config.device,
    '--sample-rate', String(WIDEBAND_SAMPLE_RATE),
    '--center', String(centerHz),
    '--voice', String(channel.frequencyHz),
    '--dsc', String(singleFrequency ? channel.frequencyHz : DSC_CHANNEL_HZ),
    '--slot-b', String(secondaryHz),
    '--audio-rate', String(config.sampleRate),
    '--ppm', String(config.ppm),
    '--squelch', String(config.squelch),
    ...(!singleFrequency && scanFrequencies.length > 0 ? ['--scan-frequencies', scanFrequencies.join(',')] : []),
    ...(config.gainDb === undefined ? [] : ['--gain', String(config.gainDb)])
  ]
}

export interface SidecarFrame {
  kind: number
  payload: Buffer
}

export function parseSidecarFrames(buffer: Buffer): { frames: SidecarFrame[]; remaining: Buffer } {
  const frames: SidecarFrame[] = []
  let offset = 0
  while (buffer.length - offset >= 5) {
    const length = buffer.readUInt32LE(offset + 1)
    if (length > 16 * 1024 * 1024) throw new Error(`Invalid sidecar frame length ${length}`)
    if (buffer.length - offset - 5 < length) break
    frames.push({ kind: buffer[offset]!, payload: buffer.subarray(offset + 5, offset + 5 + length) })
    offset += 5 + length
  }
  return { frames, remaining: buffer.subarray(offset) }
}

export interface SpannedBackfillFrame {
  capturedAt: number
  frequencyHz: number
  discriminatorNoise: number
  qualitySpans: ReceiverQualitySpan[]
  pcm: Buffer
}

export function parseSpannedBackfillFrame(payload: Buffer): SpannedBackfillFrame {
  if (payload.length < 20) throw new Error('Truncated quality-spanned retrospective frame from VHF sidecar')
  const capturedAt = Number(payload.readBigInt64LE(0))
  const frequencyHz = Number(payload.readBigInt64LE(8))
  const spanCount = payload.readUInt32LE(16)
  if (!Number.isSafeInteger(capturedAt) || !Number.isSafeInteger(frequencyHz) || spanCount > Math.floor((payload.length - 20) / 12)) {
    throw new Error('Invalid quality-spanned retrospective frame header from VHF sidecar')
  }
  const qualitySpans: ReceiverQualitySpan[] = []
  const pcmOffset = 20 + spanCount * 12
  let totalBytes = 0
  let weightedNoise = 0
  for (let index = 0; index < spanCount; index += 1) {
    const offset = 20 + index * 12
    const bytes = payload.readUInt32LE(offset)
    const discriminatorNoise = payload.readDoubleLE(offset + 4)
    if (bytes === 0 || bytes % 2 !== 0 || !Number.isFinite(discriminatorNoise) || totalBytes + bytes > payload.length - pcmOffset) {
      throw new Error('Invalid quality span in retrospective frame from VHF sidecar')
    }
    qualitySpans.push({ bytes, discriminatorNoise })
    totalBytes += bytes
    weightedNoise += bytes * discriminatorNoise
  }
  if (totalBytes !== payload.length - pcmOffset || qualitySpans.length === 0) {
    throw new Error('Quality spans do not match retrospective PCM from VHF sidecar')
  }
  return { capturedAt, frequencyHz, discriminatorNoise: weightedNoise / totalBytes, qualitySpans, pcm: payload.subarray(pcmOffset) }
}

export class NativeSidecarReceiver extends AudioReceiver {
  readonly #config: VhfWatchConfig
  #channel: VhfChannel
  #slotB: VhfChannel | '70'
  readonly #singleFrequency: boolean
  #process?: ReturnType<typeof spawn>
  #active = false
  #restartTimer?: ReturnType<typeof setTimeout>
  #terminateCurrent?: () => void
  #restartDelayMs = 1_000
  #buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  #metrics: ReceiverMetrics = { droppedIqChunks: 0, droppedIqBytes: 0, restarts: 0 }
  readonly #attemptOptions: Required<SidecarAttemptOptions>

  constructor(
    config: VhfWatchConfig,
    channel: VhfChannel,
    slotB: VhfChannel | '70' = '70',
    singleFrequency = false,
    attemptOptions: SidecarAttemptOptions = {}
  ) {
    super()
    this.#config = config
    this.#channel = channel
    this.#slotB = slotB
    this.#singleFrequency = singleFrequency
    this.#attemptOptions = {
      noOutputTimeoutMs: attemptOptions.noOutputTimeoutMs ?? SIDECAR_NO_OUTPUT_TIMEOUT_MS,
      healthyResetMs: attemptOptions.healthyResetMs ?? SIDECAR_HEALTHY_RESET_MS,
      retryDelayMs: attemptOptions.retryDelayMs ?? 1_000
    }
  }

  start(): void {
    if (this.#active) return
    if (!this.#singleFrequency && !canChannelize(this.#channel.frequencyHz)) {
      this.emit('error', new Error(`${this.#channel.label} is outside the continuous DSC capture window`))
      return
    }
    this.#active = true
    this.#startCapture()
  }

  #startCapture(): void {
    if (!this.#active || this.#process) return
    const attempt = this.#metrics.restarts + 1
    this.emit('state', this.#singleFrequency
      ? `Starting single-frequency receiver on ${this.#channel.label} (attempt ${attempt})`
      : `Starting native wideband receiver (attempt ${attempt})`)
    const child = spawn(this.#config.sidecarPath, nativeSidecarArgs(this.#config, this.#channel, this.#slotB, this.#singleFrequency), {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32'
    })
    this.#process = child
    let closed = false
    let failure: Error | undefined
    let firstFrameAt: number | undefined
    let exitResult: { code: number | null; signal: NodeJS.Signals | null } | undefined
    let stderrTail = Buffer.alloc(0)
    let watchdog: ReturnType<typeof setTimeout> | undefined
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined
    const clearAttemptTimers = (): void => {
      if (watchdog) clearTimeout(watchdog)
      if (forceKillTimer) clearTimeout(forceKillTimer)
      watchdog = undefined
      forceKillTimer = undefined
      if (this.#process === child) this.#terminateCurrent = undefined
    }
    const terminate = (error?: Error): void => {
      if (error && !failure) failure = error
      if (watchdog) clearTimeout(watchdog)
      watchdog = undefined
      signalSidecarGroup(child, 'SIGTERM')
      if (!forceKillTimer) {
        forceKillTimer = setTimeout(() => {
          if (!closed) signalSidecarGroup(child, 'SIGKILL')
        }, 2_000)
        forceKillTimer.unref?.()
      }
    }
    this.#terminateCurrent = () => terminate()
    const failed = (error: Error): void => {
      if (closed || failure) return
      terminate(error)
    }
    const armWatchdog = (): void => {
      if (watchdog) clearTimeout(watchdog)
      watchdog = setTimeout(() => {
        watchdog = undefined
        failed(new Error(`VHF sidecar produced no complete output frame for ${this.#attemptOptions.noOutputTimeoutMs / 1_000}s`))
      }, this.#attemptOptions.noOutputTimeoutMs)
      watchdog.unref?.()
    }
    armWatchdog()
    child.stdout.on('data', (chunk: Buffer) => {
      if (closed || !this.#active || this.#process !== child) return
      try {
        const parsed = parseSidecarFrames(this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]))
        this.#buffer = parsed.remaining
        let validFrames = 0
        for (const frame of parsed.frames) {
          if (frame.kind === 1) {
            if (frame.payload.length < 8) throw new Error('Truncated voice frame from VHF sidecar')
            const discriminatorNoise = frame.payload.readDoubleLE(0)
            const rawPcm = frame.payload.subarray(8)
            this.#metrics.voiceDiscriminatorNoise = discriminatorNoise
            const open = discriminatorNoise < discriminatorThreshold(this.#config.squelch)
            this.emit('audio', open ? rawPcm : Buffer.alloc(rawPcm.length))
            this.emit('replayAudio', rawPcm, discriminatorNoise)
            validFrames += 1
          }
          else if (frame.kind === 2) {
            this.emit('dscAudio', frame.payload)
            validFrames += 1
          }
          else if (frame.kind === 4) {
            if (frame.payload.length < 8) throw new Error('Truncated Slot B voice frame from VHF sidecar')
            const discriminatorNoise = frame.payload.readDoubleLE(0)
            this.#metrics.slotBDiscriminatorNoise = discriminatorNoise
            this.emit('slotBReplayAudio', frame.payload.subarray(8), discriminatorNoise)
            validFrames += 1
          }
          else if (frame.kind === 5 || frame.kind === 6) {
            if (frame.payload.length < 24) throw new Error('Truncated retrospective voice frame from VHF sidecar')
            const capturedAt = Number(frame.payload.readBigInt64LE(0))
            const frequencyHz = Number(frame.payload.readBigInt64LE(8))
            const discriminatorNoise = frame.payload.readDoubleLE(16)
            if (frame.kind === 5 && frequencyHz === this.#channel.frequencyHz) {
              this.emit('replayAudio', frame.payload.subarray(24), discriminatorNoise, capturedAt, frequencyHz)
            } else if (frame.kind === 6 && this.#slotB !== '70' && frequencyHz === this.#slotB.frequencyHz) {
              this.emit('slotBReplayAudio', frame.payload.subarray(24), discriminatorNoise, capturedAt, frequencyHz)
            }
            validFrames += 1
          }
          else if (frame.kind === 7 || frame.kind === 8) {
            const backfill = parseSpannedBackfillFrame(frame.payload)
            if (frame.kind === 7 && backfill.frequencyHz === this.#channel.frequencyHz) {
              this.emit('replayAudio', backfill.pcm, backfill.discriminatorNoise, backfill.capturedAt, backfill.frequencyHz, backfill.qualitySpans)
            } else if (frame.kind === 8 && this.#slotB !== '70' && backfill.frequencyHz === this.#slotB.frequencyHz) {
              this.emit('slotBReplayAudio', backfill.pcm, backfill.discriminatorNoise, backfill.capturedAt, backfill.frequencyHz, backfill.qualitySpans)
            }
            validFrames += 1
          }
          else if (frame.kind === 3) {
            const state = JSON.parse(frame.payload.toString('utf8')) as {
              voice_level?: number
              slot_b_level?: number
              dsc_level?: number
              voice_carrier_offset_hz?: number
              slot_b_carrier_offset_hz?: number
              iq_edge_fraction?: number
              spectrum_activity?: Record<string, number>
            }
            this.#metrics.voiceDiscriminatorNoise = state.voice_level
            this.#metrics.slotBDiscriminatorNoise = state.slot_b_level
            this.#metrics.dscDiscriminatorNoise = state.dsc_level
            this.#metrics.voiceCarrierOffsetHz = state.voice_carrier_offset_hz
            this.#metrics.slotBCarrierOffsetHz = state.slot_b_carrier_offset_hz
            this.#metrics.iqEdgeFraction = state.iq_edge_fraction
            this.#metrics.spectrumActivity = state.spectrum_activity
            this.emit('metrics', { ...this.#metrics })
            this.emit('state', this.#singleFrequency
              ? `Single-frequency capture · Slot A ${this.#channel.label} · Slot B + DSC paused`
              : `Wideband capture · Slot A ${this.#channel.label} + Slot B ${this.#slotB === '70' ? 'DSC 70' : this.#slotB.label}`)
            validFrames += 1
          } else {
            throw new Error(`Unknown frame kind ${frame.kind} from VHF sidecar`)
          }
        }
        if (validFrames > 0) {
          const now = Date.now()
          firstFrameAt ??= now
          if (now - firstFrameAt >= this.#attemptOptions.healthyResetMs && this.#restartDelayMs > this.#attemptOptions.retryDelayMs) {
            this.#restartDelayMs = this.#attemptOptions.retryDelayMs
            this.emit('state', `Receiver recovered after ${Math.floor((now - firstFrameAt) / 1_000)}s of sidecar output; retry backoff reset`)
          }
          armWatchdog()
        }
      } catch (error) {
        failed(error instanceof Error ? error : new Error(String(error)))
      }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderrTail = Buffer.concat([stderrTail, chunk])
      if (stderrTail.length > SIDECAR_STDERR_LIMIT) stderrTail = stderrTail.subarray(stderrTail.length - SIDECAR_STDERR_LIMIT)
    })
    child.stdin.on('error', failed)
    child.stdout.on('error', failed)
    child.stderr.on('error', failed)
    child.on('exit', (code, signal) => {
      const expected = !this.#active && signal === 'SIGTERM'
      if (!expected && !failure) terminate()
      exitResult = { code, signal }
    })
    child.on('close', (code, signal) => {
      if (closed) return
      closed = true
      signalSidecarGroup(child, 'SIGKILL')
      clearAttemptTimers()
      if (this.#process !== child) return
      const expected = !this.#active && signal === 'SIGTERM'
      const exit = exitResult ?? { code, signal }
      const diagnostic = sidecarDiagnostic(stderrTail.toString('utf8'))
      const context = `VHF sidecar attempt ${attempt} failed on ${this.#channel.label} (${this.#channel.frequencyHz} Hz, RTL device ${this.#config.device})`
      const terminal = failure
        ? new Error(`${context}: ${failure.message}${diagnostic ? `: ${diagnostic}` : ''}`)
        : expected
          ? undefined
          : new Error(`${context}: exited with code ${exit.code ?? 'unknown'}${exit.signal ? ` (${exit.signal})` : ''}${diagnostic ? `: ${diagnostic}` : ''}`)
      this.#captureEnded(child, terminal)
    })
    child.on('error', (error) => {
      if (closed) return
      const spawnFailure = new Error(`VHF sidecar attempt ${attempt} could not start: ${error.message}`)
      if (child.pid === undefined) {
        closed = true
        clearAttemptTimers()
        if (this.#process === child && this.#active) this.#captureEnded(child, spawnFailure)
      } else if (this.#process === child && this.#active) failed(spawnFailure)
    })
  }

  #captureEnded(child: ReturnType<typeof spawn>, error?: Error): void {
    if (this.#process !== child) return
    this.#process = undefined
    this.#buffer = Buffer.alloc(0)
    if (!this.#active) {
      this.emit('state', 'Stopped')
      return
    }
    this.#metrics.restarts += 1
    this.emit('metrics', { ...this.#metrics })
    if (error) this.emit('error', error)
    const delay = this.#restartDelayMs
    this.emit('state', `Receiver unavailable; retrying in ${delay / 1_000}s`)
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = undefined
      this.#startCapture()
    }, delay)
    this.#restartDelayMs = Math.min(delay * 2, 30_000)
  }

  tune(channel: VhfChannel): void {
    if (this.#singleFrequency) throw new Error('Single-frequency capture must restart before retuning')
    if (!canChannelize(channel.frequencyHz)) {
      throw new Error(`${channel.label} is outside the ${WIDEBAND_SAMPLE_RATE / 1_000_000} MHz continuous DSC capture window; use a second SDR for this channel`)
    }
    this.#channel = channel
    this.#process?.stdin?.write(`tune ${channel.frequencyHz}\n`)
    this.emit('state', `Wideband capture · Slot A ${channel.label} + Slot B ${this.#slotB === '70' ? 'DSC 70' : this.#slotB.label}`)
  }

  tuneSlotB(channel: VhfChannel | '70'): void {
    if (this.#singleFrequency) throw new Error('Single-frequency capture must restart before retuning Slot B')
    const frequencyHz = channel === '70' ? DSC_CHANNEL_HZ : channel.frequencyHz
    if (!canChannelize(frequencyHz)) {
      throw new Error(`Slot B ${channel === '70' ? '70' : channel.label} is outside the wideband capture window`)
    }
    this.#slotB = channel
    this.#process?.stdin?.write(`tune-b ${frequencyHz}\n`)
    this.emit('state', `Wideband capture · Slot A ${this.#channel.label} + Slot B ${channel === '70' ? 'DSC 70' : channel.label}`)
  }

  stop(): void {
    this.#active = false
    if (this.#restartTimer) clearTimeout(this.#restartTimer)
    this.#restartTimer = undefined
    const child = this.#process
    this.#process = undefined
    if (child) this.#terminateCurrent?.()
    this.#terminateCurrent = undefined
    this.#buffer = Buffer.alloc(0)
    this.emit('state', 'Stopped')
  }
}

interface ChannelizerMessage {
  type: 'voice' | 'dsc' | 'state' | 'error' | 'ready'
  pcm?: ArrayBuffer
  message?: string
}

interface WorkerSlot {
  kind: 'voice' | 'dsc'
  worker: Worker
  busy: boolean
  pending?: ArrayBuffer
}

export class WidebandRtlReceiver extends AudioReceiver {
  readonly #config: VhfWatchConfig
  #channel: VhfChannel
  #process?: ReturnType<typeof spawn>
  #workerSlots: WorkerSlot[] = []
  #oddByte?: Buffer
  #active = false
  #restartTimer?: ReturnType<typeof setTimeout>
  #restartDelayMs = 1_000
  #metrics: ReceiverMetrics = { droppedIqChunks: 0, droppedIqBytes: 0, restarts: 0 }

  constructor(config: VhfWatchConfig, channel: VhfChannel) {
    super()
    this.#config = config
    this.#channel = channel
  }

  start(): void {
    if (this.#active) return
    if (!canChannelize(this.#channel.frequencyHz)) {
      this.emit('error', new Error(`${this.#channel.label} is outside the continuous DSC capture window`))
      return
    }
    this.#active = true
    this.#startCapture()
  }

  #startCapture(): void {
    if (!this.#active || this.#process) return
    this.emit('state', 'Starting wideband RTL-SDR')
    const child = spawn('rtl_sdr', rtlSdrArgs(this.#config), {
      stdio: ['ignore', 'pipe', 'pipe']
    })
    this.#process = child
    let finalized = false
    const slots: WorkerSlot[] = (['voice', 'dsc'] as const).map((kind) => ({
      kind,
      busy: false,
      worker: new Worker(path.join(__dirname, 'channelizer-worker.js'), {
        workerData: {
          centerHz: WIDEBAND_CENTER_HZ,
          iqSampleRate: WIDEBAND_SAMPLE_RATE,
          audioSampleRate: this.#config.sampleRate,
          voiceFrequencyHz: this.#channel.frequencyHz,
          dscFrequencyHz: DSC_CHANNEL_HZ,
          squelch: this.#config.squelch,
          channelKind: kind
        }
      })
    }))
    this.#workerSlots = slots
    const failed = (error: Error): void => {
      if (finalized) return
      finalized = true
      this.#captureEnded(child, slots, error)
    }
    for (const slot of slots) {
      slot.worker.on('message', (value: ChannelizerMessage) => {
        if (value.type === 'voice' && value.pcm) this.emit('audio', Buffer.from(value.pcm))
        else if (value.type === 'dsc' && value.pcm) this.emit('dscAudio', Buffer.from(value.pcm))
        else if (value.type === 'ready') this.#workerReady(slot)
        else if (value.type === 'state' && value.message) {
          this.#restartDelayMs = 1_000
          this.emit('state', value.message)
        }
        else if (value.type === 'error') failed(new Error(value.message ?? 'Channelizer failed'))
      })
      slot.worker.on('error', failed)
    }
    child.stdout.on('data', (chunk: Buffer) => {
      let iq = this.#oddByte ? Buffer.concat([this.#oddByte, chunk]) : chunk
      this.#oddByte = undefined
      if (iq.length % 2 !== 0) {
        this.#oddByte = iq.subarray(iq.length - 1)
        iq = iq.subarray(0, iq.length - 1)
      }
      if (iq.length === 0 || this.#workerSlots !== slots) return
      for (const slot of slots) {
        const copy = Uint8Array.from(iq).buffer
        if (slot.busy) {
          if (slot.pending) {
            this.#metrics.droppedIqChunks += 1
            this.#metrics.droppedIqBytes += slot.pending.byteLength
            this.emit('metrics', { ...this.#metrics })
          }
          slot.pending = copy
        } else {
          this.#postIq(slot, copy)
        }
      }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      const message = chunk.toString('utf8').trim()
      if (message) this.emit('state', message.split('\n').at(-1) ?? message)
    })
    child.on('error', failed)
    child.on('exit', (code, signal) => {
      if (finalized) return
      finalized = true
      const expected = !this.#active && signal === 'SIGTERM'
      this.#captureEnded(child, slots, expected
        ? undefined
        : new Error(`rtl_sdr exited with code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}`))
    })
  }

  #postIq(slot: WorkerSlot, iq: ArrayBuffer): void {
    if (!this.#workerSlots.includes(slot)) return
    slot.busy = true
    slot.worker.postMessage({ type: 'iq', iq }, [iq])
  }

  #workerReady(slot: WorkerSlot): void {
    if (!this.#workerSlots.includes(slot)) return
    const pending = slot.pending
    slot.pending = undefined
    if (pending) this.#postIq(slot, pending)
    else slot.busy = false
  }

  #captureEnded(child: ReturnType<typeof spawn>, slots: WorkerSlot[], error?: Error): void {
    if (this.#process === child) this.#process = undefined
    if (this.#workerSlots === slots) {
      this.#workerSlots = []
      for (const slot of slots) void slot.worker.terminate()
    }
    if (error && !child.killed) child.kill('SIGTERM')
    this.#oddByte = undefined
    if (!this.#active) {
      this.emit('state', 'Stopped')
      return
    }
    this.#metrics.restarts += 1
    this.emit('metrics', { ...this.#metrics })
    if (error) this.emit('error', error)
    const delay = this.#restartDelayMs
    this.emit('state', `Receiver unavailable; retrying in ${delay / 1_000}s`)
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = undefined
      this.#startCapture()
    }, delay)
    this.#restartDelayMs = Math.min(delay * 2, 30_000)
  }

  tune(channel: VhfChannel): void {
    if (!canChannelize(channel.frequencyHz)) {
      throw new Error(`${channel.label} is outside the ${WIDEBAND_SAMPLE_RATE / 1_000_000} MHz continuous DSC capture window; use a second SDR for this channel`)
    }
    this.#channel = channel
    this.#workerSlots.find((slot) => slot.kind === 'voice')?.worker.postMessage({
      type: 'tune', voiceFrequencyHz: channel.frequencyHz
    })
    this.emit('state', `Wideband capture · voice ${channel.label} + DSC 70`)
  }

  stop(): void {
    this.#active = false
    if (this.#restartTimer) clearTimeout(this.#restartTimer)
    this.#restartTimer = undefined
    const child = this.#process
    this.#process = undefined
    child?.kill('SIGTERM')
    const slots = this.#workerSlots
    this.#workerSlots = []
    for (const slot of slots) void slot.worker.terminate()
    this.#oddByte = undefined
    if (!child) this.emit('state', 'Stopped')
  }
}

export class DemoReceiver extends AudioReceiver {
  readonly #sampleRate: number
  #timer?: ReturnType<typeof setInterval>
  #sample = 0

  constructor(sampleRate: number) {
    super()
    this.#sampleRate = sampleRate
  }

  start(): void {
    if (this.#timer) return
    this.emit('state', 'Demo receiver active')
    const samplesPerFrame = Math.floor(this.#sampleRate / 10)
    this.#timer = setInterval(() => {
      const pcm = Buffer.alloc(samplesPerFrame * 2)
      for (let index = 0; index < samplesPerFrame; index += 1) {
        // A restrained two-tone identifier makes it obvious that no radio hardware is connected.
        const elapsed = this.#sample++ / this.#sampleRate
        const active = Math.floor(elapsed / 2) % 4 === 0
        const value = active
          ? Math.round((Math.sin(2 * Math.PI * 440 * elapsed) + Math.sin(2 * Math.PI * 660 * elapsed) * 0.35) * 3500)
          : 0
        pcm.writeInt16LE(value, index * 2)
      }
      this.emit('audio', pcm)
    }, 100)
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = undefined
    this.emit('state', 'Stopped')
  }
}
