import type { Request, Response } from 'express'
import type { PluginRouter } from '@signalk/server-api'
import type { ChannelRegion } from './channels'
import { cleanArchivedPlaybackPcm, cleanPlaybackPcm, parsePlaybackCleanup, PlaybackCleaner } from './playback-cleanup'
import { canChannelize } from './receiver'
import type { VhfRuntime } from './runtime'
import { discriminatorThreshold } from './squelch'
import { isFfmpegPlaybackCleanup, type FfmpegPlaybackCleanup } from './rnnoise'
import { pcmToWav, wavHeader } from './wav'
import { ModifiedPlayback, ModifiedPlaybackError } from './modified-playback'
import type { TranscriptArchiveRecord } from './transcript-archive'
import type { ReplayPlaybackCursor, ReplayPlaybackPayload } from './rolling-buffer'

const UI_VERSION = 49

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

function archiveSquelch(request: Request): number {
  const requested = Number(request.query.squelch ?? 0)
  return Number.isFinite(requested) ? Math.min(100, Math.max(0, requested)) : 0
}

export function parseQuietingIntensity(value: unknown): number {
  if (typeof value !== 'string' || value.trim() === '') return 100
  const requested = Number(value)
  return Number.isFinite(requested) ? Math.min(100, Math.max(0, requested)) : 100
}

export function archivedPlaybackPcm(
  record: { sampleRate: number; activityStartSeconds?: number; activityEndSeconds?: number },
  wav: Buffer,
  activityOnly: boolean
): Buffer {
  const pcm = wav.subarray(44)
  if (!activityOnly || record.activityStartSeconds === undefined || record.activityEndSeconds === undefined) return pcm
  const bytesPerSecond = record.sampleRate * 2
  const start = Math.max(0, Math.min(pcm.length, Math.floor(record.activityStartSeconds * bytesPerSecond / 2) * 2))
  const end = Math.max(start, Math.min(pcm.length, Math.floor(record.activityEndSeconds * bytesPerSecond / 2) * 2))
  return pcm.subarray(start, end)
}

function ffmpegCleanerOrThrow(runtime: VhfRuntime, cleanup: FfmpegPlaybackCleanup) {
  if (!runtime.denoiser?.available(cleanup)) {
    throw new Error(cleanup === 'rnnoise'
      ? 'RNNoise playback requires FFmpeg and the bundled speech model'
      : 'Adaptive playback cleanup requires FFmpeg')
  }
  return runtime.denoiser
}

function modifiedOr503(getPlayback: () => ModifiedPlayback | undefined, response: Response): ModifiedPlayback | undefined {
  const playback = getPlayback()
  if (!playback) response.status(503).json({ error: 'Modified playback is unavailable; choose Raw' })
  return playback
}

function playbackFailure(response: Response, error: unknown): void {
  if (response.destroyed || response.writableEnded) return
  const status = error instanceof ModifiedPlaybackError ? error.status : 503
  response.status(status).json({ error: error instanceof Error ? error.message : String(error) })
}

function responseAbortSignal(response: Response): AbortSignal {
  const controller = new AbortController()
  response.once('close', () => {
    if (!response.writableEnded) controller.abort(new ModifiedPlaybackError('Modified playback request was cancelled'))
  })
  return controller.signal
}

function sameArchiveSource(left: TranscriptArchiveRecord | undefined, right: TranscriptArchiveRecord): boolean {
  return Boolean(left && right && left.id === right.id && left.startedAt === right.startedAt &&
    left.endedAt === right.endedAt && left.sampleRate === right.sampleRate && left.audioBytes === right.audioBytes)
}

