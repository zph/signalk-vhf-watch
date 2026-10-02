import assert from 'node:assert/strict'
import test from 'node:test'
import { DiscriminatorSquelch } from '../src/discriminator-squelch'

const inputRate = 240_000
const outputRate = 16_000

function feed(squelch: DiscriminatorSquelch, seconds: number, sample: (index: number) => number): number {
  let gain = 0
  const samples = Math.round(seconds * inputRate)
  for (let index = 0; index < samples; index += 1) {
    squelch.observe(sample(index))
    if (index % (inputRate / outputRate) === 0) gain = squelch.gain()
  }
  return gain
}

test('FM quieting opens squelch while idle discriminator noise closes it after a hang', () => {
  const squelch = new DiscriminatorSquelch(inputRate, outputRate, 20)
  let noiseIndex = 0
  const noise = () => (noiseIndex++ % 2 === 0 ? 0.5 : -0.5)
  const speech = (index: number) => 0.1 * Math.sin(2 * Math.PI * 1_000 * index / inputRate)

  assert.equal(feed(squelch, 0.1, noise), 0)
  assert.ok(feed(squelch, 0.1, speech) > 0.99)
  assert.ok(feed(squelch, 0.1, noise) > 0.99)
  assert.equal(feed(squelch, 0.25, noise), 0)
})

test('disabled squelch always passes audio and tuning resets the gate', () => {
  const raw = new DiscriminatorSquelch(inputRate, outputRate, 0)
  assert.equal(raw.gain(), 1)
  assert.equal(feed(raw, 0.05, () => 0.5), 1)

  const squelch = new DiscriminatorSquelch(inputRate, outputRate, 20)
  assert.ok(feed(squelch, 0.1, () => 0) > 0.99)
  squelch.reset()
  assert.equal(squelch.gain(), 0)
})
