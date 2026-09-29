import type { Request, Response } from 'express'
import type { PluginRouter } from '@signalk/server-api'
import type { ChannelRegion } from './channels'
import { canChannelize } from './receiver'
import type { VhfRuntime } from './runtime'
import { discriminatorThreshold } from './squelch'
import { pcmToWav, wavHeader } from './wav'

interface ByteRange {
  start: number
  end: number
}

export function parseByteRange(value: string | undefined, totalBytes: number): ByteRange | undefined | null {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim())
  if (!match || (match[1] === '' && match[2] === '')) return null
  if (match[1] === '') {
    const suffixBytes = Number(match[2])
    if (!Number.isSafeInteger(suffixBytes) || suffixBytes <= 0) return null
    return { start: Math.max(0, totalBytes - suffixBytes), end: totalBytes - 1 }
  }
  const start = Number(match[1])
  const requestedEnd = match[2] === '' ? totalBytes - 1 : Number(match[2])
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start >= totalBytes || requestedEnd < start) return null
  return { start, end: Math.min(requestedEnd, totalBytes - 1) }
}

function sendSeekableWav(
  request: Request,
  response: Response,
  wav: Buffer,
  filename: string,
  cacheControl: string
): void {
  const range = parseByteRange(request.headers.range, wav.length)
  const commonHeaders = {
    'Accept-Ranges': 'bytes',
    'Content-Type': 'audio/wav',
    'Cache-Control': cacheControl,
    'Content-Disposition': `inline; filename="${filename}"`
  }
  if (range === null) {
    response.status(416).set({ ...commonHeaders, 'Content-Range': `bytes */${wav.length}` }).end()
    return
  }
  if (range === undefined) {
    response.status(200).set({ ...commonHeaders, 'Content-Length': String(wav.length) }).send(wav)
    return
  }
  response.status(206).set({
    ...commonHeaders,
    'Content-Length': String(range.end - range.start + 1),
    'Content-Range': `bytes ${range.start}-${range.end}/${wav.length}`
  }).send(wav.subarray(range.start, range.end + 1))
}