export function registerRoutes(
  router: PluginRouter,
  getRuntime: () => VhfRuntime | undefined,
  getModifiedPlayback?: () => ModifiedPlayback | undefined
): void {
  const fallbackModifiedPlayback = new ModifiedPlayback()
  const getPlayback = getModifiedPlayback ?? (() => fallbackModifiedPlayback)
  const read = router.access('readonly')
  read.get('/api/status', (_request: Request, response: Response) => {
    const runtime = runtimeOr503(getRuntime, response)
    if (runtime) response.set('Cache-Control', 'no-store').json({ ...runtime.status(), uiVersion: UI_VERSION })
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
  read.get('/api/activity', (_request: Request, response: Response) => {
    const runtime = runtimeOr503(getRuntime, response)
    if (runtime) response.set('Cache-Control', 'no-store').json({ events: runtime.activityEvents() })
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
  read.get('/api/transcripts/:id.wav', async (request: Request, response: Response) => {
    const runtime = runtimeOr503(getRuntime, response)
    if (!runtime) return
    const id = Number(request.params.id)
    const record = Number.isSafeInteger(id) && id > 0 ? runtime.transcription.archiveRecord(id) : undefined
    const wav = record ? runtime.transcription.archiveWav(id) : undefined
    if (!record || !wav) {
      response.status(404).json({ error: 'Archived transcript not found' })
      return
    }
    const cleanup = parsePlaybackCleanup(request.query.cleanup)
    const squelch = archiveSquelch(request)
    const activityOnly = request.query.activity === '1'
    const sourcePcm = archivedPlaybackPcm(record, wav, activityOnly)
    let playbackWav: Buffer
    try {
      if (cleanup === 'modified') {
        const playback = modifiedOr503(getPlayback, response)
        if (!playback) return
        const processed = await playback.processPcm(sourcePcm, record.sampleRate, {
          quietingIntensity: parseQuietingIntensity(request.query.quieting),
          cacheKey: `archive:${id}:${activityOnly ? 'activity' : 'full'}:modified-v1`,
          stillCurrent: () => sameArchiveSource(runtime.transcription.archiveRecord(id), record),
          signal: responseAbortSignal(response)
        })
        playbackWav = pcmToWav(processed, record.sampleRate)
      } else if (isFfmpegPlaybackCleanup(cleanup)) {
        const gated = cleanArchivedPlaybackPcm(sourcePcm, record.sampleRate, 'raw', squelch)
        playbackWav = pcmToWav(await ffmpegCleanerOrThrow(runtime, cleanup).processPcm(gated, record.sampleRate, cleanup), record.sampleRate)
      } else {
        playbackWav = cleanup === 'raw' && squelch === 0 && !activityOnly
          ? wav
          : pcmToWav(cleanArchivedPlaybackPcm(sourcePcm, record.sampleRate, cleanup, squelch), record.sampleRate)
      }
    } catch (error) {
      response.status(503).json({ error: error instanceof Error ? error.message : String(error) })
      return
    }
    sendSeekableWav(
      request,
      response,
      playbackWav,
      `vhf-transcript-${record.channel}-${record.startedAt.replace(/[:.]/g, '-')}.wav`,
      'private, max-age=3600'
    )
  })
  read.get('/api/transcript-session.wav', async (request: Request, response: Response) => {
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
    const activityOnly = request.query.activity === '1'
    const sourceChunks = (wavs as Buffer[]).map((wav, index) => archivedPlaybackPcm(resolved[index]!, wav, activityOnly))
    const sourceBytes = sourceChunks.reduce((sum, chunk) => sum + chunk.length, 0)
    if (sourceBytes > 20 * 1024 * 1024) {
      response.status(413).json({ error: 'Modified playback session exceeds the 20 MiB processing limit' })
      return
    }
    const pcm = Buffer.concat(sourceChunks, sourceBytes)
    const cleanup = parsePlaybackCleanup(request.query.cleanup)
    if (cleanup === 'modified') {
      const playback = modifiedOr503(getPlayback, response)
      if (!playback) return
      try {
        const processed = await playback.processPcm(pcm, first.sampleRate, {
          quietingIntensity: parseQuietingIntensity(request.query.quieting),
          cacheKey: `archive-session:${ids!.join(',')}:${activityOnly ? 'activity' : 'full'}:modified-v1`,
          stillCurrent: () => ids!.every((id, index) => sameArchiveSource(runtime.transcription.archiveRecord(id), resolved[index]!)),
          signal: responseAbortSignal(response)
        })
        sendSeekableWav(request, response, pcmToWav(processed, first.sampleRate),
          `vhf-transcript-${first.channel}-session.wav`, 'no-store, private')
      } catch (error) { playbackFailure(response, error) }
      return
    }
    const squelch = archiveSquelch(request)
    try {
      const externalCleanup = isFfmpegPlaybackCleanup(cleanup)
      const gated = cleanArchivedPlaybackPcm(pcm, first.sampleRate, externalCleanup ? 'raw' : cleanup, squelch)
      const playbackPcm = externalCleanup
        ? await ffmpegCleanerOrThrow(runtime, cleanup).processPcm(gated, first.sampleRate, cleanup)
        : gated
      sendSeekableWav(
        request,
        response,
        pcmToWav(playbackPcm, first.sampleRate),
        `vhf-transcript-${first.channel}-session.wav`,
        'no-store, private'
      )
    } catch (error) {
      response.status(503).json({ error: error instanceof Error ? error.message : String(error) })
    }
  })
  read.get('/api/replay/:id.wav', async (request: Request, response: Response) => {
    const runtime = runtimeOr503(getRuntime, response)
    if (!runtime) return
    const id = Number(request.params.id)
    const segment = runtime.replaySegment(id)
    const cleanup = parsePlaybackCleanup(request.query.cleanup)
    const requestedSquelch = Number(request.query.squelch ?? runtime.config.squelch)
    const squelch = cleanup === 'modified' ? 0 : Number.isFinite(requestedSquelch) ? Math.min(100, Math.max(0, requestedSquelch)) : runtime.config.squelch
    const wav = await runtime.replayWavFor(id, squelch)
    if (!segment || !wav) {
      response.status(404).json({ error: 'Replay segment not found' })
      return
    }
    let playbackWav: Buffer
    try {
      if (cleanup === 'modified') {
        const playback = modifiedOr503(getPlayback, response)
        if (!playback) return
        const rawPcm = wav.subarray(44)
        const qualityBytes = segment.qualitySpans.reduce((sum, span) => sum + span.bytes, 0)
        const pcm = await playback.processPcm(rawPcm, runtime.config.sampleRate, {
          quietingIntensity: parseQuietingIntensity(request.query.quieting),
          ...(qualityBytes === rawPcm.length ? { qualitySpans: segment.qualitySpans } : {}),
          cacheKey: `replay:${id}:${segment.startedAt}:${segment.endedAt}:modified-v1`,
          stillCurrent: () => runtime.replayStillCurrent(id, segment.startedAt),
          signal: responseAbortSignal(response)
        })
        playbackWav = pcmToWav(pcm, runtime.config.sampleRate)
      } else if (cleanup === 'raw') playbackWav = wav
      else playbackWav = pcmToWav(
        isFfmpegPlaybackCleanup(cleanup)
          ? await ffmpegCleanerOrThrow(runtime, cleanup).processPcm(wav.subarray(44), runtime.config.sampleRate, cleanup)
          : cleanPlaybackPcm(wav.subarray(44), runtime.config.sampleRate, cleanup),
        runtime.config.sampleRate
      )
    } catch (error) {
      playbackFailure(response, error)
      return
    }
    sendSeekableWav(
      request,
      response,
      playbackWav,
      `vhf-${segment.channel}-${segment.startedAt.replace(/[:.]/g, '-')}.wav`,
      'private, max-age=3600'
    )
  })
  read.get('/api/replay-session.wav', async (request: Request, response: Response) => {
    const runtime = runtimeOr503(getRuntime, response)
    if (!runtime) return
    const ids = requestedIds(request.query.ids, 240)
    const cleanup = parsePlaybackCleanup(request.query.cleanup)
    const requestedSquelch = Number(request.query.squelch ?? runtime.config.squelch)
    const squelch = cleanup === 'modified' ? 0 : Number.isFinite(requestedSquelch) ? Math.min(100, Math.max(0, requestedSquelch)) : runtime.config.squelch
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
    const wavs = valid ? await Promise.all(ids.map((id) => runtime.replayWavFor(id, squelch))) : []
    if (!valid || wavs.some((wav) => !wav)) {
      response.status(400).json({ error: 'Replay session is not a continuous channel recording' })
      return
    }
    if (cleanup === 'modified') {
      const playback = modifiedOr503(getPlayback, response)
      if (!playback) return
      const sourceBytes = (wavs as Buffer[]).reduce((sum, wav) => sum + wav.length - 44, 0)
      if (sourceBytes > 20 * 1024 * 1024) {
        response.status(413).json({ error: 'Modified playback session exceeds the 20 MiB limit' })
        return
      }
      const pcm = Buffer.concat((wavs as Buffer[]).map((wav) => wav.subarray(44)), sourceBytes)
      const qualitySpans = resolved.flatMap((segment) => segment.qualitySpans)
      const alignedQualitySpans = qualitySpans.reduce((sum, span) => sum + span.bytes, 0) === pcm.length
        ? qualitySpans
        : undefined
      try {
        const processed = await playback.processPcm(pcm, runtime.config.sampleRate, {
          quietingIntensity: parseQuietingIntensity(request.query.quieting),
          ...(alignedQualitySpans ? { qualitySpans: alignedQualitySpans } : {}),
          cacheKey: `replay-session:${ids!.join(',')}:${first.slot}:${first.channel}:modified-v1`,
          stillCurrent: () => ids!.every((id, index) => runtime.replayStillCurrent(id, resolved[index]!.startedAt)),
          signal: responseAbortSignal(response)
        })
        sendSeekableWav(request, response, pcmToWav(processed, runtime.config.sampleRate),
          `vhf-${first.channel}-session.wav`, 'no-store, private')
      } catch (error) { playbackFailure(response, error) }
      return
    }
    const pcm = Buffer.concat((wavs as Buffer[]).map((wav) => wav.subarray(44)))
    try {
      const playbackPcm = isFfmpegPlaybackCleanup(cleanup)
        ? await ffmpegCleanerOrThrow(runtime, cleanup).processPcm(pcm, runtime.config.sampleRate, cleanup)
        : cleanPlaybackPcm(pcm, runtime.config.sampleRate, cleanup)
      sendSeekableWav(
        request,
        response,
        pcmToWav(playbackPcm, runtime.config.sampleRate),
        `vhf-${first.channel}-session.wav`,
        'no-store, private'
      )
    } catch (error) {
      response.status(503).json({ error: error instanceof Error ? error.message : String(error) })
    }
  })
  read.get('/api/replay/:id/continuous.wav', async (request: Request, response: Response) => {
    const runtime = runtimeOr503(getRuntime, response)
    if (!runtime) return
    const id = Number(request.params.id)
    const segment = runtime.replaySegment(id)
    const cleanup = parsePlaybackCleanup(request.query.cleanup)
    if (cleanup === 'modified') {
      const playback = modifiedOr503(getPlayback, response)
      if (!playback) return
      const initialCursor = runtime.replayPlaybackCursorFrom(id)
      if (!segment || !initialCursor) {
        response.status(404).json({ error: 'Replay segment not found' })
        return
      }
      let cursor: ReplayPlaybackCursor = initialCursor
      const abort = new AbortController()
      response.once('close', () => { if (!response.writableEnded) abort.abort() })
      let stream
      try { stream = await playback.openStream(runtime.config.sampleRate, abort.signal, parseQuietingIntensity(request.query.quieting)) }
      catch (error) { playbackFailure(response, error); return }
      if (response.destroyed) { stream.close(); return }
      const event = segment.slot === 'A' ? 'rawAudio' : 'rawSlotBAudio'
      let tailing = false
      let inputBlocked = false
      let inputEnded = false
      let stopped = false
      let endSent = false
      let detached = false
      let joined = false
      let payload: ReplayPlaybackPayload | undefined
      let pendingBytes = 0
      const pendingLive: { pcm: Buffer; noise: number }[] = []
      const detach = (): void => {
        if (detached) return
        detached = true
        runtime.off(event, onRawAudio)
        if (joined) { joined = false; runtime.listenerLeft() }
      }
      const stopStream = (): void => {
        if (stopped) return
        stopped = true
        inputEnded = true
        detach()
        abort.abort()
        stream.close()
      }
      const endInput = (): void => {
        if (inputEnded) return
        inputEnded = true
        detach()
        if (tailing) flushLive()
        else if (!endSent) { endSent = true; stream.end() }
      }
      const waitDrain = async (): Promise<void> => {
        inputBlocked = true
        await Promise.race([
          new Promise<void>((resolve) => stream.onDrain(resolve)),
          stream.completion.then((exit) => {
            throw new Error(exit.stderr || exit.error?.message || `GTCRN playback helper exited ${exit.code} before input drained`)
          })
        ])
        inputBlocked = false
      }
      const flushLive = (): void => {
        if (!tailing || stopped || inputBlocked) return
        while (pendingLive.length > 0) {
          const next = pendingLive.shift()!
          pendingBytes -= next.pcm.length
          if (!stream.write(next.pcm, next.noise)) {
            inputBlocked = true
            stream.onDrain(() => { inputBlocked = false; flushLive() })
            return
          }
        }
        if (inputEnded && !endSent) { endSent = true; stream.end() }
      }
      const onRawAudio = (chunk: Buffer, noise: number): void => {
        if (inputEnded || stopped || response.destroyed) return
        if (!runtime.canTailPlaybackCursor(cursor)) { endInput(); return }
        if (inputBlocked) {
          pendingLive.push({ pcm: Buffer.from(chunk), noise })
          pendingBytes += chunk.length
          if (pendingBytes + stream.bufferedBytes > runtime.config.sampleRate * 2 * 2) {
            stopStream()
            response.destroy(new Error('Modified replay fell more than two seconds behind live audio'))
          }
          return
        }
        if (!stream.write(chunk, noise)) {
          inputBlocked = true
          stream.onDrain(() => { inputBlocked = false; flushLive() })
        }
      }
      const enterTail = (): boolean => {
        if (!runtime.canTailPlaybackCursor(cursor)) { endInput(); return true }
        runtime.on(event, onRawAudio)
        detached = false
        runtime.listenerJoined()
        joined = true
        // If an append beat listener registration, leave it to the durable cursor
        // rather than feeding the same audio twice from the temporary live queue.
        if (runtime.replayPlaybackCursorHasData(cursor)) {
          pendingLive.length = 0
          pendingBytes = 0
          detach()
          const successor = runtime.replayPlaybackCursorSuccessor(cursor)
          if (successor) { cursor = successor; payload = undefined }
          return false
        }
        tailing = true
        if (inputBlocked) stream.onDrain(() => { inputBlocked = false; flushLive() })
        return true
      }
      response.status(200).set({
        'Content-Type': 'audio/wav', 'Cache-Control': 'no-store, private',
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': `inline; filename="vhf-${segment.channel}-continuous.wav"`
      })
      response.flushHeaders()
      response.write(wavHeader(runtime.config.sampleRate, 0xffff_ff00))
      stream.stdout.on('data', (chunk: Buffer) => {
        if (!response.destroyed && !response.write(chunk)) stream.stdout.pause()
      })
      response.on('drain', () => stream.stdout.resume())
      let stdoutEnded = false
      let completionSeen = false
      const maybeFinishResponse = (): void => {
        if (stdoutEnded && completionSeen && !response.destroyed && !response.writableEnded) response.end()
      }
      stream.stdout.on('error', (error) => {
        stopStream()
        if (!response.destroyed) response.destroy(error)
      })
      stream.stdout.on('end', () => { stdoutEnded = true; maybeFinishResponse() })
      void stream.completion.then((exit) => {
        completionSeen = true
        if (exit.code !== 0 || exit.error) {
          const error = new Error(exit.stderr || exit.error?.message || `GTCRN playback helper exited ${exit.code}`)
          if (!response.destroyed) response.destroy(error)
          stopStream()
        } else maybeFinishResponse()
      })
      response.on('close', stopStream)
      try {
        while (!inputEnded && !stopped) {
          const next = await runtime.replayPlaybackCursorRead(cursor, 64_000, payload)
          if (inputEnded || stopped) return
          if (next.kind === 'end') {
            if (next.reason === 'retired') throw new Error('Replay data expired before Modified playback reached it')
            if (next.reason === 'decode-failed') throw new Error('A replay segment could not be decoded')
            endInput()
            return
          }
          if (next.kind === 'chunk') {
            cursor = next.cursor
            payload = next.payload
            const parts: { pcm: Buffer; noise?: number }[] = []
            if (next.qualitySpans) {
              let offset = 0
              for (const span of next.qualitySpans) {
                const end = offset + span.bytes
                for (let at = offset; at < end; at += 64_000) {
                  parts.push({ pcm: next.pcm.subarray(at, Math.min(end, at + 64_000)), noise: span.discriminatorNoise })
                }
                offset = end
              }
            } else parts.push({ pcm: next.pcm })
            for (let index = 0; index < parts.length; index += 1) {
              const part = parts[index]!
              const writable = stream.write(part.pcm, part.noise)
              if (!writable) inputBlocked = true
              if (index === parts.length - 1 && next.after) {
                if (next.after.kind === 'advance') { cursor = next.after.cursor; payload = undefined }
                else if (next.after.kind === 'channel-change') endInput()
                else if (enterTail()) return
              }
              if (!writable) await waitDrain()
              if (inputEnded || stopped || tailing) return
            }
            continue
          }
          if (next.kind === 'advance') { cursor = next.cursor; payload = undefined; continue }
          if (enterTail()) return
        }
      } catch (error) {
        stopStream()
        if (!response.destroyed) response.destroy(error instanceof Error ? error : new Error(String(error)))
      }
      return
    }
    const requestedSquelch = Number(request.query.squelch ?? runtime.config.squelch)
    const squelch = Number.isFinite(requestedSquelch) ? Math.min(100, Math.max(0, requestedSquelch)) : runtime.config.squelch
    const chunks = runtime.replayPcmFrom(id, squelch)
    if (!segment || !chunks) {
      response.status(404).json({ error: 'Replay segment not found' })
      return
    }
    let denoiseStream: ReturnType<NonNullable<typeof runtime.denoiser>['createPcmStream']> | undefined
    try {
      if (isFfmpegPlaybackCleanup(cleanup)) {
        denoiseStream = ffmpegCleanerOrThrow(runtime, cleanup).createPcmStream(runtime.config.sampleRate, cleanup)
      }
    } catch (error) {
      response.status(503).json({ error: error instanceof Error ? error.message : String(error) })
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
    if (denoiseStream) {
      const event = segment.slot === 'A' ? 'rawAudio' : 'rawSlotBAudio'
      denoiseStream.stdout.on('data', (chunk: Buffer) => { if (!response.destroyed) response.write(chunk) })
      denoiseStream.on('close', () => { if (!response.destroyed) response.end() })
      denoiseStream.on('error', () => { if (!response.destroyed) response.end() })
      for await (const chunk of chunks) denoiseStream.stdin.write(chunk)
      if (!runtime.canTailReplay(id)) {
        denoiseStream.stdin.end()
        return
      }
      const onRawAudio = (chunk: Buffer, discriminatorNoise: number): void => {
        if (response.destroyed || denoiseStream.stdin.destroyed) return
        const open = discriminatorNoise < discriminatorThreshold(squelch)
        denoiseStream.stdin.write(open ? chunk : Buffer.alloc(chunk.length))
      }
      runtime.on(event, onRawAudio)
      request.on('close', () => {
        runtime.off(event, onRawAudio)
        denoiseStream.stdin.destroy()
        denoiseStream.kill('SIGTERM')
      })
      return
    }
    const cleaner = new PlaybackCleaner(runtime.config.sampleRate, cleanup)
    for await (const chunk of chunks) response.write(cleaner.process(chunk))
    if (!runtime.canTailReplay(id)) {
      response.end()
      return
    }
    const event = segment.slot === 'A' ? 'rawAudio' : 'rawSlotBAudio'
    const onRawAudio = (chunk: Buffer, discriminatorNoise: number): void => {
      if (response.destroyed) return
      const open = discriminatorNoise < discriminatorThreshold(squelch)
      response.write(cleaner.process(open ? chunk : Buffer.alloc(chunk.length)))
    }
    runtime.on(event, onRawAudio)
    request.on('close', () => {
      runtime.off(event, onRawAudio)
      if (!response.destroyed) response.end()
    })
  })
  read.get('/api/live.wav', async (request: Request, response: Response) => {
    const runtime = runtimeOr503(getRuntime, response)
    if (!runtime) return
    const cleanup = parsePlaybackCleanup(request.query.cleanup)
    if (cleanup === 'modified') {
      const playback = modifiedOr503(getPlayback, response)
      if (!playback) return
      const abort = new AbortController()
      response.once('close', () => { if (!response.writableEnded) abort.abort() })
      let stream
      try { stream = await playback.openStream(runtime.config.sampleRate, abort.signal, parseQuietingIntensity(request.query.quieting)) }
      catch (error) { playbackFailure(response, error); return }
      if (response.destroyed) { stream.close(); return }
      let inputEnded = false
      let stopped = false
      let blocked = false
      let endSent = false
      let queuedBytes = 0
      const queued: { pcm: Buffer; noise?: number }[] = []
      const event = runtime.config.receiverMode === 'rtl_sdr' ? 'rawAudio' : 'audio'
      const sourceChannel = runtime.status().channel.id
      const detach = (): void => {
        runtime.off('audio', onAudio)
        runtime.off('rawAudio', onRawAudio)
      }
      const stop = (): void => {
        if (stopped) return
        stopped = true
        inputEnded = true
        detach()
        abort.abort()
        stream.close()
      }
      const endInput = (): void => {
        if (inputEnded) return
        inputEnded = true
        detach()
        flush()
      }
      const flush = (): void => {
        if (stopped || blocked) return
        while (queued.length) {
          const next = queued.shift()!
          queuedBytes -= next.pcm.length
          if (!stream.write(next.pcm, next.noise)) {
            blocked = true
            stream.onDrain(() => { blocked = false; flush() })
            return
          }
        }
        if (inputEnded && !endSent) { endSent = true; stream.end() }
      }
      const submit = (pcm: Buffer, noise?: number): void => {
        if (inputEnded || stopped || response.destroyed) return
        if (runtime.status().channel.id !== sourceChannel) { endInput(); return }
        if (blocked) {
          queued.push({ pcm: Buffer.from(pcm), noise })
          queuedBytes += pcm.length
          if (queuedBytes + stream.bufferedBytes > runtime.config.sampleRate * 2 * 2) {
            stop()
            response.destroy(new Error('Modified live playback fell more than two seconds behind the receiver'))
          }
          return
        }
        if (!stream.write(pcm, noise)) {
          blocked = true
          stream.onDrain(() => { blocked = false; flush() })
        }
      }
      const onAudio = (chunk: Buffer): void => submit(chunk)
      const onRawAudio = (chunk: Buffer, noise: number): void => submit(chunk, noise)
      response.status(200).set({
        'Content-Type': 'audio/wav', 'Cache-Control': 'no-store, private',
        'X-Content-Type-Options': 'nosniff'
      })
      response.flushHeaders()
      response.write(wavHeader(runtime.config.sampleRate, 0xffff_ff00))
      stream.stdout.on('data', (chunk: Buffer) => { if (!response.destroyed && !response.write(chunk)) stream.stdout.pause() })
      response.on('drain', () => stream.stdout.resume())
      stream.stdout.on('end', () => { if (!response.destroyed) response.end() })
      stream.stdout.on('error', stop)
      response.on('close', stop)
      runtime.on(event, event === 'audio' ? onAudio : onRawAudio)
      runtime.listenerJoined()
      response.once('close', () => runtime.listenerLeft())
      return
    }
    let denoiseStream: ReturnType<NonNullable<typeof runtime.denoiser>['createPcmStream']> | undefined
    try {
      if (isFfmpegPlaybackCleanup(cleanup)) {
        denoiseStream = ffmpegCleanerOrThrow(runtime, cleanup).createPcmStream(runtime.config.sampleRate, cleanup)
      }
    } catch (error) {
      response.status(503).json({ error: error instanceof Error ? error.message : String(error) })
      return
    }
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
    const cleaner = new PlaybackCleaner(runtime.config.sampleRate, cleanup)
    if (denoiseStream) {
      denoiseStream.stdout.on('data', (chunk: Buffer) => { if (!response.destroyed) response.write(chunk) })
      denoiseStream.on('close', () => { if (!response.destroyed) response.end() })
      denoiseStream.on('error', () => { if (!response.destroyed) response.end() })
    }
    const onAudio = (chunk: Buffer): void => {
      if (response.destroyed) return
      if (denoiseStream && !denoiseStream.stdin.destroyed) denoiseStream.stdin.write(chunk)
      else response.write(cleaner.process(chunk))
    }
    const onRawAudio = (chunk: Buffer, discriminatorNoise: number): void => {
      if (response.destroyed) return
      const open = discriminatorNoise < discriminatorThreshold(squelch)
      const gated = open ? chunk : Buffer.alloc(chunk.length)
      if (denoiseStream && !denoiseStream.stdin.destroyed) denoiseStream.stdin.write(gated)
      else response.write(cleaner.process(gated))
    }
    if (runtime.config.receiverMode === 'rtl_sdr') runtime.on('rawAudio', onRawAudio)
    else runtime.on('audio', onAudio)
    runtime.listenerJoined()
    request.on('close', () => {
      runtime.off('audio', onAudio)
      runtime.off('rawAudio', onRawAudio)
      runtime.listenerLeft()
      denoiseStream?.stdin.destroy()
      denoiseStream?.kill('SIGTERM')
      if (!response.destroyed) response.end()
    })
  })

  // Tuning changes only the receive-only SDR session. Keep it usable from the
  // bundled webapp with normal read access; destructive and durable processing
  // controls below continue to require read/write authorization.
  const tune = router.access('readonly')
  tune.post('/api/channel', (request: Request, response: Response) => {
    const runtime = runtimeOr503(getRuntime, response)
    if (!runtime) return
    try {
      const channel = String((request.body as { channel?: unknown } | undefined)?.channel ?? '')
      response.json(runtime.tune(channel))
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : String(error) })
    }
  })
  tune.post('/api/slots', (request: Request, response: Response) => {
    const runtime = runtimeOr503(getRuntime, response)
    if (!runtime) return
    try {
      const body = request.body as { mode?: unknown; slotAChannel?: unknown; slotBMode?: unknown; slotBChannel?: unknown } | undefined
      const mode = String(body?.mode ?? '')
      if (mode !== 'fixed' && mode !== 'scan') throw new Error('Slot A mode must be fixed or scan')
      const slotBMode = String(body?.slotBMode ?? 'fixed')
      if (slotBMode !== 'fixed' && slotBMode !== 'scan') throw new Error('Slot B mode must be fixed or scan')
      response.json(runtime.configureSlots(mode, String(body?.slotAChannel ?? ''), slotBMode, String(body?.slotBChannel ?? '')))
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : String(error) })
    }
  })
  tune.post('/api/region', (request: Request, response: Response) => {
    const runtime = runtimeOr503(getRuntime, response)
    if (!runtime) return
    try {
      const region = String((request.body as { region?: unknown } | undefined)?.region ?? '') as ChannelRegion
      response.json(runtime.setRegion(region))
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : String(error) })
    }
  })
  const write = router.access('readwrite')
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
      '/api/activity': { get: { summary: 'List bounded whole-band RF activity events', responses: { '200': { description: 'Spectrum activity' } } } },
      '/api/replay/{id}': { delete: { summary: 'Delete one private rolling replay segment', responses: { '204': { description: 'Deleted' }, '404': { description: 'Not found' } } } },
      '/api/replay/{id}.wav': { get: { summary: 'Play one replay segment', responses: { '200': { description: 'WAV audio' } } } },
      '/api/replay/{id}/continuous.wav': { get: { summary: 'Play seamless replay through the live edge', responses: { '200': { description: 'Streaming WAV audio' } } } },
      '/api/replay-session.wav': { get: { summary: 'Play one stitched historical radio session', responses: { '200': { description: 'WAV audio' } } } },
      '/api/transcripts': { get: { summary: 'List retained voice transcripts and metadata', responses: { '200': { description: 'Transcript archive' } } } },
      '/api/transcripts/{id}.wav': { get: { summary: 'Play an archived voice record', responses: { '200': { description: 'WAV audio' }, '404': { description: 'Not found' } } } },
      '/api/transcript-session.wav': { get: { summary: 'Play one stitched archived transcript session', responses: { '200': { description: 'WAV audio' } } } },
      '/api/live.wav': { get: { summary: 'Listen to the live receive-only PCM stream', responses: { '200': { description: 'Streaming WAV audio' } } } },
      '/api/dsc': {
        get: { summary: 'List decoded DSC Channel 70 calls', responses: { '200': { description: 'DSC calls' } } },
        delete: { summary: 'Clear decoded DSC calls', responses: { '204': { description: 'Cleared' } } }
      },
      '/api/channel': { post: { summary: 'Tune the receive channel', responses: { '200': { description: 'Updated status' } } } },
      '/api/slots': { post: { summary: 'Configure both receiver slots and their fixed or scan modes', responses: { '200': { description: 'Updated status' } } } },
      '/api/region': { post: { summary: 'Select the US, Canadian, or combined channel plan', responses: { '200': { description: 'Updated status' } } } },
      '/api/transcription': { post: { summary: 'Durably enable or disable local voice transcription', responses: { '200': { description: 'Updated status' } } } }
    }
  }
}
