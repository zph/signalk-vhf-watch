/*
 * VHF DSC framing follows ITU-R M.493. The compact BCH/framing approach here was independently
 * adapted from GopherTrunk's Apache-2.0 DSC receiver; see THIRD_PARTY_NOTICES.md.
 */

export interface DscPosition {
  latitude: number
  longitude: number
}

export interface DscMessage {
  id: number
  receivedAt: string
  format: string
  category: string
  selfMmsi?: string
  targetMmsi?: string
  nature?: string
  position?: DscPosition
  timeUtc?: string
  eos: number
  validCharacters: boolean
  rawSymbols: number[]
}

const FORMAT_NAMES: Record<number, string> = {
  102: 'geographic',
  112: 'distress',
  114: 'group',
  116: 'all-ships',
  120: 'individual',
  123: 'auto-individual'
}

const CATEGORY_NAMES: Record<number, string> = {
  100: 'routine',
  108: 'safety',
  110: 'urgency',
  112: 'distress'
}

const NATURE_NAMES: Record<number, string> = {
  100: 'fire / explosion', 101: 'flooding', 102: 'collision', 103: 'grounding',
  104: 'listing', 105: 'sinking', 106: 'disabled and adrift',
  107: 'undesignated distress', 108: 'abandoning ship', 109: 'piracy / armed attack',
  110: 'man overboard', 112: 'EPIRB emission'
}

const PHASING_DX = 125
const CHARACTER_BITS = 10
const DX_STRIDE = CHARACTER_BITS * 2
const CHARACTER_MASK = (1 << CHARACTER_BITS) - 1
const EOS = new Set([117, 122, 127])

export function bchEncode(data: number): number {
  const clean = data & 0x7f
  let dividend = clean << 3
  for (let bit = 9; bit >= 3; bit -= 1) {
    if ((dividend & (1 << bit)) !== 0) dividend ^= 0x0b << (bit - 3)
  }
  return (clean << 3) | (dividend & 0x07)
}

export function bchCheck(codeword: number): { data: number; valid: boolean } {
  let remainder = codeword & CHARACTER_MASK
  for (let bit = 9; bit >= 3; bit -= 1) {
    if ((remainder & (1 << bit)) !== 0) remainder ^= 0x0b << (bit - 3)
  }
  return { data: (codeword >> 3) & 0x7f, valid: (remainder & 0x07) === 0 }
}

function decodeMmsi(symbols: number[]): string | undefined {
  if (symbols.length !== 5 || symbols.some((value) => value > 99)) return undefined
  const pairs = symbols.map((value) => String(value).padStart(2, '0')).join('')
  return pairs.slice(0, 9)
}

function decodePosition(symbols: number[]): DscPosition | undefined {
  if (symbols.length !== 5 || symbols.some((value) => value > 99)) return undefined
  const digits = symbols.map((value) => String(value).padStart(2, '0')).join('')
  if (digits === '9999999999') return undefined
  const quadrant = Number(digits[0])
  const latitude = Number(digits.slice(1, 3)) + Number(digits.slice(3, 5)) / 60
  const longitude = Number(digits.slice(5, 8)) + Number(digits.slice(8, 10)) / 60
  if (quadrant > 3 || latitude > 90 || longitude > 180) return undefined
  return {
    latitude: quadrant & 2 ? -latitude : latitude,
    longitude: quadrant & 1 ? -longitude : longitude
  }
}

export function decodeDscSymbols(symbols: number[], validCharacters = true, id = 0): DscMessage {
  const formatCode = symbols[0] ?? 0
  const message: DscMessage = {
    id,
    receivedAt: new Date().toISOString(),
    format: FORMAT_NAMES[formatCode] ?? 'unknown',
    category: formatCode === 112 ? 'distress' : 'unknown',
    eos: symbols.at(-1) ?? 0,
    validCharacters,
    rawSymbols: [...symbols]
  }
  if (formatCode === 112) {
    message.selfMmsi = decodeMmsi(symbols.slice(1, 6))
    message.nature = NATURE_NAMES[symbols[6] ?? 0]
    message.position = decodePosition(symbols.slice(7, 12))
    const hours = symbols[12]
    const minutes = symbols[13]
    if (hours !== undefined && minutes !== undefined && hours <= 23 && minutes <= 59) {
      message.timeUtc = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
    }
    return message
  }
  message.targetMmsi = decodeMmsi(symbols.slice(1, 6))
  message.category = CATEGORY_NAMES[symbols[6] ?? 0] ?? 'unknown'
  message.selfMmsi = decodeMmsi(symbols.slice(7, 12))
  return message
}

class BitFramer {
  #register = 0
  #bitCount = 0
  #full = false
  #locked = false
  #lastDxBit = 0
  #lastDxInverted = false
  #dxSeen = false
  #lockBit = 0
  #inverted = false
  #started = false
  #symbols: number[] = []
  #badCharacters = 0

