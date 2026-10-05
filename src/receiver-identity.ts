import { spawn } from 'node:child_process'
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { VhfRuntime } from './runtime'
import type { ReceiverOwnershipController } from './receiver-ownership'

const HELPER = '/usr/local/libexec/signalk-vhf-watch-receiver-identity'
const SUDO = '/usr/bin/sudo'
const SERIAL_RE = /^[A-Za-z][A-Za-z0-9_-]{2,15}$/
const PENDING_PHASES = new Set(['writing', 'pendingReconnect', 'configUpdated'])
const SAFE_RENAME_PHASES = new Set(['idle', 'complete', 'error'])

export type ReceiverIdentityPhase = 'idle' | 'writing' | 'pendingReconnect' | 'configUpdated' | 'complete' | 'error'

export interface ReceiverIdentityStatus {
  available: boolean
  deviceSerial?: string
  aisSerial?: string
  phase: ReceiverIdentityPhase
  newSerial?: string
  error?: string
  message?: string
  maxSerialLength: number | null
  canRename: boolean
  canRetry: boolean
  failClosed?: boolean
}

interface HelperReply {
  ok: boolean
  error?: string
  phase?: ReceiverIdentityPhase
  oldSerial?: string
  newSerial?: string
  aisSerial?: string
  aisError?: string
  failClosed?: boolean
  devices?: Array<{ index: number; manufacturer: string; product: string; serial: string; maxSerialLength?: number }>
}

interface IdentityRuntime extends Pick<VhfRuntime, 'config' | 'setReceiverDevice' | 'setCaptureEnabled'> {}

export class ReceiverIdentityError extends Error {
  constructor(message: string, readonly status = 503, readonly identity?: ReceiverIdentityStatus) { super(message) }
}

export class ReceiverIdentityController {
  #status: ReceiverIdentityStatus = { available: false, phase: 'idle', maxSerialLength: null, canRename: false, canRetry: false }
  #timer?: ReturnType<typeof setInterval>
  #working = false
  #workPromise?: Promise<void>
  #resolveWork?: () => void
  #markerError?: string
  #closing = false
  #initializePromise?: Promise<void>
  #writingRecoveryAttempted = false

  constructor(
    private readonly getRuntime: () => IdentityRuntime | undefined,
    private readonly ownership: ReceiverOwnershipController,
    private readonly saveDevice: (serial: string) => Promise<void>,
    private readonly markerPath: string,
    private readonly platform = process.platform,
    private readonly log?: (level: 'debug' | 'error', message: string) => void
  ) {}

