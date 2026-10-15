import { randomUUID } from 'node:crypto'
import { MessageMuteStore } from './message-mutes'
import { pcmToWav } from './wav'

export interface ListeningMessageInput {
  channel: string
  startedAt: string
  sampleRate: number
  transcript: string
  pcm: Buffer
}

/** Short, bounded, volatile playback queue. Recordings and transcripts retain their own history. */
export class MessageListeningBuffer {
  readonly session = randomUUID()
  #cursor = 0
  #bytes = 0
  readonly #messages = new Map<number, ListeningMessageInput>()

  constructor(readonly mutes: MessageMuteStore, readonly maxBytes = 16 * 1024 * 1024) {}

  add(input: ListeningMessageInput): void {
    const id = ++this.#cursor
    if (input.pcm.length > this.maxBytes) return
    this.#messages.set(id, { ...input, pcm: Buffer.from(input.pcm) })
    this.#bytes += input.pcm.length
    while (this.#bytes > this.maxBytes || this.#messages.size > 128) {
      const oldest = this.#messages.keys().next().value!
      this.#bytes -= this.#messages.get(oldest)!.pcm.length
      this.#messages.delete(oldest)
    }
  }

  list(after?: number) {
    const ids = [...this.#messages.keys()].filter((id) => after !== undefined && id > after)
    return {
      session: this.session,
      cursor: this.#cursor,
      gap: after !== undefined && this.#cursor - after !== ids.length,
      messages: ids.map((id) => this.record(id)!)
    }
  }

  record(id: number) {
    const message = this.#messages.get(id)
    if (!message) return undefined
    return {
      id, channel: message.channel, startedAt: message.startedAt, transcript: message.transcript,
      durationSeconds: message.pcm.length / 2 / message.sampleRate,
      mute: this.mutes.match(message.channel, message.transcript) ?? null
    }
  }

  wav(id: number): Buffer | undefined {
    const message = this.#messages.get(id)
    return message ? pcmToWav(message.pcm, message.sampleRate) : undefined
  }
}
