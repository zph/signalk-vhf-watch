import path from 'node:path'
import os from 'node:os'
import type { Plugin, PluginConstructor, ServerAPI } from '@signalk/server-api'
import { openApi, registerRoutes } from './api'
import { normalizeConfig, pluginSchema } from './config'
import { DscMessageCache } from './dsc-cache'
import { VhfRuntime } from './runtime'
import { TranscriptionManager } from './transcription'
import { TranscriptArchive } from './transcript-archive'
import { NarrationManager } from './narration'
import { TuningSettingsStore } from './tuning-settings'
import { RnnoiseDenoiser } from './rnnoise'

const constructor: PluginConstructor = (app: ServerAPI): Plugin => {
  let runtime: VhfRuntime | undefined

  return {
    id: 'signalk-vhf-watch',
    name: 'VHF Watch',
    description: 'Receive-only marine VHF live listening and private rolling replay. Contains no transmit or PTT capability.',
    schema: pluginSchema,
    start: (rawConfig) => {
      runtime?.stop()
      const tuningSettings = new TuningSettingsStore(path.join(app.getDataDirPath(), 'tuning-settings.json'))
      const savedTuning = tuningSettings.load()
      const config = normalizeConfig({
        ...(rawConfig && typeof rawConfig === 'object' ? rawConfig : {}),
        ...(savedTuning.channelRegion ? { channelRegion: savedTuning.channelRegion } : {}),
        ...(savedTuning.slotAMode ? { slotAMode: savedTuning.slotAMode } : {}),
        ...(savedTuning.slotAChannel ? { initialChannel: savedTuning.slotAChannel } : {}),
        ...(savedTuning.slotBChannel ? { slotBChannel: savedTuning.slotBChannel } : {})
      })
      const dscCache = new DscMessageCache(path.join(app.getDataDirPath(), 'dsc-calls.json'), {
        ttlHours: config.dscRetentionHours,
        maxMessages: config.maxDscMessages,
        maxBytes: config.maxDscCacheKiB * 1024
      })
      const archive = new TranscriptArchive(path.join(app.getDataDirPath(), 'transcript-archive', 'transcripts.sqlite3'))
      const denoiser = new RnnoiseDenoiser()
      const transcription = new TranscriptionManager(
        path.join(app.getDataDirPath(), 'transcription-settings.json'),
        undefined,
        { archive }
      )
      const narration = new NarrationManager(archive, undefined, {
        canRun: () => !transcription.busy() && os.loadavg()[0] <= Math.max(1, os.cpus().length * 0.4)
      })
      transcription.attachNarrator(narration)
      runtime = new VhfRuntime(config, dscCache, transcription, narration, (settings) => tuningSettings.save(settings), denoiser)
      runtime.on('status', (status) => {
        const message = status.error
          ? `${status.mode} · ${status.channel.label} · ${status.error}`
          : `${status.mode} · ${status.channel.label} · ${status.receiverState}`
        if (status.error) app.setPluginError(message)
        else app.setPluginStatus(message)
      })
      runtime.start()
      app.setPluginStatus(`${config.receiverMode} · ${runtime.status().channel.label} · receive only`)
    },
    stop: () => {
      runtime?.stop()
      runtime = undefined
    },
    registerWithRouter: (router) => registerRoutes(router, () => runtime),
    getOpenApi: openApi,
    statusMessage: () => {
      const status = runtime?.status()
      return status
        ? `${status.mode} · ${status.channel.label} · ${status.receiverState} · ${status.replaySegments} replay segments`
        : 'Stopped'
    }
  }
}

export = constructor
