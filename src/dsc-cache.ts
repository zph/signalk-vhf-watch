import fs from 'node:fs'
import path from 'node:path'
import type { DscMessage } from './dsc'

interface StoredDscMessages {
  version: 1
  messages: DscMessage[]
}

export interface DscCacheOptions {
  ttlHours: number
  maxMessages: number
  maxBytes: number
}

export class DscMessageCache {
  readonly #filePath: string
  readonly #options: DscCacheOptions
  #messages: DscMessage[] = []
  #nextId = 1

  constructor(filePath: string, options: DscCacheOptions) {
    this.#filePath = filePath
    this.#options = options
    this.#load()
  }

  list(now = Date.now()): DscMessage[] {
    if (this.#prune(now)) this.#persist()
    return this.#messages.map((message) => ({ ...message, rawSymbols: [...message.rawSymbols] }))
  }

  add(messages: DscMessage[], now = Date.now()): DscMessage[] {
    const accepted = messages.map((message) => ({
      ...message,
      id: this.#nextId++,
      receivedAt: new Date(now).toISOString(),
      rawSymbols: [...message.rawSymbols]
    }))
    this.#messages.unshift(...accepted)
    this.#prune(now)
    this.#persist()
    return accepted
  }

  clear(): void {
    this.#messages = []
    this.#persist()
  }

  #load(): void {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.#filePath, 'utf8')) as Partial<StoredDscMessages>
      if (parsed.version !== 1 || !Array.isArray(parsed.messages)) return
      this.#messages = parsed.messages.filter((message): message is DscMessage => (
        typeof message?.receivedAt === 'string' && Array.isArray(message.rawSymbols)
      ))
      this.#nextId = Math.max(0, ...this.#messages.map((message) => Number(message.id) || 0)) + 1
      if (this.#prune(Date.now())) this.#persist()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        // A damaged cache must never stop the receiver. It is replaced on the next accepted call.
        this.#messages = []
      }
    }
  }

  #prune(now: number): boolean {
    const previous = this.#messages.length
    const oldest = now - this.#options.ttlHours * 60 * 60 * 1000
    this.#messages = this.#messages
      .filter((message) => Date.parse(message.receivedAt) >= oldest)
      .slice(0, this.#options.maxMessages)
    while (this.#messages.length > 0 && this.#encoded().byteLength > this.#options.maxBytes) {
      this.#messages.pop()
    }
    return this.#messages.length !== previous
  }

  #encoded(): Buffer {
    return Buffer.from(JSON.stringify({ version: 1, messages: this.#messages } satisfies StoredDscMessages))
  }

  #persist(): void {
    const directory = path.dirname(this.#filePath)
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    const temporary = `${this.#filePath}.new`
    try {
      fs.writeFileSync(temporary, this.#encoded(), { mode: 0o600 })
      fs.renameSync(temporary, this.#filePath)
      fs.chmodSync(this.#filePath, 0o600)
    } finally {
      try { fs.unlinkSync(temporary) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  }
}
