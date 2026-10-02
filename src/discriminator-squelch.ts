export class DiscriminatorSquelch {
  readonly #inputRate: number
  readonly #outputRate: number
  readonly #level: number
  readonly #highPassAlpha: number
  readonly #noiseAlpha: number
  #lowPass = 0
  #noise = 0
  #observed = 0
  #openSamples = 0
  #holdSamples = 0
  #gain = 0
  #open = false

  constructor(inputRate: number, outputRate: number, level: number) {
    this.#inputRate = inputRate
    this.#outputRate = outputRate
    this.#level = level
    this.#highPassAlpha = 1 - Math.exp(-2 * Math.PI * 3_500 / inputRate)
    this.#noiseAlpha = 1 - Math.exp(-1 / (inputRate * 0.01))
  }

  observe(discriminator: number): void {
    if (this.#level === 0) return
    this.#lowPass += this.#highPassAlpha * (discriminator - this.#lowPass)
    this.#noise += this.#noiseAlpha * (Math.abs(discriminator - this.#lowPass) - this.#noise)
    this.#observed += 1
  }

  gain(): number {
    if (this.#level === 0) return 1
    const threshold = 0.12 - this.#level * 0.00095
    const ready = this.#observed >= this.#inputRate * 0.03
    if (ready && this.#noise < threshold) {
      this.#openSamples += 1
      if (this.#openSamples >= this.#outputRate * 0.005) {
        this.#open = true
        this.#holdSamples = Math.round(this.#outputRate * 0.25)
      }
    } else {
      this.#openSamples = 0
      if (this.#noise > threshold * 1.4) this.#open = false
    }
    if (!this.#open && this.#holdSamples > 0) this.#holdSamples -= 1
    const target = this.#open || this.#holdSamples > 0 ? 1 : 0
    const step = 1 / (this.#outputRate * (target ? 0.003 : 0.015))
    this.#gain += Math.sign(target - this.#gain) * Math.min(Math.abs(target - this.#gain), step)
    return this.#gain
  }

  reset(): void {
    this.#lowPass = 0
    this.#noise = 0
    this.#observed = 0
    this.#openSamples = 0
    this.#holdSamples = 0
    this.#gain = 0
    this.#open = false
  }
}
