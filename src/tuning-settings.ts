import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { ChannelRegion } from './channels'
import type { SlotAMode } from './config'

export interface TuningSettings {
  channelRegion: ChannelRegion
  slotAMode: SlotAMode
  slotAChannel: string
  slotBChannel: string
}

export class TuningSettingsStore {
  readonly #settingsPath: string

  constructor(settingsPath: string) {
    this.#settingsPath = settingsPath
  }

  load(): Partial<TuningSettings> {
    try {
      const parsed = JSON.parse(readFileSync(this.#settingsPath, 'utf8')) as Partial<TuningSettings>
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }

  save(settings: TuningSettings): void {
    mkdirSync(path.dirname(this.#settingsPath), { recursive: true })
    const temporary = `${this.#settingsPath}.new`
    writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 })
    renameSync(temporary, this.#settingsPath)
  }
}
