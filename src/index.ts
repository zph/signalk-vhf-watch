import type { Plugin, PluginConstructor, ServerAPI } from '@signalk/server-api'
import { openApi, registerRoutes } from './api'
import { normalizeConfig, pluginSchema } from './config'
import { VhfRuntime } from './runtime'

const constructor: PluginConstructor = (app: ServerAPI): Plugin => {
  let runtime: VhfRuntime | undefined

  return {
    id: 'signalk-vhf-watch',
    name: 'VHF Watch',
    description: 'Receive-only marine VHF live listening and private rolling replay. Contains no transmit or PTT capability.',
    schema: pluginSchema,
    start: (rawConfig) => {
      runtime?.stop()
      const config = normalizeConfig(rawConfig)
      runtime = new VhfRuntime(config)
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
