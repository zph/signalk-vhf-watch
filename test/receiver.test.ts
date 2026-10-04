import assert from 'node:assert/strict'
import { once } from 'node:events'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { channelById } from '../src/channels'
import { normalizeConfig } from '../src/config'
import { canChannelize, NativeSidecarReceiver, nativeSidecarArgs, parseSidecarFrames, parseSpannedBackfillFrame, rtlSdrArgs } from '../src/receiver'
import { discriminatorThreshold } from '../src/squelch'

test('builds one receive-only wideband capture for voice and DSC', () => {
  const config = normalizeConfig({ receiverMode: 'rtl_sdr', device: 'vhf-radio', ppm: -3, squelch: 25, gainDb: 20 })
  const args = rtlSdrArgs(config)
  assert.deepEqual(args, [
    '-d', 'vhf-radio', '-f', '156750000', '-s', '2400000', '-p', '-3', '-g', '20', '-'
  ])
  assert.equal(args.some((arg) => /tx|transmit|ptt/i.test(arg)), false)
  assert.equal(canChannelize(channelById('16')!.frequencyHz), true)
  assert.equal(canChannelize(channelById('WX2')!.frequencyHz), false)
})

test('builds native sidecar arguments without any transmit controls', () => {
  const config = normalizeConfig({ receiverMode: 'rtl_sdr', device: '00000001', ppm: 2, squelch: 15 })
  const args = nativeSidecarArgs(config, channelById('16')!)
  assert.deepEqual(args.slice(0, 20), [
    '--mode', 'stream', '--device', '00000001', '--sample-rate', '2400000',
    '--center', '156750000', '--voice', '156800000', '--dsc', '156525000',
    '--slot-b', '156525000',
    '--audio-rate', '16000', '--ppm', '2', '--squelch', '15'
  ])
  assert.equal(args[20], '--scan-frequencies')
  assert.match(args[21]!, /156800000/)
  assert.equal(args.some((arg) => /tx|transmit|ptt/i.test(arg)), false)

  const weatherArgs = nativeSidecarArgs(config, channelById('WX4')!, '70', true)
  assert.deepEqual(weatherArgs, [
    '--mode', 'stream', '--device', '00000001', '--sample-rate', '2400000',
    '--center', '162425000', '--voice', '162425000', '--dsc', '162425000',
    '--slot-b', '162425000',
    '--audio-rate', '16000', '--ppm', '2', '--squelch', '15'
  ])
  assert.equal(weatherArgs.some((arg) => /tx|transmit|ptt/i.test(arg)), false)
  assert.equal(weatherArgs.includes('--scan-frequencies'), false)
})

test('parses complete sidecar frames and retains a partial frame', () => {
  const voice = Buffer.from([1, 2, 3, 4])
  const first = Buffer.alloc(5 + voice.length)
  first[0] = 1
  first.writeUInt32LE(voice.length, 1)
  voice.copy(first, 5)
  const partial = Buffer.from([2, 4, 0, 0, 0, 9])
  const parsed = parseSidecarFrames(Buffer.concat([first, partial]))
  assert.deepEqual(parsed.frames, [{ kind: 1, payload: voice }])
  assert.deepEqual(parsed.remaining, partial)
})

test('validates quality-spanned backfill metadata and exact PCM coverage', () => {
  const payload = Buffer.alloc(20 + 2 * 12 + 8)
  payload.writeBigInt64LE(1_234n, 0)
  payload.writeBigInt64LE(156_800_000n, 8)
  payload.writeUInt32LE(2, 16)
  payload.writeUInt32LE(4, 20)
  payload.writeDoubleLE(0.1, 24)
  payload.writeUInt32LE(4, 32)
  payload.writeDoubleLE(0.5, 36)
  payload.fill(0x12, 44)
  const parsed = parseSpannedBackfillFrame(payload)
  assert.equal(parsed.capturedAt, 1_234)
  assert.equal(parsed.frequencyHz, 156_800_000)
  assert.equal(parsed.discriminatorNoise, 0.3)
  assert.deepEqual(parsed.qualitySpans, [
    { bytes: 4, discriminatorNoise: 0.1 },
    { bytes: 4, discriminatorNoise: 0.5 }
  ])
  assert.deepEqual(parsed.pcm, Buffer.alloc(8, 0x12))

  const mismatched = Buffer.from(payload)
  mismatched.writeUInt32LE(6, 20)
  assert.throws(() => parseSpannedBackfillFrame(mismatched), /Invalid quality span/)
  const nonFinite = Buffer.from(payload)
  nonFinite.writeDoubleLE(Number.NaN, 24)
  assert.throws(() => parseSpannedBackfillFrame(nonFinite), /Invalid quality span/)
})

