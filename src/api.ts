import type { Request, Response } from 'express'
import type { PluginRouter } from '@signalk/server-api'
import type { ChannelRegion } from './channels'
import { canChannelize } from './receiver'
import type { VhfRuntime } from './runtime'
import { discriminatorThreshold } from './squelch'
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
  read.get('/api/replay', (request: Request, response: Response) => {
    const runtime = runtimeOr503(getRuntime, response)
    if (runtime) {
      const requested = Number(request.query.squelch ?? runtime.config.squelch)
      const squelch = Number.isFinite(requested) ? Math.min(100, Math.max(0, requested)) : runtime.config.squelch
      response.set('Cache-Control', 'no-store').json({ segments: runtime.segments(squelch) })
    }
  })
  read.get('/api/dsc', (_request: Request, response: Response) => {
    const runtime = runtimeOr503(getRuntime, response)
    if (runtime) response.set('Cache-Control', 'no-store').json({ messages: runtime.dscMessages() })
  })
  read.get('/api/replay/:id.wav', (request: Request, response: Response) => {
    const runtime = runtimeOr503(getRuntime, response)
    if (!runtime) return
    const id = Number(request.params.id)
    const segment = runtime.replay.get(id)
    const requestedSquelch = Number(request.query.squelch ?? runtime.config.squelch)
    const squelch = Number.isFinite(requestedSquelch) ? Math.min(100, Math.max(0, requestedSquelch)) : runtime.config.squelch
    const wav = runtime.replay.wavFor(id, squelch)
    if (!segment || !wav) {
      response.status(404).json({ error: 'Replay segment not found' })
      return
    }
    response.set({
      'Content-Type': 'audio/wav',
      'Content-Length': String(wav.length),
      'Cache-Control': 'private, max-age=3600',
      'Content-Disposition': `inline; filename="vhf-${segment.channel}-${segment.startedAt.replace(/[:.]/g, '-')}.wav"`
    }).send(wav)
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
    const requestedSquelch = Number(request.query.squelch ?? runtime.config.squelch)
    const squelch = Number.isFinite(requestedSquelch) ? Math.min(100, Math.max(0, requestedSquelch)) : runtime.config.squelch
    const onAudio = (chunk: Buffer): void => { if (!response.destroyed) response.write(chunk) }
    const onRawAudio = (chunk: Buffer, discriminatorNoise: number): void => {
      if (response.destroyed) return
      const open = discriminatorNoise < discriminatorThreshold(squelch)
      response.write(open ? chunk : Buffer.alloc(chunk.length))
    }
    if (runtime.config.receiverMode === 'rtl_sdr') runtime.on('rawAudio', onRawAudio)
    else runtime.on('audio', onAudio)
    runtime.listenerJoined()
    request.on('close', () => {
      runtime.off('audio', onAudio)
      runtime.off('rawAudio', onRawAudio)
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
  write.post('/api/transcription', async (request: Request, response: Response) => {
    const runtime = runtimeOr503(getRuntime, response)
    if (!runtime) return
    try {
      const enabled = (request.body as { enabled?: unknown } | undefined)?.enabled
      if (typeof enabled !== 'boolean') throw new Error('enabled must be true or false')
      response.json(await runtime.setTranscriptionEnabled(enabled))
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
    info: { title: 'Signal K VHF Watch API', version: '0.4.0' },
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
      '/api/region': { post: { summary: 'Select the US, Canadian, or combined channel plan', responses: { '200': { description: 'Updated status' } } } },
      '/api/transcription': { post: { summary: 'Durably enable or disable local voice transcription', responses: { '200': { description: 'Updated status' } } } }
    }
  }
}
