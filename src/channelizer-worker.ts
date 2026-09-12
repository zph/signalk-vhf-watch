import { parentPort, workerData } from 'node:worker_threads'

interface WorkerConfig {
  centerHz: number
  iqSampleRate: number
  audioSampleRate: number
  voiceFrequencyHz: number
  dscFrequencyHz: number
  squelch: number
}

interface TuneMessage {
  type: 'tune'
  voiceFrequencyHz: number
}

interface IqMessage {
  type: 'iq'
  iq: ArrayBuffer
}

class NfmChannelizer {
  readonly #inputRate: number
  readonly #outputRate: number
  readonly #firstDecimation: number
  readonly #secondDecimation: number
  readonly #squelch: number
  #oscillatorI = 1
  #oscillatorQ = 0
  #stepI = 1
  #stepQ = 0
  #oscillatorSamples = 0
  #mixI = 0
  #mixQ = 0
  #mixCount = 0
  #filterI1 = 0
  #filterQ1 = 0
  #filterI2 = 0
  #filterQ2 = 0
  #filterI3 = 0
  #filterQ3 = 0
  #previousI = 0
  #previousQ = 0
  #audioSum = 0
  #audioCount = 0
  #deemphasis = 0
  #level = 0

  constructor(inputRate: number, outputRate: number, offsetHz: number, squelch: number) {
    this.#inputRate = inputRate
    this.#outputRate = outputRate
    this.#firstDecimation = 10
    const intermediateRate = inputRate / this.#firstDecimation
    this.#secondDecimation = intermediateRate / outputRate
    if (!Number.isInteger(this.#secondDecimation)) throw new Error(`Unsupported audio rate ${outputRate}`)
    this.#squelch = squelch
    this.tune(offsetHz)
  }

  tune(offsetHz: number): void {
    const step = -2 * Math.PI * offsetHz / this.#inputRate
    this.#stepI = Math.cos(step)
    this.#stepQ = Math.sin(step)
  }

  process(iq: Uint8Array): Int16Array {
    const estimated = Math.ceil(iq.length / 2 / this.#firstDecimation / this.#secondDecimation)
    const output = new Int16Array(estimated)
    let outputIndex = 0
    const intermediateRate = this.#inputRate / this.#firstDecimation
    const rfAlpha = 1 - Math.exp(-2 * Math.PI * 12_500 / intermediateRate)
    const deAlpha = 1 - Math.exp(-1 / (this.#outputRate * 75e-6))

    for (let index = 0; index + 1 < iq.length; index += 2) {
      const sourceI = (iq[index]! - 127.5) / 127.5
      const sourceQ = (iq[index + 1]! - 127.5) / 127.5
      this.#mixI += sourceI * this.#oscillatorI - sourceQ * this.#oscillatorQ
      this.#mixQ += sourceI * this.#oscillatorQ + sourceQ * this.#oscillatorI
      const nextI = this.#oscillatorI * this.#stepI - this.#oscillatorQ * this.#stepQ
      this.#oscillatorQ = this.#oscillatorI * this.#stepQ + this.#oscillatorQ * this.#stepI
      this.#oscillatorI = nextI
      this.#oscillatorSamples += 1
      if (this.#oscillatorSamples === 4096) {
        const magnitude = Math.hypot(this.#oscillatorI, this.#oscillatorQ)
        this.#oscillatorI /= magnitude
        this.#oscillatorQ /= magnitude
        this.#oscillatorSamples = 0
      }
      this.#mixCount += 1
      if (this.#mixCount < this.#firstDecimation) continue

      const mixedI = this.#mixI / this.#mixCount
      const mixedQ = this.#mixQ / this.#mixCount
      this.#mixI = 0
      this.#mixQ = 0
      this.#mixCount = 0

      // Three cascaded complex low-pass stages isolate the 25 kHz marine channel before FM
      // discrimination. This keeps adjacent voice traffic out of the selected stream.
      this.#filterI1 += rfAlpha * (mixedI - this.#filterI1)
      this.#filterQ1 += rfAlpha * (mixedQ - this.#filterQ1)
      this.#filterI2 += rfAlpha * (this.#filterI1 - this.#filterI2)
      this.#filterQ2 += rfAlpha * (this.#filterQ1 - this.#filterQ2)
      this.#filterI3 += rfAlpha * (this.#filterI2 - this.#filterI3)
      this.#filterQ3 += rfAlpha * (this.#filterQ2 - this.#filterQ3)

      const cross = this.#previousI * this.#filterQ3 - this.#previousQ * this.#filterI3
      const dot = this.#previousI * this.#filterI3 + this.#previousQ * this.#filterQ3
      this.#previousI = this.#filterI3
      this.#previousQ = this.#filterQ3
      const demodulated = Math.atan2(cross, dot)
      this.#level = this.#level * 0.995 + Math.abs(demodulated) * 0.005
      this.#audioSum += demodulated
      this.#audioCount += 1
      if (this.#audioCount < this.#secondDecimation) continue

      const sample = this.#audioSum / this.#audioCount
      this.#audioSum = 0
      this.#audioCount = 0
      this.#deemphasis += deAlpha * (sample - this.#deemphasis)
      const threshold = this.#squelch === 0 ? 0 : 0.002 + this.#squelch * 0.00012
      const scaled = this.#level < threshold ? 0 : Math.round(this.#deemphasis * 120_000)
      output[outputIndex++] = Math.max(-32_768, Math.min(32_767, scaled))
    }
    return output.subarray(0, outputIndex)
  }
}

const config = workerData as WorkerConfig
const voice = new NfmChannelizer(
  config.iqSampleRate,
  config.audioSampleRate,
  config.voiceFrequencyHz - config.centerHz,
  config.squelch
)
// DSC must never be squelched; its 24 kHz output gives exactly 20 samples per 1200-baud symbol.
const dsc = new NfmChannelizer(config.iqSampleRate, 24_000, config.dscFrequencyHz - config.centerHz, 0)

parentPort?.on('message', (message: TuneMessage | IqMessage) => {
  try {
    if (message.type === 'tune') {
      voice.tune(message.voiceFrequencyHz - config.centerHz)
      return
    }
    const samples = new Uint8Array(message.iq)
    const voicePcm = voice.process(samples)
    const dscPcm = dsc.process(samples)
    const voiceBuffer = new ArrayBuffer(voicePcm.byteLength)
    new Uint8Array(voiceBuffer).set(new Uint8Array(voicePcm.buffer, voicePcm.byteOffset, voicePcm.byteLength))
    const dscBuffer = new ArrayBuffer(dscPcm.byteLength)
    new Uint8Array(dscBuffer).set(new Uint8Array(dscPcm.buffer, dscPcm.byteOffset, dscPcm.byteLength))
    parentPort?.postMessage({ type: 'voice', pcm: voiceBuffer }, [voiceBuffer])
    parentPort?.postMessage({ type: 'dsc', pcm: dscBuffer }, [dscBuffer])
  } catch (error) {
    parentPort?.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) })
  }
})

parentPort?.postMessage({ type: 'state', message: 'Wideband capture · voice + continuous DSC 70' })
