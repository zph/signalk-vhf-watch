import assert from 'node:assert/strict'
import test from 'node:test'
import type { PluginRouter } from '@signalk/server-api'
import { ReceiverOwnershipController, type ReceiverService } from '../src/receiver-ownership'
import { registerRoutes } from '../src/api'

class FakeService implements ReceiverService {
  active = true
  actions: string[] = []
  stopGate?: Promise<void>
  failStart = false
  async isActive(): Promise<boolean> { this.actions.push('is-active'); return this.active }
  async stop(): Promise<void> { this.actions.push('stop-ais'); if (this.stopGate) await this.stopGate; this.active = false }
  async start(): Promise<void> { this.actions.push('start-ais'); if (this.failStart) throw new Error('start denied'); this.active = true }
}

function fixture(options: { freshAudio?: boolean; save?: () => Promise<void>; readyTimeoutMs?: number } = {}) {
  const events: string[] = []
  let lastAudioAt: string | undefined
  let captureEnabled = false
  let releaseReceiver!: () => void
  let releaseGate: Promise<void> | undefined
  const runtime = {
    config: { manageReceiverOwnership: true, receiverMode: 'rtl_sdr', enabled: true },
    status: () => ({ enabled: captureEnabled, lastAudioAt }),
    setCaptureEnabled: async (enabled: boolean) => {
      captureEnabled = enabled
      events.push(enabled ? 'start-vhf' : 'stop-vhf')
      if (!enabled) {
        if (releaseGate) await releaseGate
        events.push('vhf-released')
      }
      if (enabled && options.freshAudio !== false) lastAudioAt = new Date().toISOString()
    }
  }
  const service = new FakeService()
  const saved: string[] = []
  const controller = new ReceiverOwnershipController(
    () => runtime as any,
    'ais',
    async (owner) => { saved.push(owner); await options.save?.() },
    service,
    { platform: 'linux', pollMs: 1, readyTimeoutMs: options.readyTimeoutMs ?? 30 }
  )
  return {
    controller, runtime, service, events, saved,
    holdRelease() { releaseGate = new Promise<void>((resolve) => { releaseReceiver = resolve }) },
    release() { releaseReceiver(); releaseGate = undefined }
  }
}

test('AIS to VHF waits for AIS inactive and a fresh capture before persisting ownership', async () => {
  const f = fixture()
  await f.controller.initialize()
  f.events.length = 0
  f.service.actions.length = 0
  const status = await f.controller.switchTo('vhf')
  assert.deepEqual(f.events, ['start-vhf'])
  assert.deepEqual(f.service.actions, ['stop-ais', 'is-active', 'is-active'])
  assert.equal(status.owner, 'vhf')
  assert.deepEqual(f.saved, ['vhf'])
})

test('VHF to AIS awaits full VHF release before starting AIS', async () => {
  const f = fixture()
  await f.controller.initialize()
  await f.controller.switchTo('vhf')
  f.events.length = 0
  f.service.actions.length = 0
  f.holdRelease()
  const switching = f.controller.switchTo('ais')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(f.service.actions.length, 0)
  f.release()
  const status = await switching
  assert.deepEqual(f.events, ['stop-vhf', 'vhf-released'])
  assert.ok(f.service.actions.includes('start-ais'))
  assert.equal(status.owner, 'ais')
})

test('failed VHF capture pauses it and restores verified AIS ownership', async () => {
  const f = fixture({ freshAudio: false, readyTimeoutMs: 8 })
  await f.controller.initialize()
  f.events.length = 0
  await assert.rejects(f.controller.switchTo('vhf'), /fresh audio/)
  assert.deepEqual(f.events, ['start-vhf', 'stop-vhf', 'vhf-released'])
  assert.equal(f.service.active, true)
  assert.equal(f.controller.status().owner, 'ais')
  assert.deepEqual(f.saved, [])
})

test('concurrent ownership requests fail with 409 while a handoff is running', async () => {
  const f = fixture()
  await f.controller.initialize()
  let release!: () => void
  f.service.stopGate = new Promise<void>((resolve) => { release = resolve })
  const first = f.controller.switchTo('vhf')
  await new Promise((resolve) => setImmediate(resolve))
  await assert.rejects(f.controller.switchTo('ais'), (error: any) => error.status === 409)
  release()
  await first
})

test('save failure restores the prior physical owner', async () => {
  const f = fixture({ save: async () => { throw new Error('save failed') } })
  await f.controller.initialize()
  f.events.length = 0
  await assert.rejects(f.controller.switchTo('vhf'), /save failed/)
  assert.equal(f.controller.status().owner, 'ais')
  assert.equal(f.service.active, true)
  assert.deepEqual(f.events, ['start-vhf', 'stop-vhf', 'vhf-released'])
})

test('failed AIS start restores VHF only after confirming AIS remains inactive', async () => {
  const f = fixture()
  await f.controller.initialize()
  await f.controller.switchTo('vhf')
  await new Promise((resolve) => setTimeout(resolve, 5))
  f.events.length = 0
  f.service.actions.length = 0
  f.service.failStart = true
  await assert.rejects(f.controller.switchTo('ais'), /start denied/)
  assert.equal(f.controller.status().owner, 'vhf')
  assert.equal(f.service.active, false)
  assert.deepEqual(f.events, ['stop-vhf', 'vhf-released', 'start-vhf'])
  assert.equal(f.service.actions[0], 'start-ais')
  assert.equal(f.service.actions[1], 'is-active')
  assert.ok(f.service.actions.indexOf('is-active') < f.service.actions.indexOf('stop-ais'))
})

test('receiver ownership POST is registered only in the read/write router', () => {
  const scopes = new Map<string, string>()
  const router = {
    access: (scope: string) => ({
      get: (path: string) => scopes.set(`GET ${path}`, scope),
      post: (path: string) => scopes.set(`POST ${path}`, scope),
      put: (path: string) => scopes.set(`PUT ${path}`, scope),
      delete: (path: string) => scopes.set(`DELETE ${path}`, scope)
    })
  } as unknown as PluginRouter
  registerRoutes(router, () => undefined)
  assert.equal(scopes.get('POST /api/receiver-owner'), 'readwrite')
})
