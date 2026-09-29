import assert from 'node:assert/strict'
import test from 'node:test'
import { bchCheck, bchEncode, decodeDscSymbols, DscAudioDecoder } from '../src/dsc'

function codewordBits(symbol: number): number[] {
  const codeword = bchEncode(symbol)
  return Array.from({ length: 10 }, (_, index) => (codeword >> (9 - index)) & 1)
}

function synthesizeDsc(symbols: number[], leadingSamples = 7): Buffer {
  const bits = [
    ...codewordBits(125), ...codewordBits(0),
    ...codewordBits(125), ...codewordBits(0),
    ...symbols.flatMap((symbol) => [...codewordBits(symbol), ...codewordBits(0)])
  ]
  const sampleRate = 24_000
  const samplesPerBit = 20
  const pcm = Buffer.alloc((leadingSamples + bits.length * samplesPerBit) * 2)
  let phase = 0
  let sample = leadingSamples
  for (const bit of bits) {
    const frequency = bit ? 1_300 : 2_100
    const step = 2 * Math.PI * frequency / sampleRate
    for (let index = 0; index < samplesPerBit; index += 1) {
      pcm.writeInt16LE(Math.round(Math.sin(phase) * 24_000), sample * 2)
      phase += step
      sample += 1
    }
  }
  return pcm
}

test('checks DSC BCH characters and detects corruption', () => {
  // Literal ITU-R M.493 Table A1-1 vectors: 0 = BBBBBBBYYY, 1 = YBBBBBBYYB,
  // and 127 = YYYYYYYBBB. Bits are listed in transmission order.
  assert.equal(bchEncode(0), 0b0000000111)
  assert.equal(bchEncode(1), 0b1000000110)
  assert.equal(bchEncode(127), 0b1111111000)
  assert.deepEqual(bchCheck(bchEncode(125)), { data: 125, valid: true })
  assert.equal(bchCheck(bchEncode(112) ^ 1).valid, false)
})

test('decodes a structured VHF DSC distress call from 24 kHz FSK audio', () => {
  const symbols = [112, 36, 69, 99, 99, 90, 100, 13, 74, 91, 22, 15, 12, 34, 127]
  const decoder = new DscAudioDecoder()
  const messages = decoder.push(synthesizeDsc(symbols))
  assert.equal(messages.length, 1)
  assert.equal(messages[0]?.format, 'distress')
  assert.equal(messages[0]?.category, 'distress')
  assert.equal(messages[0]?.selfMmsi, '366999999')
  assert.equal(messages[0]?.nature, 'fire / explosion')
  assert.deepEqual(messages[0]?.position, { latitude: 37.81666666666667, longitude: -122.25 })
  assert.equal(messages[0]?.timeUtc, '12:34')
  assert.equal(messages[0]?.validCharacters, true)
})

test('parses non-distress address, category, and sender fields', () => {
  const message = decodeDscSymbols([120, 36, 60, 12, 34, 50, 108, 31, 60, 98, 76, 50, 117])
  assert.equal(message.format, 'individual')
  assert.equal(message.category, 'safety')
  assert.equal(message.targetMmsi, '366012345')
  assert.equal(message.selfMmsi, '316098765')
})

test('parses the repeated format symbol in the Signal Identification Wiki VHF sample', () => {
  const message = decodeDscSymbols([
    120, 120, 24, 73, 65, 0, 0, 100, 24, 73, 65, 0, 0, 100, 126, 90, 0, 6,
    126, 126, 126, 117
  ])
  assert.equal(message.format, 'individual')
  assert.equal(message.category, 'routine')
  assert.equal(message.targetMmsi, '247365000')
  assert.equal(message.selfMmsi, '247365000')
  assert.equal(message.eos, 117)
})
