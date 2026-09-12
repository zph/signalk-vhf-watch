import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { Worker } from 'node:worker_threads'

function fmIq(sampleRate: number, carrierOffsetHz: number, audioHz: number, deviationHz: number, seconds: number): ArrayBuffer {
  const samples = Math.floor(sampleRate * seconds)
  const iq = new Uint8Array(samples * 2)
  let phase = 0
  for (let index = 0; index < samples; index += 1) {
    const instantaneous = carrierOffsetHz + deviationHz * Math.sin(2 * Math.PI * audioHz * index / sampleRate)
    phase += 2 * Math.PI * instantaneous / sampleRate
    iq[index * 2] = Math.round(127.5 + 100 * Math.cos(phase))
    iq[index * 2 + 1] = Math.round(127.5 + 100 * Math.sin(phase))
  }
  return iq.buffer
}

test('worker channelizes voice and DSC from one wideband IQ capture', async () => {
  const worker = new Worker(path.resolve(__dirname, '../src/channelizer-worker.js'), {
    workerData: {
      centerHz: 156_750_000,
      iqSampleRate: 2_400_000,
      audioSampleRate: 16_000,
      voiceFrequencyHz: 156_800_000,
      dscFrequencyHz: 156_525_000,
      squelch: 0
    }
  })
  try {
    const outputs = new Map<string, ArrayBuffer>()
    const complete = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('channelizer worker timed out')), 5_000)
      worker.on('error', reject)
      worker.on('message', (message: { type: string; pcm?: ArrayBuffer }) => {
        if (message.pcm) outputs.set(message.type, message.pcm)
        if (outputs.has('voice') && outputs.has('dsc')) {
          clearTimeout(timeout)
          resolve()
        }
      })
    })
    const iq = fmIq(2_400_000, 50_000, 1_000, 3_000, 0.06)
    worker.postMessage({ type: 'iq', iq }, [iq])
    await complete
    const voice = new Int16Array(outputs.get('voice')!)
    const dsc = new Int16Array(outputs.get('dsc')!)
    const voicePeak = voice.reduce((peak, sample) => Math.max(peak, Math.abs(sample)), 0)
    assert.ok(voice.length >= 900)
    assert.ok(voicePeak > 1_000)
    assert.ok(dsc.length >= 1_400)
  } finally {
    await worker.terminate()
  }
})
