function transform(real: Float64Array, imaginary: Float64Array, inverse: boolean): void {
  const length = real.length
  for (let index = 1, reversed = 0; index < length; index += 1) {
    let bit = length >> 1
    for (; reversed & bit; bit >>= 1) reversed ^= bit
    reversed ^= bit
    if (index >= reversed) continue
    const swappedReal = real[index]!
    const swappedImaginary = imaginary[index]!
    real[index] = real[reversed]!
    imaginary[index] = imaginary[reversed]!
    real[reversed] = swappedReal
    imaginary[reversed] = swappedImaginary
  }
  for (let size = 2; size <= length; size *= 2) {
    const angle = (inverse ? 2 : -2) * Math.PI / size
    const stepReal = Math.cos(angle)
    const stepImaginary = Math.sin(angle)
    for (let start = 0; start < length; start += size) {
      let twiddleReal = 1
      let twiddleImaginary = 0
      for (let offset = 0; offset < size / 2; offset += 1) {
        const left = start + offset
        const right = left + size / 2
        const valueReal = real[right]! * twiddleReal - imaginary[right]! * twiddleImaginary
        const valueImaginary = real[right]! * twiddleImaginary + imaginary[right]! * twiddleReal
        real[right] = real[left]! - valueReal
        imaginary[right] = imaginary[left]! - valueImaginary
        real[left] += valueReal
        imaginary[left] += valueImaginary
        const nextReal = twiddleReal * stepReal - twiddleImaginary * stepImaginary
        twiddleImaginary = twiddleReal * stepImaginary + twiddleImaginary * stepReal
        twiddleReal = nextReal
      }
    }
  }
  if (inverse) {
    for (let index = 0; index < length; index += 1) {
      real[index] /= length
      imaginary[index] /= length
    }
  }
}

export class SpectralHissReducer {
  readonly latencySamples: number
  readonly #sampleRate: number
  readonly #size: number
  readonly #hop: number
  readonly #windowFrames: number
  readonly #window: Float64Array
  readonly #input: Float64Array
  readonly #pending: Float64Array
  readonly #weights: Float64Array
  readonly #real: Float64Array
  readonly #imaginary: Float64Array
  readonly #smoothedPower: Float64Array
  readonly #currentMinimum: Float64Array
  readonly #previousMinimum: Float64Array
  readonly #targetGain: Float64Array
  readonly #gain: Float64Array
  #sampleIndex = 0
  #frames = 0
  #noiseFrames = 0

  constructor(sampleRate: number) {
    this.#sampleRate = sampleRate
    this.#size = 2 ** Math.ceil(Math.log2(sampleRate * 0.032))
    this.#hop = this.#size / 2
    this.latencySamples = this.#size - 1
    this.#windowFrames = Math.max(1, Math.ceil(sampleRate * 0.6 / this.#hop))
    this.#window = Float64Array.from({ length: this.#size }, (_, index) => Math.sin(Math.PI * (index + 0.5) / this.#size))
    this.#input = new Float64Array(this.#size)
    this.#pending = new Float64Array(this.#size * 4)
    this.#weights = new Float64Array(this.#size * 4)
    this.#real = new Float64Array(this.#size)
    this.#imaginary = new Float64Array(this.#size)
    this.#smoothedPower = new Float64Array(this.#hop + 1)
    this.#currentMinimum = new Float64Array(this.#hop + 1)
    this.#previousMinimum = new Float64Array(this.#hop + 1)
    this.#targetGain = new Float64Array(this.#hop + 1)
    this.#gain = new Float64Array(this.#hop + 1)
    this.#currentMinimum.fill(Infinity)
    this.#previousMinimum.fill(Infinity)
    this.#gain.fill(1)
  }

