import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import type { VhfChannel } from './channels'
import type { VhfWatchConfig } from './config'

export const WIDEBAND_CENTER_HZ = 156_750_000
export const WIDEBAND_SAMPLE_RATE = 2_400_000
export const DSC_CHANNEL_HZ = 156_525_000
export const CHANNEL_GUARD_HZ = 25_000

export interface ReceiverEvents {
  audio: [Buffer]
  dscAudio: [Buffer]
  error: [Error]
  metrics: [ReceiverMetrics]
  state: [string]
}

export interface ReceiverMetrics {
  droppedIqChunks: number
  droppedIqBytes: number
  restarts: number
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

interface ChannelizerMessage {
  type: 'voice' | 'dsc' | 'state' | 'error' | 'ready'
  pcm?: ArrayBuffer
  message?: string
}

export class WidebandRtlReceiver extends AudioReceiver {
  readonly #config: VhfWatchConfig
  #channel: VhfChannel
  #process?: ReturnType<typeof spawn>
  #worker?: Worker
  #oddByte?: Buffer
  #active = false
  #restartTimer?: ReturnType<typeof setTimeout>
  #restartDelayMs = 1_000
  #workerBusy = false
  #pendingIq?: ArrayBuffer
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
    const worker = new Worker(path.join(__dirname, 'channelizer-worker.js'), {
      workerData: {
        centerHz: WIDEBAND_CENTER_HZ,
        iqSampleRate: WIDEBAND_SAMPLE_RATE,
        audioSampleRate: this.#config.sampleRate,
        voiceFrequencyHz: this.#channel.frequencyHz,
        dscFrequencyHz: DSC_CHANNEL_HZ,
        squelch: this.#config.squelch
      }
    })
    this.#worker = worker
    worker.on('message', (value: ChannelizerMessage) => {
      if (value.type === 'voice' && value.pcm) this.emit('audio', Buffer.from(value.pcm))
      else if (value.type === 'dsc' && value.pcm) this.emit('dscAudio', Buffer.from(value.pcm))
      else if (value.type === 'ready') this.#workerReady(worker)
      else if (value.type === 'state' && value.message) {
        this.#restartDelayMs = 1_000
        this.emit('state', value.message)
      }
      else if (value.type === 'error') this.emit('error', new Error(value.message ?? 'Channelizer failed'))
    })

    const child = spawn('rtl_sdr', rtlSdrArgs(this.#config), {
      stdio: ['ignore', 'pipe', 'pipe']
    })
    this.#process = child
    let finalized = false
    const failed = (error: Error): void => {
      if (finalized) return
      finalized = true
      this.#captureEnded(child, worker, error)
    }
    worker.on('error', failed)
    child.stdout.on('data', (chunk: Buffer) => {
      let iq = this.#oddByte ? Buffer.concat([this.#oddByte, chunk]) : chunk
      this.#oddByte = undefined
      if (iq.length % 2 !== 0) {
        this.#oddByte = iq.subarray(iq.length - 1)
        iq = iq.subarray(0, iq.length - 1)
      }
      if (iq.length === 0 || this.#worker !== worker) return
      const copy = Uint8Array.from(iq)
      if (this.#workerBusy) {
        if (this.#pendingIq) {
          this.#metrics.droppedIqChunks += 1
          this.#metrics.droppedIqBytes += this.#pendingIq.byteLength
          this.emit('metrics', { ...this.#metrics })
        }
        this.#pendingIq = copy.buffer
      } else {
        this.#postIq(worker, copy.buffer)
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
      this.#captureEnded(child, worker, expected
        ? undefined
        : new Error(`rtl_sdr exited with code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}`))
    })
  }

  #postIq(worker: Worker, iq: ArrayBuffer): void {
    if (this.#worker !== worker) return
    this.#workerBusy = true
    worker.postMessage({ type: 'iq', iq }, [iq])
  }

  #workerReady(worker: Worker): void {
    if (this.#worker !== worker) return
    const pending = this.#pendingIq
    this.#pendingIq = undefined
    if (pending) this.#postIq(worker, pending)
    else this.#workerBusy = false
  }

  #captureEnded(child: ReturnType<typeof spawn>, worker: Worker, error?: Error): void {
    if (this.#process === child) this.#process = undefined
    if (this.#worker === worker) {
      this.#worker = undefined
      void worker.terminate()
    }
    this.#workerBusy = false
    this.#pendingIq = undefined
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
    this.#worker?.postMessage({ type: 'tune', voiceFrequencyHz: channel.frequencyHz })
    this.emit('state', `Wideband capture · voice ${channel.label} + DSC 70`)
  }

  stop(): void {
    this.#active = false
    if (this.#restartTimer) clearTimeout(this.#restartTimer)
    this.#restartTimer = undefined
    const child = this.#process
    this.#process = undefined
    child?.kill('SIGTERM')
    const worker = this.#worker
    this.#worker = undefined
    void worker?.terminate()
    this.#oddByte = undefined
    this.#workerBusy = false
    this.#pendingIq = undefined
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
