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
import { ReplayHistoryStore } from './replay-history-store'
import { ReceiverOwnershipController, type ReceiverOwner } from './receiver-ownership'

const constructor: PluginConstructor = (app: ServerAPI): Plugin => {
  let runtime: VhfRuntime | undefined
  let ownership: ReceiverOwnershipController | undefined
  let modifiedPlayback: ModifiedPlayback | undefined
  let pluginConfig: Record<string, unknown> = {}

  const startRuntime = (rawConfig: object): void => {
    pluginConfig = rawConfig && typeof rawConfig === 'object' ? { ...rawConfig } : {}
    const tuningSettings = new TuningSettingsStore(path.join(app.getDataDirPath(), 'tuning-settings.json'))
    const savedTuning = tuningSettings.load()
    const config = normalizeConfig({
      ...pluginConfig,
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
    const replayHistory = new ReplayHistoryStore(
      path.join(app.getDataDirPath(), 'replay-history'), config.replayMinutes, config.maxBufferMiB * 1024 * 1024,
      (error) => app.error(`[signalk-vhf-watch] Replay history persistence: ${error instanceof Error ? error.message : String(error)}`)
    )
    runtime = new VhfRuntime(
      config, dscCache, transcription,
      (settings) => tuningSettings.save(settings), denoiser, '/usr/bin/ffmpeg',
      () => app.getPath('vessels'), replayHistory
    )
    let lastError: string | undefined
    let lastReceiverState: string | undefined
    runtime.on('status', (status) => {
      const message = status.error
        ? `${status.mode} · ${status.channel.label} · ${status.error}`
        : `${status.mode} · ${status.channel.label} · ${status.receiverState}`
      if (status.error) {
        if (status.error !== lastError) app.error(`[signalk-vhf-watch] ${message}`)
        lastError = status.error
        app.setPluginError(message)
      } else {
        if (lastError) app.debug(`[signalk-vhf-watch] Receiver recovered on ${status.channel.label}`)
        lastError = undefined
        app.setPluginStatus(message)
      }
      if (status.receiverState && status.receiverState !== lastReceiverState) {
        app.debug(`[signalk-vhf-watch] ${status.mode} · ${status.channel.label} · ${status.receiverState}`)
        lastReceiverState = status.receiverState
      }
    })
    runtime.start()
    const managedRuntime = runtime
    ownership = new ReceiverOwnershipController(
      () => managedRuntime,
      config.receiverOwner,
      (owner: ReceiverOwner) => new Promise<void>((resolve, reject) => {
        const nextConfig = { ...pluginConfig, receiverOwner: owner }
        app.savePluginOptions(nextConfig, (error) => {
          if (error) reject(error)
          else { pluginConfig = nextConfig; resolve() }
        })
      }),
      undefined,
      undefined,
      (level, message) => level === 'error'
        ? app.error(`[signalk-vhf-watch] ${message}`)
        : app.debug(`[signalk-vhf-watch] ${message}`)
    )
    const managedOwnership = ownership
    void managedOwnership.initialize().catch((error) => {
      app.error(`[signalk-vhf-watch] Receiver ownership setup: ${error instanceof Error ? error.message : String(error)}`)
    })
    app.setPluginStatus(`${config.receiverMode} · ${runtime.status().channel.label} · receive only`)
  }

  return {
    id: 'signalk-vhf-watch',
    name: 'VHF Watch',
    description: 'Receive-only marine VHF live listening and private rolling replay. Contains no transmit or PTT capability.',
    schema: pluginSchema,
    start: (rawConfig) => {
      if (!runtime) {
        startRuntime(rawConfig)
        return
      }
      const previous = runtime
      const previousOwnership = ownership
      runtime = undefined
      ownership = undefined
      void (async () => {
        let ownershipError: unknown
        try { await previousOwnership?.shutdown() } catch (error) { ownershipError = error }
        try { await previous.stop() } finally {
          modifiedPlayback?.shutdown()
          modifiedPlayback = undefined
        }
        if (ownershipError) throw ownershipError
        startRuntime(rawConfig)
      })().catch((error) => {
        const message = `VHF Watch could not restart: ${error instanceof Error ? error.message : String(error)}`
        app.error(message)
        app.setPluginError(message)
      })
    },
    stop: async () => {
      const stoppingRuntime = runtime
      const stoppingOwnership = ownership
      let stopError: unknown
      try { await stoppingOwnership?.shutdown() } catch (error) { stopError = error }
      try { await stoppingRuntime?.stop() } catch (error) { if (!stopError) stopError = error } finally {
        modifiedPlayback?.shutdown()
        runtime = undefined
        ownership = undefined
        modifiedPlayback = undefined
      }
      if (stopError) throw stopError
    },
    registerWithRouter: (router) => registerRoutes(router, () => runtime, () => modifiedPlayback, () => ownership),
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