  process(pcm: Int16Array): Int16Array {
    const output = new Int16Array(pcm.length)
    for (let index = 0; index < pcm.length; index += 1) {
      this.#input[this.#sampleIndex % this.#size] = pcm[index]! / 32768
      if (this.#sampleIndex >= this.latencySamples && (this.#sampleIndex - this.latencySamples) % this.#hop === 0) {
        this.#processFrame()
      }
      const outputIndex = this.#sampleIndex - this.latencySamples
      if (outputIndex >= 0) {
        const slot = outputIndex % this.#pending.length
        const sample = this.#weights[slot]! > 1e-12 ? this.#pending[slot]! / this.#weights[slot]! : 0
        output[index] = Math.max(-32768, Math.min(32767, Math.round(sample * 32768)))
        this.#pending[slot] = 0
        this.#weights[slot] = 0
      }
      this.#sampleIndex += 1
    }
    return output
  }

  #processFrame(): void {
    const start = this.#sampleIndex - this.latencySamples
    for (let index = 0; index < this.#size; index += 1) {
      this.#real[index] = this.#input[(start + index) % this.#size]! * this.#window[index]!
      this.#imaginary[index] = 0
    }
    transform(this.#real, this.#imaginary, false)

    let spectralSum = 0
    let logSum = 0
    let bandBins = 0
    for (let bin = 0; bin <= this.#hop; bin += 1) {
      const frequency = bin * this.#sampleRate / this.#size
      if (frequency < 180 || frequency > 3_400) continue
      const power = this.#real[bin]! ** 2 + this.#imaginary[bin]! ** 2 + 1e-12
      spectralSum += power
      logSum += Math.log(power)
      bandBins += 1
    }
    const flatness = Math.exp(logSum / bandBins) / (spectralSum / bandBins)
    const noiseLike = flatness > 0.3
    if (noiseLike) this.#noiseFrames += 1

    for (let bin = 0; bin <= this.#hop; bin += 1) {
      const power = this.#real[bin]! ** 2 + this.#imaginary[bin]! ** 2
      const smoothed = this.#frames === 0 ? power : this.#smoothedPower[bin]! * 0.8 + power * 0.2
      this.#smoothedPower[bin] = smoothed
      if (noiseLike && smoothed < this.#previousMinimum[bin]! * 2.5) {
        this.#currentMinimum[bin] = Math.min(this.#currentMinimum[bin]!, smoothed)
      }
      const frequency = bin * this.#sampleRate / this.#size
      const bandLimit = frequency < 180 || frequency > 3_400 ? 0.08 : 1
      const noise = Math.min(this.#currentMinimum[bin]!, this.#previousMinimum[bin]!) * 1.4
      const spectralGain = this.#frames < this.#windowFrames || this.#noiseFrames < 8 || !Number.isFinite(noise)
        ? 1
        : Math.max(0.12, Math.min(1, 1 - noise / Math.max(power, 1e-12)))
      this.#targetGain[bin] = bandLimit * spectralGain
    }
    for (let bin = 0; bin <= this.#hop; bin += 1) {
      const target = (this.#targetGain[Math.max(0, bin - 1)]! + this.#targetGain[bin]! + this.#targetGain[Math.min(this.#hop, bin + 1)]!) / 3
      this.#gain[bin] = this.#gain[bin]! * 0.7 + target * 0.3
      this.#real[bin] *= this.#gain[bin]!
      this.#imaginary[bin] *= this.#gain[bin]!
      if (bin > 0 && bin < this.#hop) {
        this.#real[this.#size - bin] *= this.#gain[bin]!
        this.#imaginary[this.#size - bin] *= this.#gain[bin]!
      }
    }
    transform(this.#real, this.#imaginary, true)
    for (let index = 0; index < this.#size; index += 1) {
      const slot = (start + index) % this.#pending.length
      const window = this.#window[index]!
      this.#pending[slot] += this.#real[index]! * window
      this.#weights[slot] += window * window
    }
    this.#frames += 1
    if (this.#frames % this.#windowFrames === 0) {
      for (let bin = 0; bin <= this.#hop; bin += 1) {
        if (Number.isFinite(this.#currentMinimum[bin]!)) this.#previousMinimum[bin] = this.#currentMinimum[bin]!
      }
      this.#currentMinimum.fill(Infinity)
    }
  }
}