  status(): ReceiverIdentityStatus { return { ...this.#status } }

  initializeGate(): Promise<void> {
    const pending = this.#initializeGate()
    this.#initializePromise = pending
    return pending.finally(() => { if (this.#initializePromise === pending) this.#initializePromise = undefined })
  }

  async #initializeGate(): Promise<void> {
    if (this.#closing) return
    if (this.platform !== 'linux') return
    let marker: { version: 1; oldSerial: string; newSerial: string } | undefined
    try {
      marker = this.#readMarker()
      if (marker) {
        this.ownership.setIdentityPending(true)
        await this.getRuntime()?.setCaptureEnabled(false)
      }
    } catch (error) {
      this.#markerError = message(error)
      this.ownership.setIdentityPending(true)
      this.#status = { ...this.#status, phase: 'error', failClosed: true, error: this.#markerError, message: 'Receiver identity recovery is locked by an unreadable pending marker', canRetry: false }
    }
    try {
      const reply = await this.#helper({ action: 'status' })
      if (this.#closing) return
      const activeJournal = PENDING_PHASES.has(reply.phase ?? '') || (reply.phase === 'error' && reply.failClosed)
      if (marker) {
        if (activeJournal) {
          if (this.#sameJournalJob(marker, reply)) this.ownership.setIdentityPending(true)
          else this.#lockMarkerMismatch('Pending app marker does not match the active root receiver journal')
        } else if (reply.phase === 'complete' && this.#sameJournalJob(marker, reply)) {
          if (await this.#markerMatchesNewState(marker, reply)) this.ownership.setIdentityPending(true)
          else this.#lockMarkerMismatch('Completed root journal does not match the new SDR, AIS, and VHF selections')
        } else if (reply.phase === 'idle' || reply.phase === 'complete' || (reply.phase === 'error' && !reply.failClosed)) {
          if (await this.#markerMatchesOldState(marker, reply)) {
            this.#clearMarker()
            this.ownership.setIdentityPending(false)
          } else {
            this.#lockMarkerMismatch('Pending app marker does not match the root receiver journal and current SDR selection')
          }
        } else {
          this.#lockMarkerMismatch('Pending app marker does not match the root receiver journal')
        }
      } else if (activeJournal) {
        this.ownership.setIdentityPending(true)
      }
      await this.refresh()
    } catch (error) {
      if (marker) this.ownership.setIdentityPending(true)
      this.#status = { ...this.#status, error: message(error), message: 'Receiver identity helper is unavailable' }
    }
  }

  startRecovery(): void {
    if (this.#timer || this.#closing) return
    if (this.ownership.identityPending) {
      this.#timer = setInterval(() => { void this.#retryIfReady() }, 2_000)
      this.#timer.unref?.()
      void this.#retryIfReady()
    }
  }

  async refresh(): Promise<ReceiverIdentityStatus> {
    const runtime = this.getRuntime()
    let journal: HelperReply
    let devices: HelperReply['devices'] = []
    let helperAvailable = true
    try {
      journal = await this.#helper({ action: 'status' })
      const inventory = await this.#helper({ action: 'inventory' })
      devices = inventory.devices ?? []
    } catch (error) {
      helperAvailable = false
      journal = { ok: false, phase: this.#status.phase, error: message(error), failClosed: this.ownership.identityPending }
    }
    const device = devices?.length === 1 ? devices[0] : undefined
    const config = runtime?.config
    const ownership = this.ownership.status()
    const phase = journal.phase ?? 'idle'
    const pending = PENDING_PHASES.has(phase) || (phase === 'error' && Boolean(journal.failClosed))
    const configured = Boolean(config?.manageReceiverOwnership && config.receiverMode === 'rtl_sdr' && config.enabled)
    let error = journal.error ?? journal.aisError
    let messageText: string | undefined
    if (!helperAvailable) messageText = 'Install the VHF Watch receiver identity helper to enable SDR naming'
    else if (!configured || !ownership.configured) messageText = 'Enable native RTL-SDR receiver ownership in VHF Watch settings'
    else if (!device) error = devices?.length ? `Expected one attached RTL-SDR Blog V4; found ${devices.length}` : 'No RTL-SDR Blog V4 is attached'
    else if (device.manufacturer !== 'RTLSDRBlog' || device.product !== 'Blog V4') error = 'The attached SDR is not an RTL-SDR Blog V4'
    else if (!journal.aisSerial) error = journal.aisError ?? 'Could not read the AIS-Catcher receiver selection'
    else if (device.serial !== journal.aisSerial && !pending && phase !== 'complete') error = 'AIS-Catcher and the attached SDR have different serials'
    if (phase === 'pendingReconnect') messageText = 'Unplug and reconnect the SDR to apply its new USB serial; VHF and AIS remain paused'
    else if (phase === 'configUpdated') messageText = 'SDR reconnected; finishing the AIS and VHF configuration sync'
    else if (phase === 'writing') messageText = 'Checking the EEPROM write state; keep the SDR connected'
    else if (phase === 'complete') messageText = 'SDR serial and AIS-Catcher configuration are synchronized'
    else if (phase === 'error' && journal.failClosed) messageText = 'SDR identity is uncertain; receiver ownership remains paused'
    else if (phase === 'error' && error) messageText = journal.error
    const supportedDevice = Boolean(device && device.manufacturer === 'RTLSDRBlog' && device.product === 'Blog V4')
    const vhfDeviceMatches = Boolean(device && (config?.device === device.serial || (config?.device === '0' && devices?.length === 1)))
    const available = Boolean(helperAvailable && configured && ownership.configured && supportedDevice && device && journal.aisSerial && (device.serial === journal.aisSerial || pending || phase === 'complete'))
    const maxSerialLength = device?.maxSerialLength === undefined ? null : Math.min(16, device.maxSerialLength)
    const canRename = Boolean(available && ownership.available && vhfDeviceMatches && !pending && SAFE_RENAME_PHASES.has(phase) && !journal.failClosed && !this.ownership.identityPending && device?.serial === journal.aisSerial)
    const canRetry = Boolean(helperAvailable && this.ownership.identityPending && (PENDING_PHASES.has(phase) || (phase === 'error' && journal.failClosed) || phase === 'complete'))
    this.#status = {
      available,
      ...(device ? { deviceSerial: device.serial } : {}),
      ...(journal.aisSerial ? { aisSerial: journal.aisSerial } : {}),
      phase,
      ...(journal.newSerial ? { newSerial: journal.newSerial } : {}),
      ...(error ? { error } : {}),
      ...(messageText ? { message: messageText } : {}),
      maxSerialLength,
      canRename,
      canRetry,
      ...(journal.failClosed ? { failClosed: true } : {})
    }
    if (this.#markerError) {
      this.#status = { ...this.#status, phase: 'error', error: this.#markerError, message: 'Receiver identity recovery is locked; ownership remains paused', failClosed: true, canRename: false, canRetry: false }
    }
    return this.status()
  }

  async rename(serial: unknown): Promise<ReceiverIdentityStatus> {
    if (this.#closing) throw new ReceiverIdentityError('VHF Watch is shutting down', 503, this.status())
    if (!this.#beginWork()) throw new ReceiverIdentityError('A receiver identity operation is already running', 409, this.status())
    try {
    const current = await this.refresh()
    if (typeof serial !== 'string' || !SERIAL_RE.test(serial)) {
      throw new ReceiverIdentityError('Serial must start with a letter and use 3–16 letters, digits, underscores, or hyphens', 400, current)
    }
    if (!current.canRename) throw new ReceiverIdentityError(current.error ?? current.message ?? 'Receiver identity changes are unavailable', 409, current)
    if (serial.length > (current.maxSerialLength ?? 0)) {
      throw new ReceiverIdentityError(`This V4 EEPROM supports at most ${current.maxSerialLength} characters`, 400, current)
    }
    if (serial === current.deviceSerial && serial === current.aisSerial && this.getRuntime()?.config.device === serial) return current
    if (serial === current.deviceSerial && serial === current.aisSerial) {
      throw new ReceiverIdentityError('The SDR already has this serial; choose a new name to synchronize VHF Watch', 409, current)
    }
    try {
      await this.ownership.pauseForIdentity(async () => {
        this.#writeMarker({ version: 1, oldSerial: current.deviceSerial!, newSerial: serial })
        await this.#helper({ action: 'begin', currentSerial: current.deviceSerial, serial })
      })
      await this.refresh()
      this.log?.('debug', `SDR identity change started for serial ${serial}`)
      this.startRecovery()
      return this.status()
    } catch (error) {
      const safe = await this.#canResumeAfterError()
      if (safe) {
        this.#clearMarker()
        await this.ownership.releaseIdentityGate(true)
      } else {
        this.ownership.setIdentityPending(true)
        this.startRecovery()
      }
      await this.refresh()
      this.log?.('error', `SDR identity change failed: ${message(error)}`)
      throw new ReceiverIdentityError(message(error), 503, this.status())
    }
    } finally { this.#endWork() }
  }

  async retry(): Promise<ReceiverIdentityStatus> {
    if (this.#closing) throw new ReceiverIdentityError('VHF Watch is shutting down', 503, this.status())
    if (!this.#beginWork()) throw new ReceiverIdentityError('A receiver identity operation is already running', 409, this.status())
    try {
      if (!this.ownership.initialized) throw new ReceiverIdentityError('Receiver ownership startup is still reconciling', 503, this.status())
      if (!this.ownership.identityPending) throw new ReceiverIdentityError('No receiver identity change is pending', 409, await this.refresh())
      return await this.#retryOnce(true)
    }
    finally { this.#endWork() }
  }

  async shutdown(): Promise<void> {
    this.#closing = true
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = undefined
    if (this.#initializePromise) await this.#initializePromise.catch(() => undefined)
    if (this.#workPromise) await this.#workPromise
  }

  async #retryIfReady(): Promise<void> {
    if (this.#closing || !this.#beginWork()) return
    try { await this.#retryOnce(false) } catch (error) { this.log?.('error', `SDR identity recovery: ${message(error)}`) }
    finally { this.#endWork() }
  }

  async #retryOnce(manual: boolean): Promise<ReceiverIdentityStatus> {
    try {
      if (this.#markerError) throw new ReceiverIdentityError(this.#markerError, 503, this.status())
      let journal = await this.#helper({ action: 'status' })
      if (journal.phase === 'error' && journal.failClosed && !manual) {
        await this.refresh()
        return this.status()
      }
      if (journal.phase === 'complete' && !this.ownership.identityPending) {
        await this.refresh()
        return this.status()
      }
      if (journal.phase === 'writing' && !manual && this.#writingRecoveryAttempted) {
        await this.refresh()
        return this.status()
      }
      if (journal.phase === 'writing' || (journal.phase === 'error' && journal.failClosed)) {
        if (journal.phase === 'writing' && !manual) this.#writingRecoveryAttempted = true
        journal = await this.#helper({ action: 'recover' })
      }
      if (journal.phase === 'error' && !journal.failClosed) {
        this.#clearMarker()
        await this.ownership.releaseIdentityGate(true)
        await this.refresh()
        return this.status()
      }
      if (journal.phase === 'complete') {
        if (journal.newSerial) {
          const inventory = await this.#helper({ action: 'inventory' })
          if (inventory.devices?.length !== 1 || inventory.devices[0]?.serial !== journal.newSerial) {
            await this.refresh()
            return this.status()
          }
          await this.ownership.recoverCompletedIdentity(journal.newSerial, this.saveDevice)
          this.#clearMarker()
        }
      } else if (journal.phase === 'pendingReconnect' || journal.phase === 'configUpdated') {
        const newSerial = journal.newSerial
        if (!newSerial) throw new Error('Pending receiver identity journal has no new serial')
        const inventory = await this.#helper({ action: 'inventory' })
        if (inventory.devices?.length !== 1 || inventory.devices[0]?.serial !== newSerial) {
          await this.refresh()
          return this.status()
        }
        await this.ownership.finalizeIdentity(
          async () => {
            const finalized = await this.#helper({ action: 'finalize' })
            if (finalized.phase !== 'configUpdated' || finalized.newSerial !== newSerial) {
              throw new Error(finalized.error ?? 'Receiver identity config did not finalize')
            }
            return newSerial
          },
          this.saveDevice,
          async () => { await this.#helper({ action: 'complete' }); this.#clearMarker() }
        )
        this.log?.('debug', `SDR identity synchronized to ${newSerial}`)
      }
      await this.refresh()
      return this.status()
    } catch (error) {
      await this.refresh().catch(() => undefined)
      throw new ReceiverIdentityError(message(error), 503, this.status())
    }
  }

  #beginWork(): boolean {
    if (this.#working) return false
    this.#working = true
    this.#workPromise = new Promise<void>((resolve) => { this.#resolveWork = resolve })
    return true
  }

  #endWork(): void {
    this.#working = false
    this.#resolveWork?.()
    this.#resolveWork = undefined
    this.#workPromise = undefined
  }

  #readMarker(): { version: 1; oldSerial: string; newSerial: string } | undefined {
    let parsed: unknown
    try { parsed = JSON.parse(readFileSync(this.markerPath, 'utf8')) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw new Error('Receiver identity pending marker is unreadable')
    }
    if (!parsed || typeof parsed !== 'object' || (parsed as any).version !== 1 ||
      typeof (parsed as any).oldSerial !== 'string' || typeof (parsed as any).newSerial !== 'string' ||
      !SERIAL_RE.test((parsed as any).newSerial)) throw new Error('Receiver identity pending marker is invalid')
    return parsed as { version: 1; oldSerial: string; newSerial: string }
  }

  #writeMarker(marker: { version: 1; oldSerial: string; newSerial: string }): void {
    const directory = path.dirname(this.markerPath)
    mkdirSync(directory, { recursive: true })
    const temporary = `${this.markerPath}.${process.pid}.new`
    const fd = openSync(temporary, 'w', 0o600)
    try { writeFileSync(fd, `${JSON.stringify(marker)}\n`); fsyncSync(fd) }
    finally { closeSync(fd) }
    renameSync(temporary, this.markerPath)
    const directoryFd = openSync(directory, 'r')
    try { fsyncSync(directoryFd) } finally { closeSync(directoryFd) }
  }

  #clearMarker(): void {
    try { unlinkSync(this.markerPath) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const directoryFd = openSync(path.dirname(this.markerPath), 'r')
    try { fsyncSync(directoryFd) } finally { closeSync(directoryFd) }
  }

  async #canResumeAfterError(): Promise<boolean> {
    try {
      const journal = await this.#helper({ action: 'status' })
      return !journal.phase || journal.phase === 'idle' || (journal.phase === 'complete') || (journal.phase === 'error' && !journal.failClosed)
    } catch { return false }
  }

  async #markerMatchesOldState(marker: { oldSerial: string }, journal: HelperReply): Promise<boolean> {
    try {
      const inventory = await this.#helper({ action: 'inventory' })
      const devices = inventory.devices ?? []
      const device = devices.length === 1 ? devices[0] : undefined
      const runtime = this.getRuntime()
      return Boolean(
        device?.manufacturer === 'RTLSDRBlog' && device.product === 'Blog V4' && device.serial === marker.oldSerial &&
        journal.aisSerial === marker.oldSerial &&
        (runtime?.config.device === marker.oldSerial || runtime?.config.device === '0')
      )
    } catch { return false }
  }

  async #markerMatchesNewState(marker: { newSerial: string }, journal: HelperReply): Promise<boolean> {
    try {
      const inventory = await this.#helper({ action: 'inventory' })
      const devices = inventory.devices ?? []
      const device = devices.length === 1 ? devices[0] : undefined
      return Boolean(
        device?.manufacturer === 'RTLSDRBlog' && device.product === 'Blog V4' && device.serial === marker.newSerial &&
        journal.aisSerial === marker.newSerial && this.getRuntime()?.config.device === marker.newSerial
      )
    } catch { return false }
  }

  #sameJournalJob(marker: { oldSerial: string; newSerial: string }, journal: HelperReply): boolean {
    return journal.oldSerial === marker.oldSerial && journal.newSerial === marker.newSerial
  }

  #lockMarkerMismatch(messageText: string): void {
    this.#markerError = messageText
    this.ownership.setIdentityPending(true)
  }

  #helper(request: Record<string, unknown>): Promise<HelperReply> {
    if (this.platform !== 'linux') return Promise.reject(new Error('Receiver identity requires native Linux'))
    return new Promise((resolve, reject) => {
      const child = spawn(SUDO, ['-n', HELPER], { env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C' }, stdio: ['pipe', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      let settled = false
      let killTimer: ReturnType<typeof setTimeout> | undefined
      let outputOverflow = false
      let stopReason: Error | undefined
      const finish = (error?: Error, reply?: HelperReply) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (killTimer) clearTimeout(killTimer)
        if (error) reject(error)
        else if (!reply) reject(new Error('Receiver identity helper returned no response'))
        else if (!reply.ok) reject(Object.assign(new Error(reply.error ?? 'Receiver identity helper failed'), { reply }))
        else resolve(reply)
      }
      const stopChild = (reason: Error) => {
        if (stopReason) return
        stopReason = reason
        child.kill('SIGTERM')
        killTimer = setTimeout(() => child.kill('SIGKILL'), 1_000)
      }
      const timer = setTimeout(() => stopChild(new Error('Receiver identity helper timed out')), 20_000)
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        if (outputOverflow) return
        const limit = 64 * 1024
        if (stdout.length + chunk.length > limit) {
          stdout += chunk.slice(0, limit + 1 - stdout.length)
          outputOverflow = true
          stopChild(new Error('Receiver identity helper response was too large'))
        } else stdout += chunk
      })
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(0, 2_000) })
      child.once('error', (error) => finish(error))
      child.once('close', (code) => {
        if (stopReason) return finish(stopReason)
        let reply: HelperReply | undefined
        try { reply = JSON.parse(stdout.trim()) as HelperReply } catch { /* handled below */ }
        if (code !== 0 && reply?.ok !== false) return finish(new Error(stderr.trim() || `Receiver identity helper exited ${code}`))
        finish(undefined, reply)
      })
      child.stdin.end(JSON.stringify(request))
    })
  }
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }
