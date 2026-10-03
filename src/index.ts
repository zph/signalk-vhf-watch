import path from 'node:path'
import type { Plugin, PluginConstructor, ServerAPI } from '@signalk/server-api'
import { openApi, registerRoutes } from './api'
import { normalizeConfig, pluginSchema } from './config'
import { DscMessageCache } from './dsc-cache'
import { VhfRuntime } from './runtime'
import { TranscriptionManager } from './transcription'
import { TranscriptArchive } from './transcript-archive'
import { TuningSettingsStore } from './tuning-settings'
import { RnnoiseDenoiser } from './rnnoise'
import { ModifiedPlayback } from './modified-playback'

const constructor: PluginConstructor = (app: ServerAPI): Plugin => {
  let runtime: VhfRuntime | undefined
  let modifiedPlayback: ModifiedPlayback | undefined

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
        ...(savedTuning.slotBMode ? { slotBMode: savedTuning.slotBMode } : {}),
        ...(savedTuning.slotBChannel ? { slotBChannel: savedTuning.slotBChannel } : {})
      })
      const dscCache = new DscMessageCache(path.join(app.getDataDirPath(), 'dsc-calls.json'), {
        ttlHours: config.dscRetentionHours,
        maxMessages: config.maxDscMessages,
        maxBytes: config.maxDscCacheKiB * 1024
      })
      const archive = new TranscriptArchive(path.join(app.getDataDirPath(), 'transcript-archive', 'transcripts.sqlite3'))
      const denoiser = new RnnoiseDenoiser()
      modifiedPlayback = new ModifiedPlayback()
      const transcription = new TranscriptionManager(
        path.join(app.getDataDirPath(), 'transcription-settings.json'),
        undefined,
        { archive }
      )
      runtime = new VhfRuntime(
        config, dscCache, transcription,
        (settings) => tuningSettings.save(settings), denoiser, '/usr/bin/ffmpeg',
        () => app.getPath('vessels')
      )
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
      modifiedPlayback?.shutdown()
      runtime = undefined
      modifiedPlayback = undefined
    },
    registerWithRouter: (router) => registerRoutes(router, () => runtime, () => modifiedPlayback),
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