function requestedIds(value: unknown, maximum: number): number[] | undefined {
  if (typeof value !== 'string') return undefined
  const ids = value.split(',').map(Number)
  return ids.length > 0 && ids.length <= maximum && ids.every((id) => Number.isSafeInteger(id) && id > 0)
    ? ids
    : undefined
}

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
    sendSeekableWav(
      request,
      response,
      wav,
      `vhf-transcript-${record.channel}-${record.startedAt.replace(/[:.]/g, '-')}.wav`,
      'private, max-age=3600'
    )
  })
  read.get('/api/transcript-session.wav', (request: Request, response: Response) => {
    const runtime = runtimeOr503(getRuntime, response)
    if (!runtime) return
    const ids = requestedIds(request.query.ids, 500)
    const records = ids?.map((id) => runtime.transcription.archiveRecord(id))
    if (!ids || !records || records.some((record) => !record)) {
      response.status(404).json({ error: 'Transcript session not found' })
      return
    }
    const resolved = records as NonNullable<(typeof records)[number]>[]
    const first = resolved[0]!
    const valid = resolved.every((record, index) =>
      record.channel === first.channel && record.sampleRate === first.sampleRate &&
      (index === 0 || Date.parse(record.startedAt) >= Date.parse(resolved[index - 1]!.startedAt))
    )
    const wavs = valid ? ids.map((id) => runtime.transcription.archiveWav(id)) : []
    if (!valid || wavs.some((wav) => !wav)) {
      response.status(400).json({ error: 'Transcript session is not a continuous channel recording' })
      return
    }
    const pcm = Buffer.concat((wavs as Buffer[]).map((wav) => wav.subarray(44)))
    sendSeekableWav(
      request,
      response,
      pcmToWav(pcm, first.sampleRate),
      `vhf-transcript-${first.channel}-session.wav`,
      'no-store, private'
    )
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
    sendSeekableWav(
      request,
      response,
      wav,
      `vhf-${segment.channel}-${segment.startedAt.replace(/[:.]/g, '-')}.wav`,
      'private, max-age=3600'
    )
  })
  read.get('/api/replay-session.wav', (request: Request, response: Response) => {
    const runtime = runtimeOr503(getRuntime, response)
    if (!runtime) return
    const ids = requestedIds(request.query.ids, 240)
    const requestedSquelch = Number(request.query.squelch ?? runtime.config.squelch)
    const squelch = Number.isFinite(requestedSquelch) ? Math.min(100, Math.max(0, requestedSquelch)) : runtime.config.squelch
    const segments = ids?.map((id) => runtime.replaySegment(id))
    if (!ids || !segments || segments.some((segment) => !segment)) {
      response.status(404).json({ error: 'Replay session not found' })
      return
    }
    const resolved = segments as NonNullable<(typeof segments)[number]>[]
    const first = resolved[0]!
    const valid = resolved.every((segment, index) =>
      segment.slot === first.slot && segment.channel === first.channel &&
      (index === 0 || Date.parse(segment.startedAt) >= Date.parse(resolved[index - 1]!.startedAt))
    )
    const wavs = valid ? ids.map((id) => runtime.replayWavFor(id, squelch)) : []
    if (!valid || wavs.some((wav) => !wav)) {
      response.status(400).json({ error: 'Replay session is not a continuous channel recording' })
      return
    }
    const pcm = Buffer.concat((wavs as Buffer[]).map((wav) => wav.subarray(44)))
    sendSeekableWav(
      request,
      response,
      pcmToWav(pcm, runtime.config.sampleRate),
      `vhf-${first.channel}-session.wav`,
      'no-store, private'
    )
  })
  read.get('/api/replay/:id/continuous.wav', (request: Request, response: Response) => {
    const runtime = runtimeOr503(getRuntime, response)
    if (!runtime) return
    const id = Number(request.params.id)
    const segment = runtime.replaySegment(id)
    const requestedSquelch = Number(request.query.squelch ?? runtime.config.squelch)
    const squelch = Number.isFinite(requestedSquelch) ? Math.min(100, Math.max(0, requestedSquelch)) : runtime.config.squelch
    const chunks = runtime.replayPcmFrom(id, squelch)
    if (!segment || !chunks) {
      response.status(404).json({ error: 'Replay segment not found' })
      return
    }
    response.status(200)
    response.set({
      'Content-Type': 'audio/wav',
      'Cache-Control': 'no-store, private',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `inline; filename="vhf-${segment.channel}-continuous.wav"`
    })
    response.flushHeaders()
    response.write(wavHeader(runtime.config.sampleRate, 0xffff_ff00))
    for (const chunk of chunks) response.write(chunk)
    if (!runtime.canTailReplay(id)) {
      response.end()
      return
    }
    const event = segment.slot === 'A' ? 'rawAudio' : 'rawSlotBAudio'
    const onRawAudio = (chunk: Buffer, discriminatorNoise: number): void => {
      if (response.destroyed) return
      const open = discriminatorNoise < discriminatorThreshold(squelch)
      response.write(open ? chunk : Buffer.alloc(chunk.length))
    }
    runtime.on(event, onRawAudio)
    request.on('close', () => {
      runtime.off(event, onRawAudio)
      if (!response.destroyed) response.end()
    })
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
      '/api/replay/{id}/continuous.wav': { get: { summary: 'Play seamless replay through the live edge', responses: { '200': { description: 'Streaming WAV audio' } } } },
      '/api/replay-session.wav': { get: { summary: 'Play one synthesized historical radio session', responses: { '200': { description: 'WAV audio' } } } },
      '/api/transcripts': { get: { summary: 'List retained voice transcripts and metadata', responses: { '200': { description: 'Transcript archive' } } } },
      '/api/transcripts/{id}.wav': { get: { summary: 'Play an archived voice record', responses: { '200': { description: 'WAV audio' }, '404': { description: 'Not found' } } } },
      '/api/transcript-session.wav': { get: { summary: 'Play one synthesized archived transcript session', responses: { '200': { description: 'WAV audio' } } } },
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