test('maps higher squelch settings to stricter discriminator-noise thresholds', () => {
  assert.equal(discriminatorThreshold(0), Number.POSITIVE_INFINITY)
  assert.equal(discriminatorThreshold(20), 0.22)
  assert.ok(discriminatorThreshold(30) < discriminatorThreshold(20))
})

function fakeSidecar(directory: string, body: string): string {
  const executable = path.join(directory, 'fake-vhf-sidecar')
  writeFileSync(executable, `#!/bin/sh\n${body}\n`)
  chmodSync(executable, 0o755)
  return executable
}

function receiverFor(sidecarPath: string, options: { noOutputTimeoutMs?: number; healthyResetMs?: number; retryDelayMs?: number } = {}): NativeSidecarReceiver {
  const config = normalizeConfig({ receiverMode: 'rtl_sdr', device: '00000001', sidecarPath })
  return new NativeSidecarReceiver(config, channelById('WX4')!, '70', true, options)
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Condition not met within ${timeoutMs}ms`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test('retains a split USB claim failure and reports actionable SDR contention on exit', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'vhf-sidecar-stderr-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const executable = fakeSidecar(directory, [
    "printf '%s\\n' 'Found1 BlogV4 serial00000001' 'usb_claim_interface error -6' >&2",
    'sleep 0.05',
    "printf '%s\\n' 'Failed to open rtlsdr device #0.' >&2",
    'sleep 0.05',
    "printf '%s\\n' 'rtl_sdr stopped: exit status 1' >&2",
    'exit 1'
  ].join('\n'))
  const receiver = receiverFor(executable, { noOutputTimeoutMs: 1_000 })
  t.after(() => receiver.stop())
  const failed = once(receiver, 'error') as Promise<[Error]>
  receiver.start()
  const [error] = await failed
  assert.match(error.message, /attempt 1 failed on WX4 \(162425000 Hz, RTL device 00000001\)/)
  assert.match(error.message, /usb_claim_interface error -6/)
  assert.match(error.message, /SDR may be in use by AIS-Catcher/)
  assert.doesNotMatch(error.message, /rtl_sdr stopped: exit status 1/)
})

test('retries after a sidecar startup with no complete output frame', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'vhf-sidecar-watchdog-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const attemptsFile = path.join(directory, 'attempts')
  const executable = fakeSidecar(directory, [
    `count=0; [ -f '${attemptsFile}' ] && count=$(cat '${attemptsFile}')`,
    'count=$((count + 1))',
    `printf '%s' "$count" > '${attemptsFile}'`,
    'sleep 30'
  ].join('\n'))
  const receiver = receiverFor(executable, { noOutputTimeoutMs: 40, retryDelayMs: 20 })
  t.after(() => receiver.stop())
  receiver.on('error', () => undefined)
  const failed = once(receiver, 'error') as Promise<[Error]>
  receiver.start()
  const [error] = await failed
  assert.match(error.message, /produced no complete output frame for 0\.04s/)
  const secondAttempt = new Promise<void>((resolve) => {
    const onState = (state: string): void => {
      if (state.includes('(attempt 2)')) {
        receiver.off('state', onState)
        resolve()
      }
    }
    receiver.on('state', onState)
  })
  await secondAttempt
  receiver.stop()
})

test('resets retry backoff only after sustained valid sidecar frames', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'vhf-sidecar-recovery-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const attemptsFile = path.join(directory, 'attempts')
  const executable = fakeSidecar(directory, [
    `count=0; [ -f '${attemptsFile}' ] && count=$(cat '${attemptsFile}')`,
    'count=$((count + 1))',
    `printf '%s' "$count" > '${attemptsFile}'`,
    'if [ "$count" -eq 1 ]; then echo "first attempt failed" >&2; exit 1; fi',
    'if [ "$count" -eq 2 ]; then',
    '  i=0',
    '  while [ "$i" -lt 8 ]; do printf \'\\003\\021\\000\\000\\000{"voice_level":0}\'; i=$((i + 1)); sleep 0.02; done',
    '  exit 1',
    'fi',
    'sleep 30'
  ].join('\n'))
  const receiver = receiverFor(executable, { noOutputTimeoutMs: 1_000, healthyResetMs: 50, retryDelayMs: 20 })
  t.after(() => receiver.stop())
  receiver.on('error', () => undefined)
  const recoverySignal = new Promise<string>((resolve) => {
    const onState = (state: string): void => {
      if (state.includes('retry backoff reset')) {
        receiver.off('state', onState)
        resolve(state)
      }
    }
    receiver.on('state', onState)
  })
  receiver.start()
  assert.match(await recoverySignal, /recovered after .*retry backoff reset/)
  const retryState = new Promise<string>((resolve) => {
    const onState = (state: string): void => {
      if (state.includes('Receiver unavailable; retrying')) {
        receiver.off('state', onState)
        resolve(state)
      }
    }
    receiver.on('state', onState)
  })
  const state = await retryState
  assert.equal(state, 'Receiver unavailable; retrying in 0.02s')
  receiver.stop()
})

test('stop terminates the sidecar process group without scheduling a retry', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX process groups are unavailable')
  const directory = mkdtempSync(path.join(os.tmpdir(), 'vhf-sidecar-stop-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const pidFile = path.join(directory, 'descendant-pid')
  const attemptsFile = path.join(directory, 'attempts')
  const executable = fakeSidecar(directory, [
    `count=0; [ -f '${attemptsFile}' ] && count=$(cat '${attemptsFile}')`,
    'count=$((count + 1))',
    `printf '%s' "$count" > '${attemptsFile}'`,
    'sleep 30 &',
    `printf '%s' "$!" > '${pidFile}'`,
    'wait'
  ].join('\n'))
  const receiver = receiverFor(executable, { noOutputTimeoutMs: 5_000, retryDelayMs: 20 })
  receiver.start()
  await waitFor(() => {
    try { return readFileSync(pidFile, 'utf8').length > 0 } catch { return false }
  })
  const descendantPid = Number(readFileSync(pidFile, 'utf8'))
  receiver.stop()
  await waitFor(() => {
    try { process.kill(descendantPid, 0); return false } catch { return true }
  })
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(readFileSync(attemptsFile, 'utf8'), '1')
})

test('late close from a stopped attempt cannot overwrite a restarted receiver', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'vhf-sidecar-restart-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const attemptsFile = path.join(directory, 'attempts')
  const executable = fakeSidecar(directory, [
    `count=0; [ -f '${attemptsFile}' ] && count=$(cat '${attemptsFile}')`,
    'count=$((count + 1))',
    `printf '%s' "$count" > '${attemptsFile}'`,
    'if [ "$count" -eq 1 ]; then sleep 30; fi',
    'while :; do printf \'\\003\\021\\000\\000\\000{"voice_level":0}\'; sleep 0.02; done'
  ].join('\n'))
  const receiver = receiverFor(executable, { noOutputTimeoutMs: 1_000 })
  t.after(() => receiver.stop())
  const states: string[] = []
  receiver.on('state', (state) => states.push(state))
  receiver.start()
  await waitFor(() => {
    try { return readFileSync(attemptsFile, 'utf8') === '1' } catch { return false }
  })
  receiver.stop()
  receiver.start()
  await waitFor(() => {
    try { return readFileSync(attemptsFile, 'utf8') === '2' } catch { return false }
  })
  await waitFor(() => states.some((state) => state.includes('Single-frequency capture')))
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(states.at(-1)?.includes('Stopped'), false)
  receiver.stop()
})

test('close kills a detached descendant that ignores TERM and has closed stdio', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX process groups are unavailable')
  const directory = mkdtempSync(path.join(os.tmpdir(), 'vhf-sidecar-descendant-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const pidFile = path.join(directory, 'descendant-pid')
  const heartbeat = path.join(directory, 'heartbeat')
  const descendantScript = path.join(directory, 'ignore-term-descendant')
  writeFileSync(descendantScript, `#!/bin/sh\ntrap '' TERM\nprintf x >> '${heartbeat}'\nprintf '%s' "$$" > '${pidFile}'\nwhile :; do printf x >> '${heartbeat}'; sleep 0.03; done\n`)
  chmodSync(descendantScript, 0o755)
  const executable = fakeSidecar(directory, [
    `'${descendantScript}' >/dev/null 2>&1 &`,
    `while [ ! -s '${pidFile}' ]; do sleep 0.01; done`,
    'exit 0'
  ].join('\n'))
  const receiver = receiverFor(executable, { noOutputTimeoutMs: 5_000 })
  t.after(() => receiver.stop())
  receiver.on('error', () => undefined)
  receiver.start()
  await waitFor(() => {
    try { return readFileSync(pidFile, 'utf8').length > 0 && statSync(heartbeat).size >= 1 } catch { return false }
  })
  const sizeAfterClose = statSync(heartbeat).size
  await new Promise((resolve) => setTimeout(resolve, 120))
  assert.equal(statSync(heartbeat).size, sizeAfterClose)
})
