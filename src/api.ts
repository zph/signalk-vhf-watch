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
        available: true,
        availableSlotA: true,
        availableSlotB: runtime.config.receiverMode !== 'rtl_sdr' || canChannelize(channel.frequencyHz),
        requiresSingleFrequency: runtime.config.receiverMode === 'rtl_sdr' && !canChannelize(channel.frequencyHz)
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
  read.get('/api/transcripts', (request: Request, response: Response) => {
    const runtime = runtimeOr503(getRuntime, response)
    if (!runtime) return
    const requested = Number(request.query.limit ?? 500)
    const limit = Number.isFinite(requested) ? Math.min(2_000, Math.max(1, Math.floor(requested))) : 500
    response.set('Cache-Control', 'no-store').json({
      records: runtime.transcription.archiveRecords(limit),
      archive: runtime.transcription.status().archive
    })
  })
  read.get('/api/transcripts/:id.wav', (request: Request, response: Response) => {
    const runtime = runtimeOr503(getRuntime, response)
    if (!runtime) return
    const id = Number(request.params.id)
    const record = Number.isSafeInteger(id) && id > 0 ? runtime.transcription.archiveRecord(id) : undefined
    const wav = record ? runtime.transcription.archiveWav(id) : undefined
    if (!record || !wav) {
      response.status(404).json({ error: 'Archived transcript not found' })
      return
    }
    response.set({
      'Content-Type': 'audio/wav',
      'Content-Length': String(wav.length),
      'Cache-Control': 'private, max-age=3600',
      'Content-Disposition': `inline; filename="vhf-transcript-${record.channel}-${record.startedAt.replace(/[:.]/g, '-')}.wav"`
    }).send(wav)
  })
  read.get('/api/replay/:id.wav', (request: Request, response: Response) => {
    const runtime = runtimeOr503(getRuntime, response)
    if (!runtime) return
    const id = Number(request.params.id)
    const segment = runtime.replaySegment(id)
    const requestedSquelch = Number(request.query.squelch ?? runtime.config.squelch)
    const squelch = Number.isFinite(requestedSquelch) ? Math.min(100, Math.max(0, requestedSquelch)) : runtime.config.squelch
    const wav = runtime.replayWavFor(id, squelch)
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
  write.post('/api/slots', (request: Request, response: Response) => {
    const runtime = runtimeOr503(getRuntime, response)
    if (!runtime) return
    try {
      const body = request.body as { mode?: unknown; slotAChannel?: unknown; slotBChannel?: unknown } | undefined
      const mode = String(body?.mode ?? '')
      if (mode !== 'fixed' && mode !== 'scan') throw new Error('Slot A mode must be fixed or scan')
      response.json(runtime.configureSlots(mode, String(body?.slotAChannel ?? ''), String(body?.slotBChannel ?? '')))
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
      const body = request.body as { enabled?: unknown; model?: unknown; threads?: unknown } | undefined
      let status = runtime.status()
      if (body?.model !== undefined || body?.threads !== undefined) {
        if (typeof body.model !== 'string') throw new Error('model must be a string')
        if (typeof body.threads !== 'number') throw new Error('threads must be a number')
        status = await runtime.configureTranscription(body.model, body.threads)
      }
      if (body?.enabled !== undefined) {
        if (typeof body.enabled !== 'boolean') throw new Error('enabled must be true or false')
        status = await runtime.setTranscriptionEnabled(body.enabled)
      }
      if (body?.enabled === undefined && body?.model === undefined && body?.threads === undefined) {
        throw new Error('enabled, model, or threads is required')
      }
      response.json(status)
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : String(error) })
    }
  })
  write.delete('/api/replay', (_request: Request, response: Response) => {
    const runtime = runtimeOr503(getRuntime, response)
    if (!runtime) return
    runtime.clearReplay()
    response.status(204).end()
  })
  write.delete('/api/replay/:id', (request: Request, response: Response) => {
    const runtime = runtimeOr503(getRuntime, response)
    if (!runtime) return
    const id = Number(request.params.id)
    if (!Number.isSafeInteger(id) || id < 1 || !runtime.deleteReplay(id)) {
      response.status(404).json({ error: 'Replay segment not found' })
      return
    }
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
      '/api/replay/{id}': { delete: { summary: 'Delete one private rolling replay segment', responses: { '204': { description: 'Deleted' }, '404': { description: 'Not found' } } } },
      '/api/replay/{id}.wav': { get: { summary: 'Play one replay segment', responses: { '200': { description: 'WAV audio' } } } },
      '/api/transcripts': { get: { summary: 'List retained voice transcripts and metadata', responses: { '200': { description: 'Transcript archive' } } } },
      '/api/transcripts/{id}.wav': { get: { summary: 'Play an archived voice record', responses: { '200': { description: 'WAV audio' }, '404': { description: 'Not found' } } } },
      '/api/live.wav': { get: { summary: 'Listen to the live receive-only PCM stream', responses: { '200': { description: 'Streaming WAV audio' } } } },
      '/api/dsc': {
        get: { summary: 'List decoded DSC Channel 70 calls', responses: { '200': { description: 'DSC calls' } } },
        delete: { summary: 'Clear decoded DSC calls', responses: { '204': { description: 'Cleared' } } }
      },
      '/api/channel': { post: { summary: 'Tune the receive channel', responses: { '200': { description: 'Updated status' } } } },
      '/api/slots': { post: { summary: 'Configure the two receiver slots and Slot A scan mode', responses: { '200': { description: 'Updated status' } } } },
      '/api/region': { post: { summary: 'Select the US, Canadian, or combined channel plan', responses: { '200': { description: 'Updated status' } } } },
      '/api/transcription': { post: { summary: 'Durably enable or disable local voice transcription', responses: { '200': { description: 'Updated status' } } } }
    }
  }
}
