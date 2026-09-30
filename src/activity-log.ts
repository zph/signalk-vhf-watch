export interface SpectrumActivitySample {
  channel: string
  frequencyHz: number
  score: number
}

export interface SpectrumActivityEvent extends SpectrumActivitySample {
  id: number
  startedAt: string
  endedAt?: string
}

export class SpectrumActivityLog {
  readonly #ttlMs: number
  readonly #maximumEvents: number
  #nextId = 1
  #events: SpectrumActivityEvent[] = []
  readonly #open = new Map<number, SpectrumActivityEvent>()

  constructor(ttlMinutes = 1_440, maximumEvents = 5_000) {
    this.#ttlMs = ttlMinutes * 60_000
    this.#maximumEvents = maximumEvents
  }

  update(samples: SpectrumActivitySample[], now = Date.now()): void {
    const activeFrequencies = new Set(samples.map((sample) => sample.frequencyHz))
    for (const [frequencyHz, event] of this.#open) {
      if (activeFrequencies.has(frequencyHz)) continue
      event.endedAt = new Date(now).toISOString()
      this.#open.delete(frequencyHz)
    }
    for (const sample of samples) {
      const existing = this.#open.get(sample.frequencyHz)
      if (existing) {
        existing.score = Math.max(existing.score, sample.score)
        continue
      }
      const event: SpectrumActivityEvent = {
        id: this.#nextId++, ...sample, startedAt: new Date(now).toISOString()
      }
      this.#events.push(event)
      this.#open.set(sample.frequencyHz, event)
    }
    this.#prune(now)
  }

  list(now = Date.now()): SpectrumActivityEvent[] {
    this.#prune(now)
    return this.#events.map((event) => ({ ...event }))
  }

  #prune(now: number): void {
    const cutoff = now - this.#ttlMs
    this.#events = this.#events.filter((event) => event.endedAt === undefined || Date.parse(event.endedAt) >= cutoff)
    if (this.#events.length <= this.#maximumEvents) return
    const remove = this.#events.length - this.#maximumEvents
    const removable = this.#events.filter((event) => event.endedAt !== undefined).slice(0, remove)
    const removed = new Set(removable.map((event) => event.id))
    this.#events = this.#events.filter((event) => !removed.has(event.id))
  }
}
