import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import path from 'node:path'

export const DEFAULT_RNNOISE_MODEL = path.join(__dirname, '..', 'models', 'rnnoise', 'speech-recording.rnnn')
export const RNNOISE_WET_MIX = 0.5

export function rnnoiseFilterGraph(modelPath: string, sampleRate: number): string {
  const escapedModel = modelPath.replaceAll('\\', '\\\\').replaceAll(':', '\\:').replaceAll("'", "\\'")
  return [
    '[0:a]asplit=2[raw][denoise]',
    `[denoise]aresample=48000,arnndn=m='${escapedModel}',aresample=${sampleRate}[clean]`,
    `[raw][clean]amix=inputs=2:weights='${1 - RNNOISE_WET_MIX} ${RNNOISE_WET_MIX}':normalize=1[out]`
  ].join(';')
}

export class RnnoiseDenoiser {
  readonly #command: string
  readonly #modelPath: string

  constructor(command = '/usr/bin/ffmpeg', modelPath = DEFAULT_RNNOISE_MODEL) {
    this.#command = command
    this.#modelPath = modelPath
  }

  available(): boolean {
    try {
      accessSync(this.#command, constants.X_OK)
      accessSync(this.#modelPath, constants.R_OK)
      return true
    } catch {
      return false
    }
  }

  processPcm(pcm: Buffer, sampleRate: number): Promise<Buffer> {
    if (!this.available()) return Promise.reject(new Error('RNNoise playback requires FFmpeg and the bundled speech model'))
    const child = this.#spawn(sampleRate)
    const output: Buffer[] = []
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => output.push(chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-8_192) })
    child.stdin.end(pcm)
    return new Promise((resolve, reject) => {
      child.on('error', reject)
      child.on('close', (code) => {
        if (code === 0) resolve(Buffer.concat(output))
        else reject(new Error(stderr.trim() || `RNNoise FFmpeg exited ${code}`))
      })
    })
  }

  createPcmStream(sampleRate: number): ChildProcessWithoutNullStreams {
    if (!this.available()) throw new Error('RNNoise playback requires FFmpeg and the bundled speech model')
    return this.#spawn(sampleRate)
  }

  #spawn(sampleRate: number): ChildProcessWithoutNullStreams {
    return spawn(this.#command, [
      '-nostdin', '-hide_banner', '-loglevel', 'error',
      '-f', 's16le', '-ac', '1', '-ar', String(sampleRate), '-i', 'pipe:0',
      '-filter_complex', rnnoiseFilterGraph(this.#modelPath, sampleRate),
      '-map', '[out]', '-f', 's16le', '-acodec', 'pcm_s16le', '-ac', '1', '-ar', String(sampleRate),
      '-flush_packets', '1', 'pipe:1'
    ], { stdio: ['pipe', 'pipe', 'pipe'] })
  }
}
