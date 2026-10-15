import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const MESSAGE_MUTE_SIMILARITY = 0.9
const MAXIMUM_RULES = 100
const MAXIMUM_WORDS = 500

export interface MessageMute {
  id: string
  channel: string
  transcript: string
  createdAt: string
}

export interface MessageMuteMatch { id: string; similarity: number }

function words(text: string): string[] {
  return text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
}

const numberWords = new Set('zero oh one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety hundred thousand million'.split(' '))
const protectedWords = new Set('not no never unable emergency distress mayday pan urgent assistance help sinking fire collision'.split(' '))

/** Whole-message word similarity; never treats a shared opening as a complete match. */
export function messageSimilarity(left: string, right: string): number {
  const a = words(left)
  const b = words(right)
  if (!a.length || !b.length || a.length > MAXIMUM_WORDS || b.length > MAXIMUM_WORDS) return 0
  if (a.join(' ') === b.join(' ')) return 1
  if (Math.min(a.length, b.length) < 10) return 0
  const protectedTokens = (tokens: string[]) => tokens.filter((word) => /\p{N}/u.test(word) || numberWords.has(word) || protectedWords.has(word)).join(' ')
  if (protectedTokens(a) !== protectedTokens(b)) return 0
  const maximum = Math.max(a.length, b.length)
  const budget = Math.floor(maximum * (1 - MESSAGE_MUTE_SIMILARITY) + 1e-8)
  if (Math.abs(a.length - b.length) > budget) return 0
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let row = 1; row <= a.length; row += 1) {
    const current = Array<number>(b.length + 1).fill(maximum + 1)
    current[0] = row
    let minimum = maximum + 1
    for (let column = Math.max(1, row - budget); column <= Math.min(b.length, row + budget); column += 1) {
      current[column] = Math.min(previous[column] + 1, current[column - 1] + 1,
        previous[column - 1] + (a[row - 1] === b[column - 1] ? 0 : 1))
      minimum = Math.min(minimum, current[column])
    }
    if (minimum > budget) return 0
    previous = current
  }
  const score = 1 - previous[b.length] / maximum
  return score + 1e-8 >= MESSAGE_MUTE_SIMILARITY ? score : 0
}

export class MessageMuteStore {
  #rules: MessageMute[] = []
  readonly #cache = new Map<string, MessageMuteMatch | null>()

  constructor(readonly filename?: string) {
    if (!filename || !existsSync(filename)) return
    const rules: unknown = JSON.parse(readFileSync(filename, 'utf8'))
    if (!Array.isArray(rules) || rules.length > MAXIMUM_RULES || rules.some((rule) =>
      !rule || typeof rule.id !== 'string' || !rule.id || typeof rule.channel !== 'string' || !rule.channel ||
      typeof rule.transcript !== 'string' || !words(rule.transcript).length || words(rule.transcript).length > MAXIMUM_WORDS ||
      typeof rule.createdAt !== 'string' || !Number.isFinite(Date.parse(rule.createdAt)))) {
      throw new Error('Invalid saved message mutes')
    }
    this.#rules = rules as MessageMute[]
  }

  list(): MessageMute[] { return this.#rules.map((rule) => ({ ...rule })) }

  add(channel: string, transcript: string): MessageMute {
    const tokens = words(transcript)
    if (!channel || !tokens.length || tokens.length > MAXIMUM_WORDS || transcript.length > 8_000) {
      throw new Error('Choose a transcript containing between 1 and 500 words')
    }
    const existing = this.match(channel, transcript)
    if (existing) return { ...this.#rules.find((rule) => rule.id === existing.id)! }
    if (this.#rules.length >= MAXIMUM_RULES) throw new Error('Remove a saved mute before adding another (limit 100)')
    const rule = { id: randomUUID(), channel, transcript: transcript.trim(), createdAt: new Date().toISOString() }
    this.#save([...this.#rules, rule])
    return { ...rule }
  }

  remove(id: string): boolean {
    if (!this.#rules.some((rule) => rule.id === id)) return false
    this.#save(this.#rules.filter((rule) => rule.id !== id))
    return true
  }

  match(channel: string, transcript: string): MessageMuteMatch | undefined {
    if (!this.#rules.length || !transcript.trim()) return undefined
    const key = `${channel}\0${transcript}`
    if (this.#cache.has(key)) return this.#cache.get(key) ?? undefined
    let best: MessageMuteMatch | undefined
    for (const rule of this.#rules) {
      if (rule.channel !== channel) continue
      const similarity = messageSimilarity(rule.transcript, transcript)
      if (similarity && (!best || similarity > best.similarity)) best = { id: rule.id, similarity }
    }
    if (this.#cache.size >= 2_000) this.#cache.delete(this.#cache.keys().next().value!)
    this.#cache.set(key, best ?? null)
    return best
  }

  #save(rules: MessageMute[]): void {
    if (this.filename) {
      mkdirSync(path.dirname(this.filename), { recursive: true, mode: 0o700 })
      const temporary = `${this.filename}.${randomUUID()}.tmp`
      writeFileSync(temporary, JSON.stringify(rules), { mode: 0o600 })
      renameSync(temporary, this.filename)
    }
    this.#rules = rules
    this.#cache.clear()
  }
}
