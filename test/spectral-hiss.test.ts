import assert from 'node:assert/strict'
import test from 'node:test'
import { SpectralHissReducer } from '../src/spectral-hiss'

const sampleRate = 16_000

function rms(samples: Int16Array, start: number, end: number): number {
  let power = 0
  for (let index = start; index < end; index += 1) power += samples[index]! ** 2
  return Math.sqrt(power / (end - start))
}

test('adaptive filter reduces steady noise while retaining an arriving voice tone', () => {
  const input = new Int16Array(sampleRate * 3)
  let state = 1
  for (let index = 0; index < input.length; index += 1) {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    const noise = ((state >>> 0) / 4_294_967_296 - 0.5) * 0.08
    const voice = index >= sampleRate ? 0.08 * Math.sin(2 * Math.PI * 1_000 * index / sampleRate) : 0
    input[index] = Math.round((noise + voice) * 32767)
  }
  const reducer = new SpectralHissReducer(sampleRate)
  const output = new Int16Array(input.length)
  for (let index = 0; index < input.length; index += 1600) {
    output.set(reducer.process(input.subarray(index, index + 1600)), index)
  }
  const latency = reducer.latencySamples
  assert.ok(rms(output, 8_000 + latency, 16_000 + latency) < rms(input, 8_000, 16_000) * 0.6)
  assert.ok(rms(output, 32_000 + latency, 40_000 + latency) > 1_500)
})

test('filter does not learn a continuous tone as noise', () => {
  const input = Int16Array.from({ length: sampleRate * 2 }, (_, index) =>
    Math.round(0.08 * Math.sin(2 * Math.PI * 1_000 * index / sampleRate) * 32767))
  const reducer = new SpectralHissReducer(sampleRate)
  const output = reducer.process(input)
  const start = sampleRate + reducer.latencySamples
  assert.ok(rms(output, start, start + 4_000) > rms(input, sampleRate, sampleRate + 4_000) * 0.9)
})
