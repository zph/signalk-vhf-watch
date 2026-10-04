import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { VhfRuntime } from './runtime'

const execFileAsync = promisify(execFile)
const AIS_UNIT = 'ais-catcher.service'
export type ReceiverOwner = 'ais' | 'vhf'
export type ObservedOwner = ReceiverOwner | 'none' | 'unknown'

export interface ReceiverOwnershipStatus {
  configured: boolean
  available: boolean
  owner: ObservedOwner
  desiredOwner: ReceiverOwner
  switching: boolean
  error?: string
}

export interface ReceiverService {
  isActive(): Promise<boolean>
  start(): Promise<void>
  stop(): Promise<void>
  availability?(): Promise<string | undefined>
}

export class ReceiverOwnershipError extends Error {
  constructor(message: string, readonly status = 503) { super(message) }
}

export class SystemdReceiverService implements ReceiverService {
  constructor(readonly platform = process.platform) {}

  async isActive(): Promise<boolean> {
    if (this.platform !== 'linux') throw new Error('Receiver ownership requires native Linux')
    try {
      const { stdout } = await execFileAsync('/usr/bin/systemctl', ['is-active', AIS_UNIT], { timeout: 5_000 })
      return stdout.trim() === 'active'
    } catch (error) {
      const result = error as { code?: number | string; stdout?: string }
      if (String(result.stdout ?? '').trim() === 'inactive' || result.code === 3) return false
      throw new Error(`Could not read ${AIS_UNIT} state: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async availability(): Promise<string | undefined> {
    if (this.platform !== 'linux') return 'Receiver ownership requires native Linux'
    try {
      const { stdout } = await execFileAsync('/usr/bin/systemctl', ['show', '-p', 'LoadState', '--value', AIS_UNIT], { timeout: 5_000 })
      if (stdout.trim() !== 'loaded') return `${AIS_UNIT} is not installed or could not be loaded`
    } catch (error) {
      return `Could not inspect ${AIS_UNIT}: ${message(error)}`
    }
    for (const action of ['start', 'stop'] as const) {
      try {
        await execFileAsync('/usr/bin/sudo', ['-n', '-l', '/usr/bin/systemctl', action, AIS_UNIT], { timeout: 5_000 })
      } catch {
        return `Receiver ownership needs the VHF Watch sudoers rule for systemctl ${action} ${AIS_UNIT}`
      }
    }
    return undefined
  }

  async start(): Promise<void> { await this.#change('start') }
  async stop(): Promise<void> { await this.#change('stop') }

  async #change(action: 'start' | 'stop'): Promise<void> {
    if (this.platform !== 'linux') throw new Error('Receiver ownership requires native Linux')
    try {
      await execFileAsync('/usr/bin/sudo', ['-n', '/usr/bin/systemctl', action, AIS_UNIT], { timeout: 10_000 })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`Could not ${action} ${AIS_UNIT}; install the VHF Watch receiver-ownership sudoers rule: ${detail}`)
    }
  }
}

interface OwnershipRuntime extends Pick<VhfRuntime, 'config' | 'status' | 'setCaptureEnabled'> {}

export class ReceiverOwnershipController {
  #owner: ObservedOwner = 'unknown'
  #desiredOwner: ReceiverOwner
  #switching = false
  #error?: string
  #unavailableError?: string
  #pending?: Promise<void>
  #settled?: () => void
  #closing = false
  #vhfCaptureEnabled = false

  constructor(
    private readonly getRuntime: () => OwnershipRuntime | undefined,
    initialOwner: ReceiverOwner,
    private readonly saveOwner: (owner: ReceiverOwner) => Promise<void>,
    private readonly service: ReceiverService = new SystemdReceiverService(),
    private readonly options: { platform?: string; readyTimeoutMs?: number; pollMs?: number } = {},
    private readonly log?: (level: 'debug' | 'error', message: string) => void
  ) {
    this.#desiredOwner = initialOwner
  }

  status(): ReceiverOwnershipStatus {
    const runtime = this.getRuntime()
    const configured = Boolean(runtime?.config.manageReceiverOwnership)
    const supported = runtime?.config.enabled === true && runtime.config.receiverMode === 'rtl_sdr' && (this.options.platform ?? process.platform) === 'linux'
    const available = Boolean(configured && supported && !this.#unavailableError)
    return {
      configured,
      available,
      owner: this.#owner,
      desiredOwner: this.#desiredOwner,
      switching: this.#switching,
      ...((this.#error ?? this.#unavailableError ?? (configured && !supported
        ? runtime?.config.enabled === false ? 'Enable the VHF Watch receiver to manage ownership' : 'Receiver ownership requires native Linux with RTL-SDR selected'
        : undefined))
        ? { error: this.#error ?? this.#unavailableError ?? (runtime?.config.enabled === false ? 'Enable the VHF Watch receiver to manage ownership' : 'Receiver ownership requires native Linux with RTL-SDR selected') } : {})
    }
  }

  async initialize(): Promise<void> {
    if (!this.status().available) {
      const error = this.status().error
      if (error) this.log?.('error', `Receiver ownership unavailable: ${error}`)
      return
    }
    this.#beginTransition()
    this.log?.('debug', `Reconciling receiver ownership to ${this.#desiredOwner}`)
    try {
      this.#unavailableError = await this.service.availability?.()
      if (this.#unavailableError) {
        this.log?.('error', `Receiver ownership unavailable: ${this.#unavailableError}`)
        return
      }
      const runtime = this.getRuntime()
      if (runtime) await runtime.setCaptureEnabled(false)
      const active = await this.service.isActive()
      this.#owner = active ? 'ais' : 'none'
      if (this.#desiredOwner === 'vhf') {
        await this.#toVhf()
        this.#owner = 'vhf'
      }
      else if (!active) {
        await this.service.start()
        if (!await this.service.isActive()) throw new Error(`${AIS_UNIT} did not become active`)
        this.#owner = 'ais'
      }
      this.log?.('debug', `Receiver ownership startup complete: ${this.#owner}`)
    } catch (error) {
      this.#error = message(error)
      this.#owner = await this.#readOwner()
      this.log?.('error', `Receiver ownership startup failed (${this.#owner}): ${this.#error}`)
    } finally {
      this.#endTransition()
    }
  }

  async switchTo(owner: ReceiverOwner, restoring = false): Promise<ReceiverOwnershipStatus> {
    if (this.#closing && !restoring) throw new ReceiverOwnershipError('VHF Watch is shutting down', 503)
    if (this.#unavailableError) throw new ReceiverOwnershipError(this.#unavailableError, 503)
    if (!this.status().available) throw new ReceiverOwnershipError('Receiver ownership is unavailable; use native Linux with RTL-SDR and enable ownership management', 503)
    if (this.#switching) throw new ReceiverOwnershipError('A receiver ownership change is already in progress', 409)
    if (!restoring && owner === this.#owner && !this.#error) return this.status()
    this.#beginTransition()
    this.#error = undefined
    const previousDesiredOwner = this.#desiredOwner
    this.#desiredOwner = owner
    const previousOwner = this.#owner
    this.log?.('debug', `Receiver ownership requested: ${previousOwner} -> ${owner}`)
    try {
      if (owner === 'vhf') await this.#toVhf()
      else await this.#toAis()
      this.#owner = owner
      if (!restoring) await this.saveOwner(owner)
      this.log?.('debug', `Receiver ownership handoff complete: ${owner}`)
    } catch (error) {
      this.#error = message(error)
      if (this.#owner === owner && previousOwner !== owner) {
        try {
          if (previousOwner === 'ais') await this.#toAis()
          else if (previousOwner === 'vhf') await this.#toVhf()
          this.#owner = previousOwner
          this.log?.('debug', `Receiver ownership rollback complete: ${previousOwner}`)
        } catch (rollbackError) {
          this.#error = `${this.#error}; restoring ${previousOwner} ownership failed: ${message(rollbackError)}`
          this.log?.('error', `Receiver ownership rollback failed: ${this.#error}`)
        }
      }
      this.#desiredOwner = previousDesiredOwner
      this.#owner = await this.#readOwner()
      this.log?.('error', `Receiver ownership handoff failed (${this.#owner}): ${this.#error}`)
      throw new ReceiverOwnershipError(this.#error, 503)
    } finally {
      this.#endTransition()
    }
    return this.status()
  }

  async shutdown(): Promise<void> {
    this.#closing = true
    if (this.#pending) await this.#pending
    if (!this.status().available || this.#owner === 'ais') return
    const desiredOwner = this.#desiredOwner
    await this.switchTo('ais', true)
    this.#desiredOwner = desiredOwner
  }

  async #toVhf(): Promise<void> {
    const runtime = this.getRuntime()
    if (!runtime) throw new Error('VHF Watch is not running')
    if (!runtime.config.enabled) throw new Error('Enable the VHF Watch receiver before assigning it ownership')
    try {
      await this.service.stop()
      if (await this.service.isActive()) throw new Error(`${AIS_UNIT} is still active; VHF capture was not started`)
      this.#owner = 'none'
      const audioBefore = runtime.status().lastAudioAt
      await runtime.setCaptureEnabled(true)
      this.#vhfCaptureEnabled = true
      const deadline = Date.now() + (this.options.readyTimeoutMs ?? 20_000)
      while (Date.now() < deadline) {
        const audioAt = runtime.status().lastAudioAt
        if (audioAt && audioAt !== audioBefore && Date.parse(audioAt) >= Date.now() - 5_000) {
          if (await this.service.isActive()) throw new Error(`${AIS_UNIT} became active while VHF capture was starting`)
          return
        }
        await new Promise((resolve) => setTimeout(resolve, this.options.pollMs ?? 250))
      }
      throw new Error('VHF receiver did not produce fresh audio within 20 seconds')
    } catch (error) {
      await runtime.setCaptureEnabled(false)
      this.#vhfCaptureEnabled = false
      try {
        await this.service.start()
        if (!await this.service.isActive()) throw new Error(`${AIS_UNIT} did not become active during rollback`)
        this.#owner = 'ais'
      } catch (rollbackError) {
        this.#owner = await this.#readOwner()
        throw new Error(`${message(error)}; AIS rollback failed: ${message(rollbackError)}`)
      }
      throw error
    }
  }

  async #toAis(): Promise<void> {
    const runtime = this.getRuntime()
    if (!runtime) throw new Error('VHF Watch is not running')
    await runtime.setCaptureEnabled(false)
    this.#vhfCaptureEnabled = false
    try {
      await this.service.start()
      if (!await this.service.isActive()) throw new Error(`${AIS_UNIT} did not become active`)
      this.#owner = 'ais'
    } catch (error) {
      if (await this.service.isActive()) throw new Error(`${message(error)}; ${AIS_UNIT} is active but its start result was uncertain`)
      try {
        await this.#toVhf()
        this.#owner = 'vhf'
        this.log?.('debug', 'AIS did not start; restored VHF ownership')
      } catch (rollbackError) {
        throw new Error(`${message(error)}; VHF rollback failed: ${message(rollbackError)}`)
      }
      throw error
    }
  }

  async #readOwner(): Promise<ObservedOwner> {
    try {
      const aisActive = await this.service.isActive()
      if (this.#vhfCaptureEnabled) {
        const runtimeStatus = this.getRuntime()?.status()
        const lastAudioAt = runtimeStatus?.lastAudioAt
        const freshCapture = Boolean(lastAudioAt && Date.now() - Date.parse(lastAudioAt) <= 5_000)
        if (!freshCapture || !runtimeStatus?.enabled || aisActive) return 'unknown'
        return 'vhf'
      }
      if (aisActive) return 'ais'
      return 'none'
    } catch { return 'unknown' }
  }

  #beginTransition(): void {
    this.#switching = true
    this.#pending = new Promise<void>((resolve) => { this.#settled = resolve })
  }

  #endTransition(): void {
    this.#switching = false
    this.#settled?.()
    this.#settled = undefined
    this.#pending = undefined
  }
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }
