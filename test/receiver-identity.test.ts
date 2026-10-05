import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import childProcess from 'node:child_process'
import { PassThrough } from 'node:stream'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mock } from 'node:test'
import test from 'node:test'
import { ReceiverIdentityController } from '../src/receiver-identity'
import { ReceiverOwnershipController, type ReceiverService } from '../src/receiver-ownership'

type HelperRequest = { action: string; currentSerial?: string; serial?: string }
type HelperDevice = { index: number; manufacturer: string; product: string; serial: string; maxSerialLength: number }
type HelperJournal = { phase: string; oldSerial?: string; newSerial?: string; aisSerial: string; error?: string; failClosed?: boolean }
type HelperReply = Record<string, unknown> & { ok?: boolean }

class FakeHelper {
  readonly requests: HelperRequest[] = []
  readonly spawnCalls: Array<{ command: string; args: string[]; options: unknown; body: string }> = []
  journal: HelperJournal
  devices: HelperDevice[]
  beginError?: string
  beginGate?: Promise<void>
  beginStarted?: () => void
  private readonly beginStartedPromise = new Promise<void>((resolve) => { this.beginStarted = resolve })
  spawnError?: string

  constructor(options: { phase?: string; oldSerial?: string; deviceSerial?: string; aisSerial?: string; newSerial?: string; failClosed?: boolean } = {}) {
    const deviceSerial = options.deviceSerial ?? 'OLD123'
    this.journal = {
      phase: options.phase ?? 'idle',
      oldSerial: options.oldSerial ?? 'OLD123',
      ...(options.newSerial ? { newSerial: options.newSerial } : {}),
      aisSerial: options.aisSerial ?? 'OLD123',
      ...(options.failClosed ? { failClosed: true } : {})
    }
    this.devices = [{ index: 0, manufacturer: 'RTLSDRBlog', product: 'Blog V4', serial: deviceSerial, maxSerialLength: 14 }]
  }

  waitForBegin(): Promise<void> { return this.beginStartedPromise }

  install(): () => void {
    const replacement = ((command: string, args: string[], options: unknown) => {
      const child = new EventEmitter() as EventEmitter & {
        stdin: PassThrough
        stdout: PassThrough
        stderr: PassThrough
        kill(signal?: string): boolean
      }
      child.stdin = new PassThrough()
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.kill = () => true
      let body = ''
      child.stdin.setEncoding('utf8').on('data', (chunk: string) => { body += chunk })
      child.stdin.once('finish', () => {
        const request = JSON.parse(body) as HelperRequest
        this.requests.push(request)
        this.spawnCalls.push({ command, args, options, body })
        if (this.spawnError) {
          setImmediate(() => child.emit('error', new Error(this.spawnError)))
          return
        }
        void this.respond(request).then((reply) => {
          child.stdout.end(`${JSON.stringify(reply)}\n`)
          child.stderr.end()
          child.stdout.once('end', () => child.emit('close', reply.ok === false ? 1 : 0, null))
        }, (error: unknown) => {
          child.stdout.end(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`)
          child.stderr.end()
          child.stdout.once('end', () => child.emit('close', 1, null))
        })
      })
      return child
    }) as unknown as typeof childProcess.spawn
    const patched = mock.method(childProcess, 'spawn', replacement)
    return () => patched.mock.restore()
  }

  async respond(request: HelperRequest): Promise<HelperReply> {
    switch (request.action) {
      case 'status':
        return { ok: true, ...this.journal }
      case 'inventory':
        return { ok: true, devices: this.devices.map((device) => ({ ...device })) }
      case 'begin':
        this.beginStarted?.()
        await this.beginGate
        if (this.beginError) return { ok: false, error: this.beginError }
        this.journal = { ...this.journal, phase: 'pendingReconnect', oldSerial: request.currentSerial, newSerial: request.serial }
        return { ok: true, phase: 'pendingReconnect', oldSerial: request.currentSerial, newSerial: request.serial }
      case 'recover':
        this.journal = { ...this.journal, phase: 'pendingReconnect', error: undefined }
        this.devices = this.devices.map((device) => ({ ...device, serial: this.journal.newSerial ?? device.serial }))
        return { ok: true, ...this.journal }
      case 'finalize':
        this.journal = { ...this.journal, phase: 'configUpdated', aisSerial: this.journal.newSerial ?? this.journal.aisSerial }
        return { ok: true, ...this.journal }
      case 'complete':
        this.journal = { ...this.journal, phase: 'complete' }
        return { ok: true, ...this.journal }
      default:
        return { ok: false, error: `Unexpected fake helper action: ${request.action}` }
    }
  }
}

class FakeService implements ReceiverService {
  active = true
  readonly actions: string[] = []
  async isActive(): Promise<boolean> { this.actions.push('is-active'); return this.active }
  async stop(): Promise<void> { this.actions.push('stop-ais'); this.active = false }
  async start(): Promise<void> { this.actions.push('start-ais'); this.active = true }
}

function fixture(options: {
  helper?: FakeHelper
  desiredOwner?: 'ais' | 'vhf'
  device?: string
  saveDevice?: (serial: string) => Promise<void>
} = {}) {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'vhf-identity-manager-test-'))
  const markerPath = path.join(dataDir, 'receiver-identity-pending.json')
  const fakeHelper = options.helper ?? new FakeHelper()
  const restoreSpawn = fakeHelper.install()
  let lastAudioAt: string | undefined
  const events: string[] = []
  const runtime = {
    config: { enabled: true, receiverMode: 'rtl_sdr', manageReceiverOwnership: true, device: options.device ?? 'OLD123' },
    status: () => ({ lastAudioAt }),
    setCaptureEnabled: async (enabled: boolean) => {
      events.push(enabled ? 'start-vhf' : 'stop-vhf')
      if (enabled) lastAudioAt = new Date().toISOString()
    },
    setReceiverDevice: (serial: string) => { runtime.config.device = serial; events.push(`device:${serial}`) }
  }
  const service = new FakeService()
  const savedOwners: string[] = []
  const ownership = new ReceiverOwnershipController(
    () => runtime as any,
    options.desiredOwner ?? 'ais',
    async (owner) => { savedOwners.push(owner) },
    service,
    { platform: 'linux', readyTimeoutMs: 30, pollMs: 1 }
  )
  const savedDevices: string[] = []
  const identity = new ReceiverIdentityController(
    () => runtime as any,
    ownership,
    async (serial) => {
      if (options.saveDevice) await options.saveDevice(serial)
      savedDevices.push(serial)
      runtime.config.device = serial
    },
    markerPath,
    'linux'
  )
  return {
    dataDir, markerPath, helper: fakeHelper, runtime, service, ownership, identity, events, savedOwners, savedDevices,
    async initialize() { await identity.initializeGate(); await ownership.initialize() },
    async cleanup() {
      await identity.shutdown()
      await ownership.shutdown()
      restoreSpawn()
      rmSync(dataDir, { recursive: true, force: true })
    }
  }
}

function writeMarker(markerPath: string, oldSerial = 'OLD123', newSerial = 'BOATSDR01'): void {
  writeFileSync(markerPath, `${JSON.stringify({ version: 1, oldSerial, newSerial })}\n`)
}

test('valid rename writes the durable app marker before helper begin and leaves receivers paused', async (t) => {
  const f = fixture()
  t.after(f.cleanup)
  await f.initialize()
  const status = await f.identity.rename('BOATSDR01')
  assert.equal(status.phase, 'pendingReconnect')
  assert.equal(status.newSerial, 'BOATSDR01')
  assert.equal(f.ownership.identityPending, true)
  assert.equal(f.ownership.status().owner, 'none')
  assert.equal(f.runtime.config.device, 'OLD123')
  assert.equal(f.service.active, false)
  assert.deepEqual(JSON.parse(readFileSync(f.markerPath, 'utf8')), { version: 1, oldSerial: 'OLD123', newSerial: 'BOATSDR01' })
  const beginCall = f.helper.requests.findIndex((request) => request.action === 'begin')
  assert.ok(beginCall >= 0)
  assert.deepEqual(f.helper.requests[beginCall], { action: 'begin', currentSerial: 'OLD123', serial: 'BOATSDR01' })
})

test('concurrent rename returns 409 without releasing the first operation gate', async (t) => {
  const f = fixture()
  t.after(f.cleanup)
  await f.initialize()
  let release!: () => void
  f.helper.beginGate = new Promise<void>((resolve) => { release = resolve })
  const first = f.identity.rename('BOATSDR01')
  await f.helper.waitForBegin()
  await assert.rejects(f.identity.rename('BOATSDR02'), (error: any) => error.status === 409)
  assert.equal(f.ownership.identityPending, true)
  assert.equal(f.service.active, false)
  assert.equal(JSON.parse(readFileSync(f.markerPath, 'utf8')).newSerial, 'BOATSDR01')
  release()
  await first
  assert.equal(f.ownership.identityPending, true)
  assert.equal(f.service.active, false)
})

test('pending marker and missing helper keep both receiver paths gated at startup', async (t) => {
  const helper = new FakeHelper()
  helper.spawnError = 'spawn sudo ENOENT'
  const f = fixture({ helper })
  t.after(f.cleanup)
  writeMarker(f.markerPath)
  await f.initialize()
  assert.equal(f.ownership.identityPending, true)
  assert.equal(f.ownership.status().available, false)
  assert.equal(f.ownership.status().owner, 'none')
  assert.equal(f.service.active, false)
  assert.deepEqual(f.events.filter((event) => event === 'start-vhf'), [])
  assert.equal(f.identity.status().message, 'Receiver identity helper is unavailable')
})

test('root writing recovery finalizes after the new USB serial appears and restores prior VHF owner', async (t) => {
  const helper = new FakeHelper({ phase: 'writing', newSerial: 'BOATSDR01' })
  const f = fixture({ helper, desiredOwner: 'vhf' })
  t.after(f.cleanup)
  writeMarker(f.markerPath)
  await f.initialize()
  assert.equal(f.ownership.identityPending, true)
  assert.equal(f.service.active, false)
  await f.identity.retry()
  assert.deepEqual(f.savedDevices, ['BOATSDR01'])
  assert.equal(f.runtime.config.device, 'BOATSDR01')
  assert.equal(f.ownership.identityPending, false)
  assert.equal(f.ownership.status().desiredOwner, 'vhf')
  assert.equal(f.ownership.status().owner, 'vhf')
  assert.equal(f.service.active, false)
  assert.ok(f.events.includes('device:BOATSDR01'))
  assert.equal(f.events.at(-1), 'start-vhf')
  assert.equal(f.helper.journal.phase, 'complete')
  assert.equal(exists(f.markerPath), false)
})

test('failed device save retains the gate and never starts another capture', async (t) => {
  const helper = new FakeHelper({ phase: 'pendingReconnect', newSerial: 'BOATSDR01', deviceSerial: 'BOATSDR01' })
  const f = fixture({ helper, desiredOwner: 'vhf', saveDevice: async () => { throw new Error('settings save failed') } })
  t.after(f.cleanup)
  writeMarker(f.markerPath)
  await f.initialize()
  await assert.rejects(f.identity.retry(), /settings save failed/)
  assert.equal(f.ownership.identityPending, true)
  assert.equal(f.service.active, false)
  assert.equal(f.events.includes('start-vhf'), false)
  assert.equal(exists(f.markerPath), true)
})

test('durable helper completion recovers the app marker and ownership gate after a timeout', async (t) => {
  const helper = new FakeHelper({ phase: 'complete', newSerial: 'BOATSDR01', deviceSerial: 'BOATSDR01', aisSerial: 'BOATSDR01' })
  const f = fixture({ helper, desiredOwner: 'vhf', device: 'BOATSDR01' })
  t.after(f.cleanup)
  writeMarker(f.markerPath)
  await f.initialize()
  assert.equal(f.ownership.identityPending, true)
  await f.identity.retry()
  assert.equal(f.ownership.identityPending, false)
  assert.equal(f.runtime.config.device, 'BOATSDR01')
  assert.equal(f.ownership.status().owner, 'vhf')
  assert.equal(f.service.active, false)
  assert.equal(exists(f.markerPath), false)
})

test('matching completed root job clears the app marker and restores the new configured receiver', async (t) => {
  const helper = new FakeHelper({
    phase: 'complete', oldSerial: 'old00000001', newSerial: 'BOATSDR01',
    deviceSerial: 'BOATSDR01', aisSerial: 'BOATSDR01'
  })
  const f = fixture({ helper, desiredOwner: 'vhf', device: 'BOATSDR01' })
  t.after(f.cleanup)
  writeMarker(f.markerPath, 'old00000001', 'BOATSDR01')
  await f.initialize()
  assert.equal(f.ownership.identityPending, true, 'startup keeps capture paused until durable completion is reconciled')
  await f.identity.retry()
  assert.equal(f.ownership.identityPending, false)
  assert.equal(f.runtime.config.device, 'BOATSDR01')
  assert.equal(f.ownership.status().owner, 'vhf')
  assert.equal(f.service.active, false)
  assert.equal(exists(f.markerPath), false)
  assert.equal(f.identity.status().phase, 'complete')
  assert.equal(f.identity.status().error, undefined, 'a matching completed marker must not leave a permanent marker error')
  assert.equal(f.identity.status().failClosed, undefined)
})

test('mismatched active root job stays fail-closed and startup recovery does not touch it', async (t) => {
  const helper = new FakeHelper({
    phase: 'pendingReconnect', oldSerial: 'ROOTOLD01', newSerial: 'ROOTNEW01',
    deviceSerial: 'ROOTNEW01', aisSerial: 'ROOTOLD01'
  })
  const f = fixture({ helper, desiredOwner: 'vhf' })
  t.after(f.cleanup)
  writeMarker(f.markerPath, 'APPOLD001', 'APPNEW001')
  await f.initialize()
  f.identity.startRecovery()
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(f.ownership.identityPending, true)
  assert.equal(f.service.active, false)
  assert.equal(f.events.includes('start-vhf'), false)
  assert.equal(exists(f.markerPath), true)
  assert.equal(f.helper.requests.some((request) => ['recover', 'finalize', 'complete'].includes(request.action)), false)
  assert.equal(f.identity.status().phase, 'error')
  assert.equal(f.identity.status().failClosed, true)
})

test('pre-begin marker is safely discarded for idle and previous-complete journals', async (t) => {
  for (const phase of ['idle', 'complete']) {
    await t.test(`root journal ${phase}`, async (subtest) => {
      const helper = new FakeHelper({ phase, newSerial: phase === 'complete' ? 'OLD123' : undefined })
      helper.beginError = 'helper failed before changing EEPROM'
      const f = fixture({ helper })
      subtest.after(f.cleanup)
      await f.initialize()
      const previous = await f.identity.rename('BOATSDR01').catch((error) => error)
      assert.equal(previous.status, 503)
      assert.equal(f.ownership.identityPending, false)
      assert.equal(f.ownership.status().owner, 'ais')
      assert.equal(f.service.active, true)
      assert.equal(exists(f.markerPath), false)
      assert.equal(f.runtime.config.device, 'OLD123')
    })
  }
})

test('helper invocations use the fixed sudo executable, helper path, no arguments, and strict JSON stdin', async (t) => {
  const f = fixture()
  t.after(f.cleanup)
  await f.identity.refresh()
  assert.deepEqual(f.helper.spawnCalls.map(({ command, args, body }) => ({ command, args, body })), [
    { command: '/usr/bin/sudo', args: ['-n', '/usr/local/libexec/signalk-vhf-watch-receiver-identity'], body: '{"action":"status"}' },
    { command: '/usr/bin/sudo', args: ['-n', '/usr/local/libexec/signalk-vhf-watch-receiver-identity'], body: '{"action":"inventory"}' }
  ])
  assert.deepEqual(f.helper.spawnCalls[0]?.options && (f.helper.spawnCalls[0].options as any).stdio, ['pipe', 'pipe', 'pipe'])
})

function exists(filePath: string): boolean {
  try { readFileSync(filePath); return true } catch { return false }
}
