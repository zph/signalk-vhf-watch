import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import path from 'node:path'
import type { PlaybackCleanup } from './playback-cleanup'

export const DEFAULT_RNNOISE_MODEL = path.join(__dirname, '..', 'models', 'rnnoise', 'speech-recording.rnnn')
export const RNNOISE_WET_MIX = 0.5
export type FfmpegPlaybackCleanup = Extract<PlaybackCleanup, 'comfort' | 'maximum' | 'rnnoise'>

export function isFfmpegPlaybackCleanup(cleanup: PlaybackCleanup): cleanup is FfmpegPlaybackCleanup {
  return cleanup === 'comfort' || cleanup === 'maximum' || cleanup === 'rnnoise'
}

export function rnnoiseFilterGraph(modelPath: string, sampleRate: number): string {
  const escapedModel = modelPath.replaceAll('\\', '\\\\').replaceAll(':', '\\:').replaceAll("'", "\\'")
  return [
    '[0:a]asplit=2[raw][denoise]',
    `[denoise]aresample=48000,arnndn=m='${escapedModel}',aresample=${sampleRate}[clean]`,
    `[raw][clean]amix=inputs=2:weights='${1 - RNNOISE_WET_MIX} ${RNNOISE_WET_MIX}':normalize=1[out]`
  ].join(';')
}

export function playbackFilterGraph(cleanup: FfmpegPlaybackCleanup, modelPath: string, sampleRate: number): string {
  if (cleanup === 'rnnoise') return rnnoiseFilterGraph(modelPath, sampleRate)
  if (cleanup === 'comfort') {
    return [
      '[0:a]asplit=2[raw][work]',
      '[work]afftdn=nr=10:nf=-28:tn=1:ad=0.8:gs=6[clean]',
      "[raw][clean]amix=inputs=2:weights='0.15 0.85':normalize=1[out]"
    ].join(';')
  }
  return [
    '[0:a]asplit=2[raw][work]',
    '[work]highpass=f=180:p=2,lowpass=f=3200:p=2,afftdn=nr=6:nf=-28:tn=1:ad=0.8:gs=4[clean]',
    "[raw][clean]amix=inputs=2:weights='0.25 0.75':normalize=1[out]"
  ].join(';')
}

export class RnnoiseDenoiser {
  readonly #command: string
  readonly #modelPath: string

  constructor(command = '/usr/bin/ffmpeg', modelPath = DEFAULT_RNNOISE_MODEL) {
    this.#command = command
    this.#modelPath = modelPath
  }

  available(cleanup: FfmpegPlaybackCleanup = 'rnnoise'): boolean {
    try {
      accessSync(this.#command, constants.X_OK)
      if (cleanup === 'rnnoise') accessSync(this.#modelPath, constants.R_OK)
      return true
    } catch {
      return false
    }
  }

  processPcm(pcm: Buffer, sampleRate: number, cleanup: FfmpegPlaybackCleanup = 'rnnoise'): Promise<Buffer> {
    if (!this.available(cleanup)) return Promise.reject(new Error(this.#unavailableMessage(cleanup)))
    const child = this.#spawn(sampleRate, cleanup)
    const output: Buffer[] = []
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => output.push(chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-8_192) })
    child.stdin.end(pcm)
    return new Promise((resolve, reject) => {
      child.on('error', reject)
      child.on('close', (code) => {
        if (code === 0) resolve(Buffer.concat(output))
        else reject(new Error(stderr.trim() || `${cleanup} FFmpeg exited ${code}`))
      })
    })
  }

  createPcmStream(sampleRate: number, cleanup: FfmpegPlaybackCleanup = 'rnnoise'): ChildProcessWithoutNullStreams {
    if (!this.available(cleanup)) throw new Error(this.#unavailableMessage(cleanup))
    return this.#spawn(sampleRate, cleanup)
  }

  #spawn(sampleRate: number, cleanup: FfmpegPlaybackCleanup): ChildProcessWithoutNullStreams {
    return spawn(this.#command, [
      '-nostdin', '-hide_banner', '-loglevel', 'error',
      '-f', 's16le', '-ac', '1', '-ar', String(sampleRate), '-i', 'pipe:0',
      '-filter_complex', playbackFilterGraph(cleanup, this.#modelPath, sampleRate),
      '-map', '[out]', '-f', 's16le', '-acodec', 'pcm_s16le', '-ac', '1', '-ar', String(sampleRate),
      '-flush_packets', '1', 'pipe:1'
    ], { stdio: ['pipe', 'pipe', 'pipe'] })
  }

  #unavailableMessage(cleanup: FfmpegPlaybackCleanup): string {
    return cleanup === 'rnnoise'
      ? 'RNNoise playback requires FFmpeg and the bundled speech model'
      : 'Adaptive playback cleanup requires FFmpeg'
  }
}
