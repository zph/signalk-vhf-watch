import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import type { VhfChannel } from './channels'
import type { VhfWatchConfig } from './config'

export interface ReceiverEvents {
  audio: [Buffer]
  error: [Error]
  state: [string]
}

export abstract class AudioReceiver extends EventEmitter<ReceiverEvents> {
  abstract start(): void
  abstract stop(): void
}

export function rtlFmArgs(config: VhfWatchConfig, channel: VhfChannel): string[] {
  return [
    '-d', String(config.deviceIndex),
    '-f', String(channel.frequencyHz),
    '-M', 'fm',
    '-s', '48000',
    '-r', String(config.sampleRate),
    '-l', String(config.squelch),
    '-E', 'deemp',
    ...(config.gainDb === undefined ? [] : ['-g', String(config.gainDb)]),
    '-'
  ]
}

export class RtlFmReceiver extends AudioReceiver {
  readonly #config: VhfWatchConfig
  readonly #channel: VhfChannel
  #process?: ReturnType<typeof spawn>

  constructor(config: VhfWatchConfig, channel: VhfChannel) {
    super()
    this.#config = config
    this.#channel = channel
  }

  start(): void {
    if (this.#process) return
    this.emit('state', 'Starting rtl_fm')
    const child = spawn('rtl_fm', rtlFmArgs(this.#config, this.#channel), {
      stdio: ['ignore', 'pipe', 'pipe']
    })
    this.#process = child
    child.stdout.on('data', (chunk: Buffer) => this.emit('audio', chunk))
    child.stderr.on('data', (chunk: Buffer) => {
      const message = chunk.toString('utf8').trim()
      if (message) this.emit('state', message.split('\n').at(-1) ?? message)
    })
    child.on('error', (error) => {
      this.#process = undefined
      this.emit('error', error)
    })
    child.on('exit', (code, signal) => {
      this.#process = undefined
      if (code !== 0 && signal !== 'SIGTERM') this.emit('error', new Error(`rtl_fm exited with code ${code ?? 'unknown'}`))
      else this.emit('state', 'Stopped')
    })
  }

  stop(): void {
    const child = this.#process
    this.#process = undefined
    child?.kill('SIGTERM')
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
