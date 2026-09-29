import type { Request, Response } from 'express'
import type { PluginRouter } from '@signalk/server-api'
import type { ChannelRegion } from './channels'
import { canChannelize } from './receiver'
import type { VhfRuntime } from './runtime'
import { wavHeader } from './wav'

function runtimeOr503(getRuntime: () => VhfRuntime | undefined, response: Response): VhfRuntime | undefined {
  const runtime = getRuntime()
  if (!runtime) response.status(503).json({ error: 'VHF Watch is not running' })
  return runtime
}

export function registerRoutes(router: PluginRouter, getRuntime: () => VhfRuntime | undefined): void {
  const read = router.access('readonly')
  read.get('/api/status', (_request: Request, response: Response) => {
    const runtime = runtimeOr503(getRuntime, response)
    if (runtime) response.set('Cache-Control', 'no-store').json(runtime.status())
  })
  read.get('/api/channels', (_request: Request, response: Response) => {
    const runtime = runtimeOr503(getRuntime, response)
    if (runtime) response.set('Cache-Control', 'no-store').json({
      region: runtime.region(),
      channels: runtime.channels().map((channel) => ({
        ...channel,
        available: runtime.config.receiverMode !== 'rtl_sdr' || canChannelize(channel.frequencyHz)
      }))
    })
  })
  read.get('/api/replay', (_request: Request, response: Response) => {
    const runtime = runtimeOr503(getRuntime, response)
    if (runtime) response.set('Cache-Control', 'no-store').json({ segments: runtime.segments() })
  })
  read.get('/api/dsc', (_request: Request, response: Response) => {
    const runtime = runtimeOr503(getRuntime, response)
    if (runtime) response.set('Cache-Control', 'no-store').json({ messages: runtime.dscMessages() })
  })
  read.get('/api/replay/:id.wav', (request: Request, response: Response) => {
    const runtime = runtimeOr503(getRuntime, response)
    if (!runtime) return
    const segment = runtime.replay.get(Number(request.params.id))
    if (!segment) {
      response.status(404).json({ error: 'Replay segment not found' })
      return
    }
    response.set({
      'Content-Type': 'audio/wav',
      'Content-Length': String(segment.wav.length),
      'Cache-Control': 'private, max-age=3600',
      'Content-Disposition': `inline; filename="vhf-${segment.channel}-${segment.startedAt.replace(/[:.]/g, '-')}.wav"`
    }).send(segment.wav)
  })
  read.get('/api/live.wav', (request: Request, response: Response) => {
    const runtime = runtimeOr503(getRuntime, response)
    if (!runtime) return
    response.status(200)
    response.set({
      'Content-Type': 'audio/wav',
      'Cache-Control': 'no-store, private',
      'X-Content-Type-Options': 'nosniff'
    })
    response.flushHeaders()
    response.write(wavHeader(runtime.config.sampleRate, 0xffff_ff00))
    const onAudio = (chunk: Buffer): void => { if (!response.destroyed) response.write(chunk) }
    runtime.on('audio', onAudio)
    runtime.listenerJoined()
    request.on('close', () => {
      runtime.off('audio', onAudio)
      runtime.listenerLeft()
      if (!response.destroyed) response.end()
    })
  })

  const write = router.access('readwrite')
  write.post('/api/channel', (request: Request, response: Response) => {
    const runtime = runtimeOr503(getRuntime, response)
    if (!runtime) return
    try {
      const channel = String((request.body as { channel?: unknown } | undefined)?.channel ?? '')
      response.json(runtime.tune(channel))
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : String(error) })
    }
  })
  write.post('/api/region', (request: Request, response: Response) => {
    const runtime = runtimeOr503(getRuntime, response)
    if (!runtime) return
    try {
      const region = String((request.body as { region?: unknown } | undefined)?.region ?? '') as ChannelRegion
      response.json(runtime.setRegion(region))
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : String(error) })
    }
  })
  write.delete('/api/replay', (_request: Request, response: Response) => {
    const runtime = runtimeOr503(getRuntime, response)
    if (!runtime) return
    runtime.replay.clear()
    response.status(204).end()
  })
  write.delete('/api/dsc', (_request: Request, response: Response) => {
    const runtime = runtimeOr503(getRuntime, response)
    if (!runtime) return
    runtime.clearDscMessages()
    response.status(204).end()
  })
}

export function openApi(): object {
  return {
    openapi: '3.0.3',
    info: { title: 'Signal K VHF Watch API', version: '0.3.0' },
    paths: {
      '/api/status': { get: { summary: 'Get receiver status', responses: { '200': { description: 'Status' } } } },
      '/api/channels': { get: { summary: 'List supported receive channels', responses: { '200': { description: 'Channels' } } } },
      '/api/replay': { get: { summary: 'List private rolling replay segments', responses: { '200': { description: 'Replay segments' } } } },
      '/api/replay/{id}.wav': { get: { summary: 'Play one replay segment', responses: { '200': { description: 'WAV audio' } } } },
      '/api/live.wav': { get: { summary: 'Listen to the live receive-only PCM stream', responses: { '200': { description: 'Streaming WAV audio' } } } },
      '/api/dsc': {
        get: { summary: 'List decoded DSC Channel 70 calls', responses: { '200': { description: 'DSC calls' } } },
        delete: { summary: 'Clear decoded DSC calls', responses: { '204': { description: 'Cleared' } } }
      },
      '/api/channel': { post: { summary: 'Tune the receive channel', responses: { '200': { description: 'Updated status' } } } },
      '/api/region': { post: { summary: 'Select the US, Canadian, or combined channel plan', responses: { '200': { description: 'Updated status' } } } }
    }
  }
}