  push(bit: number): { symbols: number[]; validCharacters: boolean } | undefined {
    this.#register = ((this.#register << 1) | (bit ? 1 : 0)) & CHARACTER_MASK
    this.#bitCount += 1
    if (!this.#full) {
      this.#full = this.#bitCount >= CHARACTER_BITS
      if (!this.#full) return undefined
    }
    if (!this.#locked) {
      const polarity = this.#phasingPolarity()
      if (polarity === undefined) return undefined
      if (this.#dxSeen && this.#lastDxInverted === polarity && this.#bitCount - this.#lastDxBit === DX_STRIDE) {
        this.#locked = true
        this.#inverted = polarity
        this.#lockBit = this.#bitCount
        this.#started = false
        this.#symbols = []
        this.#badCharacters = 0
        this.#dxSeen = false
        return undefined
      }
      this.#dxSeen = true
      this.#lastDxBit = this.#bitCount
      this.#lastDxInverted = polarity
      return undefined
    }
    if ((this.#bitCount - this.#lockBit) % DX_STRIDE !== 0) return undefined
    const codeword = this.#inverted ? (~this.#register) & CHARACTER_MASK : this.#register
    const decoded = bchCheck(codeword)
    if (!this.#started) {
      if (decoded.data === PHASING_DX) return undefined
      if (!decoded.valid) {
        this.#reset()
        return undefined
      }
      this.#started = true
    }
    if (!decoded.valid) this.#badCharacters += 1
    this.#symbols.push(decoded.data)
    if (EOS.has(decoded.data)) {
      const result = { symbols: [...this.#symbols], validCharacters: this.#badCharacters === 0 }
      this.#reset()
      return result
    }
    if (this.#symbols.length >= 40) this.#reset()
    return undefined
  }

  #phasingPolarity(): boolean | undefined {
    const normal = bchCheck(this.#register)
    if (normal.valid && normal.data === PHASING_DX) return false
    const inverted = bchCheck((~this.#register) & CHARACTER_MASK)
    return inverted.valid && inverted.data === PHASING_DX ? true : undefined
  }

  #reset(): void {
    this.#locked = false
    this.#started = false
    this.#symbols = []
    this.#badCharacters = 0
    this.#dxSeen = false
  }
}

export class DscAudioDecoder {
  readonly #sampleRate: number
  readonly #samplesPerSymbol: number
  readonly #frames: BitFramer[]
  readonly #window: number[]
  readonly #markCos: number[]
  readonly #markSin: number[]
  readonly #spaceCos: number[]
  readonly #spaceSin: number[]
  #sampleCount = 0
  #nextId = 1
  #lastRaw = ''
  #lastRawAt = 0

  constructor(sampleRate = 24_000) {
    this.#sampleRate = sampleRate
    this.#samplesPerSymbol = sampleRate / 1_200
    if (!Number.isInteger(this.#samplesPerSymbol)) throw new Error('DSC sample rate must be divisible by 1200')
    this.#frames = Array.from({ length: this.#samplesPerSymbol }, () => new BitFramer())
    this.#window = Array(this.#samplesPerSymbol).fill(0)
    const basis = (frequency: number, fn: (angle: number) => number) => Array.from(
      { length: this.#samplesPerSymbol },
      (_, index) => fn(2 * Math.PI * frequency * index / sampleRate)
    )
    this.#markCos = basis(1_300, Math.cos)
    this.#markSin = basis(1_300, Math.sin)
    this.#spaceCos = basis(2_100, Math.cos)
    this.#spaceSin = basis(2_100, Math.sin)
  }

  push(pcm: Buffer): DscMessage[] {
    const messages: DscMessage[] = []
    for (let offset = 0; offset + 1 < pcm.length; offset += 2) {
      this.#window[this.#sampleCount % this.#samplesPerSymbol] = pcm.readInt16LE(offset) / 32_768
      this.#sampleCount += 1
      if (this.#sampleCount < this.#samplesPerSymbol) continue
      const bit = this.#toneEnergy(this.#markCos, this.#markSin) > this.#toneEnergy(this.#spaceCos, this.#spaceSin) ? 1 : 0
      const frame = this.#frames[this.#sampleCount % this.#samplesPerSymbol]!.push(bit)
      if (!frame) continue
      const raw = frame.symbols.join(',')
      const now = Date.now()
      if (raw === this.#lastRaw && now - this.#lastRawAt < 2_000) continue
      this.#lastRaw = raw
      this.#lastRawAt = now
      messages.push(decodeDscSymbols(frame.symbols, frame.validCharacters, this.#nextId++))
    }
    // Adjacent sample-phase hypotheses can produce a damaged shadow of the same clean frame. When
    // at least one fully valid decode exists in this batch, prefer it and suppress those shadows.
    return messages.some((message) => message.validCharacters)
      ? messages.filter((message) => message.validCharacters)
      : messages
  }

  #toneEnergy(cosine: number[], sine: number[]): number {
    let i = 0
    let q = 0
    const start = this.#sampleCount % this.#samplesPerSymbol
    for (let index = 0; index < this.#samplesPerSymbol; index += 1) {
      const sample = this.#window[(start + index) % this.#samplesPerSymbol]!
      i += sample * cosine[index]!
      q += sample * sine[index]!
    }
    return i * i + q * q
  }
}
