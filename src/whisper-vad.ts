import { spawn, type ChildProcess } from 'node:child_process'
import { accessSync, constants, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pcmToWav } from './wav'

export const DEFAULT_VAD_COMMAND = '/usr/bin/vhf-vad'
export const DEFAULT_VAD_MODEL = '/usr/share/vhf-whisper/vad/ggml-silero-v6.2.0.bin'
export const VAD_TIMEOUT_MS = 10_000

export type VadOutcome = 'speech' | 'no-speech' | 'unavailable' | 'error' | 'aborted'

export interface VadResult {
  outcome: VadOutcome
  segmentCount?: number
}

export interface VadOptions {
  command?: string
  model?: string
  timeoutMs?: number
  onChild?: (child: ChildProcess | undefined) => void
}

/** Parse the standalone whisper.cpp VAD summary and reject partial or ambiguous output. */
export function parseVadSegments(output: string): number | undefined {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const summary = /^Detected (\d+) speech segments:$/.exec(lines[0] ?? '')
  if (!summary) return undefined
  const count = Number(summary[1])
  if (!Number.isSafeInteger(count) || count < 0 || count > 10_000) return undefined
  if (lines.length !== count + 1) return undefined
  for (let index = 0; index < count; index += 1) {
    const segment = /^Speech segment (\d+): start = (\d+(?:\.\d+)?), end = (\d+(?:\.\d+)?)$/.exec(lines[index + 1]!)
    if (!segment) return undefined
    const id = Number(segment[1])
    const start = Number(segment[2])
    const end = Number(segment[3])
    if (id !== index || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) return undefined
  }
  return count
}

/** A fail-open precheck. Only a strict successful zero-segment result can skip ASR. */
export class WhisperVadProbe {
  readonly #command: string
  readonly #model: string
  readonly #timeoutMs: number

  constructor(options: VadOptions = {}) {
    this.#command = options.command ?? DEFAULT_VAD_COMMAND
    this.#model = options.model ?? DEFAULT_VAD_MODEL
    this.#timeoutMs = options.timeoutMs ?? VAD_TIMEOUT_MS
    this.onChild = options.onChild
  }

  private readonly onChild?: (child: ChildProcess | undefined) => void

  available(sampleRate: number): boolean {
    if (sampleRate !== 16_000) return false
    try {
      accessSync(this.#command, constants.X_OK)
      accessSync(this.#model, constants.R_OK)
      return true
    } catch {
      return false
    }
  }

  async detect(
    pcm: Buffer,
    sampleRate: number,
    signal?: AbortSignal,
    onChild: (child: ChildProcess | undefined) => void = this.onChild ?? (() => {})
  ): Promise<VadResult> {
    if (signal?.aborted) return { outcome: 'aborted' }
    if (!this.available(sampleRate)) return { outcome: 'unavailable' }
    if (pcm.length === 0) return { outcome: 'no-speech', segmentCount: 0 }
    if (pcm.length < 2 || pcm.length % 2 !== 0) return { outcome: 'unavailable' }

    let directory: string | undefined
    let child: ChildProcess | undefined
    try {
      directory = mkdtempSync(path.join(os.tmpdir(), 'vhf-vad-'))
      const wavPath = path.join(directory, 'precheck.wav')
      writeFileSync(wavPath, pcmToWav(pcm, sampleRate), { mode: 0o600 })
      if (signal?.aborted) return { outcome: 'aborted' }

      const result = await new Promise<VadResult>((resolve) => {
        let stdout = ''
        let failed = false
        let timedOut = false
        let settled = false
        let timeout: ReturnType<typeof setTimeout> | undefined
        let abortKill: ReturnType<typeof setTimeout> | undefined
        const finish = (value: VadResult): void => {
          if (settled) return
          settled = true
          if (timeout) clearTimeout(timeout)
          if (abortKill) clearTimeout(abortKill)
          signal?.removeEventListener('abort', abort)
          resolve(value)
        }
        const abort = (): void => {
          child?.kill('SIGTERM')
          abortKill = setTimeout(() => child?.kill('SIGKILL'), 1_000)
        }
        try {
          child = spawn(this.#command, [wavPath], { stdio: ['ignore', 'pipe', 'ignore'] })
          onChild(child)
        } catch {
          finish({ outcome: 'error' })
          return
        }
        timeout = setTimeout(() => {
          timedOut = true
          child?.kill('SIGKILL')
        }, this.#timeoutMs)
        child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
          stdout = (stdout + chunk).slice(-65_536)
        })
        child.on('error', () => { failed = true })
        child.on('close', (code) => {
          if (signal?.aborted) { finish({ outcome: 'aborted' }); return }
          if (failed || timedOut || code !== 0) { finish({ outcome: 'error' }); return }
          const segmentCount = parseVadSegments(stdout)
          if (segmentCount === undefined) { finish({ outcome: 'error' }); return }
          finish({ outcome: segmentCount === 0 ? 'no-speech' : 'speech', segmentCount })
        })
        signal?.addEventListener('abort', abort, { once: true })
        if (signal?.aborted) abort()
      })
      return result
    } catch {
      return signal?.aborted ? { outcome: 'aborted' } : { outcome: 'error' }
    } finally {
      onChild(undefined)
      if (directory) rmSync(directory, { recursive: true, force: true })
    }
  }
}
