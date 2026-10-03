(() => {
  const MODEL = 'onnx-community/whisper-large-v3-turbo'
  const REVISION = '2f3ff544dec10f61ab7bcc7ba538766300ab5f91'
  const DTYPE = { encoder_model: 'fp16', decoder_model_merged: 'q4f16' }
  const STORAGE_KEY = 'vhf-watch-client-transcription-v1'
  const params = new URLSearchParams(location.search)
  const fixtureUrl = params.get('fixture')
  const requestedId = params.get('id')
  const isFixture = Boolean(fixtureUrl)
  const apiBase = new URL('../plugins/signalk-vhf-watch/api/', location.href).pathname
  const el = (id) => document.getElementById(id)
  const picker = el('record-select')
  const baseline = el('baseline')
  const enhanced = el('enhanced')
  const status = el('status')
  const metadata = el('source-metadata')
  const compareButton = el('compare')
  const exportOneButton = el('export-one')
  const exportAllButton = el('export-all')
  const evidence = el('evidence')
  const dwell = new window.ClientTranscriptionLifecycle.DwellGate(5000)
  const records = new Map()
  const completed = new Map()
  let worker
  let activeJob
  let queuedAuto = false
  let selected
  let serial = 0
  let fixtureSource
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(location.hostname)
  const err = (value) => value instanceof Error ? value.message : String(value)
  const parseMs = (value) => {
    if (typeof value === 'number') return value
    const result = Date.parse(value)
    return Number.isFinite(result) ? result : undefined
  }
  const normalize = (r) => {
    const start = r.started_ms ?? parseMs(r.startedAt)
    const end = r.ended_ms ?? parseMs(r.endedAt)
    return {
      ...r, id: String(r.id), started_ms: start, ended_ms: end,
      transcript: String(r.transcript || ''),
      duration_seconds: Number(r.duration_seconds ?? r.durationSeconds ?? ((end - start) / 1000) ?? 0),
      sample_rate: Number(r.sample_rate ?? r.sampleRate ?? 0),
      sha256: r.sha256 || r.audio_sha256 || '',
      audioUrl: r.audioUrl || apiBase + 'transcripts/' + encodeURIComponent(r.id) + '.wav?cleanup=raw&squelch=0'
    }
  }
  const cacheKey = (r) => JSON.stringify([r.id, r.started_ms, r.ended_ms, r.sha256, MODEL, REVISION, 'transformers.js@3.8.1', DTYPE, 'en', 'transcribe', 30, 5])
  const readCache = () => { try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') } catch { return {} } }
  const saveCache = (item) => {
    const cache = readCache()
    cache[item.cacheKey] = item
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(Object.entries(cache).slice(-40)))) } catch {}
  }
  const cached = () => selected ? readCache()[cacheKey(selected)] : undefined
  const showMetadata = (r) => {
    metadata.replaceChildren()
    const rows = [
      ['Record', '#' + r.id], ['Channel', r.channel ?? '—'],
      ['Started', r.started_ms ? new Date(r.started_ms).toLocaleString() : 'unknown'],
      ['Duration', Number(r.duration_seconds || 0).toFixed(1) + ' s'],
      ['Sample rate', r.sample_rate ? r.sample_rate + ' Hz' : '—'],
      ['Audio SHA-256', r.sha256 || 'not supplied']
    ]
    for (const [name, value] of rows) {
      const wrap = document.createElement('div')
      const term = document.createElement('dt')
      const detail = document.createElement('dd')
      term.textContent = name
      detail.textContent = String(value)
      wrap.append(term, detail)
      metadata.append(wrap)
    }
  }
  const makeEvidence = (r, text, metrics, gpuInfo) => ({
    source: {
      id: r.id, channel: r.channel, durationSeconds: r.duration_seconds,
      sampleRate: r.sample_rate, startedMs: r.started_ms, endedMs: r.ended_ms,
      activityStartSeconds: r.activity_start_seconds ?? r.activityStartSeconds,
      activityEndSeconds: r.activity_end_seconds ?? r.activityEndSeconds,
      sha256: r.sha256 || undefined, baselineTranscript: r.transcript
    },
    transcript: text, metrics, gpuInfo, model: MODEL, modelRevision: REVISION,
    runtime: 'Transformers.js 3.8.1', dtype: DTYPE, language: 'English', task: 'transcribe',
    chunkLengthSeconds: 30, strideLengthSeconds: 5,
    sourceKind: isFixture ? 'local fixture' : 'Signal K archive',
    completedAt: new Date().toISOString(), cacheKey: cacheKey(r)
  })
  const evidenceRows = () => [...completed.values()]
  const refreshEvidence = () => {
    evidence.value = JSON.stringify({
      exportedAt: new Date().toISOString(),
      source: isFixture ? fixtureSource : 'Signal K archive API',
      results: evidenceRows()
    }, null, 2)
    exportAllButton.disabled = completed.size === 0
    const list = el('completed-results')
    list.replaceChildren()
    for (const item of completed.values()) {
      const row = document.createElement('li')
      row.textContent = '#' + item.source.id + ' · ' + (item.source.channel || 'channel ?') +
        ' · ' + item.metrics.audioSeconds.toFixed(1) + 's · model ' +
        item.metrics.modelLoadMs.toFixed(0) + 'ms · inference ' +
        item.metrics.inferenceMs.toFixed(0) + 'ms · ' + item.transcript
      list.append(row)
    }
  }
  const downloadJson = (value, filename) => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const workerReady = () => {
    if (!worker) {
      const instance = new Worker(new URL('./client-transcription.bundle.js', document.baseURI), { type: 'module' })
      worker = instance
      instance.addEventListener('message', (event) => {
        if (worker === instance) onWorkerMessage(event)
      })
      worker.addEventListener('error', (event) => {
        if (worker !== instance) return
        status.textContent = 'Worker error · ' + (event.message || 'local transcription failed')
        activeJob = undefined
        queuedAuto = false
        instance.terminate()
        worker = undefined
        compareButton.disabled = false
      })
    }
    return worker
  }
  const cancelActive = (message) => {
    dwell.cancel()
    queuedAuto = false
    if (!activeJob) return
    activeJob = undefined
    worker?.terminate()
    worker = undefined
    status.textContent = message
  }
  const runCompare = (automatic) => {
    if (!selected || document.visibilityState !== 'visible') return
    if (activeJob) {
      queuedAuto = queuedAuto || automatic
      status.textContent = 'Finishing current device run before the next recording.'
      return
    }
    const prior = cached()
    if (prior) {
      enhanced.textContent = prior.transcript || '[No speech recognized by this model]'
      status.textContent = 'Cached local result · inference ' + prior.metrics.inferenceMs.toFixed(0) + ' ms'
      exportOneButton.disabled = false
      return
    }
    if (!navigator.gpu) {
      status.textContent = 'WebGPU is unavailable. The onboard transcript remains available above.'
      return
    }
    const id = selected.id + ':' + (++serial)
    activeJob = { id, record: selected }
    exportOneButton.disabled = true
    compareButton.disabled = true
    status.textContent = automatic ? 'Loading local model and recording after 5 seconds visible…' : 'Loading local model and recording…'
    workerReady().postMessage({ type: 'run', id, audioUrl: selected.audioUrl })
  }
  const scheduleDwell = () => {
    dwell.cancel()
    if (!selected || document.visibilityState !== 'visible') return
    const key = cacheKey(selected)
    const prior = cached()
    if (prior) {
      enhanced.textContent = prior.transcript || '[No speech recognized by this model]'
      status.textContent = 'Cached local result · inference ' + prior.metrics.inferenceMs.toFixed(0) + ' ms'
      exportOneButton.disabled = false
      return
    }
    status.textContent = 'Waiting 5 seconds with this recording selected and visible…'
    dwell.reset(key, () => {
      if (selected && cacheKey(selected) === key && document.visibilityState === 'visible') runCompare(true)
    })
  }
  function onWorkerMessage(event) {
    const data = event.data
    if (data?.type === 'gpu' && activeJob?.id === data.id) { activeJob.gpuInfo = data.info; return }
    if (data?.type === 'status' && activeJob?.id === data.id) { status.textContent = data.message; return }
    if (data?.type === 'canceled' && activeJob?.id === data.id) {
      activeJob = undefined
      if (queuedAuto && selected) { queuedAuto = false; runCompare(true) }
      return
    }
    if (data?.type === 'error' && activeJob?.id === data.id) {
      activeJob = undefined
      status.textContent = 'Could not compare on this device · ' + data.error
      worker?.terminate()
      worker = undefined
      compareButton.disabled = false
      return
    }
    if (data?.type !== 'result' || activeJob?.id !== data.id) return
    const job = activeJob
    activeJob = undefined
    const result = makeEvidence(job.record, data.text, data.metrics, job.gpuInfo || {})
    completed.set(cacheKey(job.record), result)
    saveCache({
      cacheKey: cacheKey(job.record), transcript: data.text, metrics: data.metrics,
      gpuInfo: job.gpuInfo || {}, completedAt: result.completedAt
    })
    enhanced.textContent = data.text || '[No speech recognized by this model]'
    status.textContent = 'Complete · ' + data.metrics.audioSeconds.toFixed(1) + ' s audio · model load this run ' +
      data.metrics.modelLoadThisRunMs.toFixed(0) + ' ms' + (data.metrics.modelWasCached ? ' (cached; initial ' + data.metrics.modelLoadMs.toFixed(0) + ' ms)' : '') +
      ' · inference ' + data.metrics.inferenceMs.toFixed(0) + ' ms'
    exportOneButton.disabled = false
    compareButton.disabled = false
    refreshEvidence()
    if (queuedAuto && selected) { queuedAuto = false; runCompare(true) }
  }
  const selectRecord = (id, initial = false) => {
    const record = records.get(String(id))
    if (!record || (!initial && selected?.id === record.id)) return
    if (!initial) cancelActive('Selection changed. Previous on-device work stopped; its result was discarded.')
    selected = record
    picker.value = record.id
    el('source-audio').src = record.audioUrl
    el('download-audio').href = record.audioUrl
    baseline.textContent = record.transcript || '[No onboard transcript]'
    enhanced.textContent = 'Waiting to compare.'
    showMetadata(record)
    const prior = cached()
    if (prior) {
      completed.set(cacheKey(record), makeEvidence(record, prior.transcript, prior.metrics, prior.gpuInfo))
      enhanced.textContent = prior.transcript || '[No speech recognized by this model]'
      status.textContent = 'Cached local result · inference ' + prior.metrics.inferenceMs.toFixed(0) + ' ms'
      exportOneButton.disabled = false
      refreshEvidence()
    } else {
      exportOneButton.disabled = true
      scheduleDwell()
    }
    compareButton.disabled = document.visibilityState !== 'visible'
  }
  const populate = (items) => {
    const options = []
    for (const source of items) {
      const r = normalize(source)
      if (!r.id || r.id === 'undefined') continue
      records.set(r.id, r)
      const option = document.createElement('option')
      option.value = r.id
      option.textContent = '#' + r.id + ' · ' + (r.channel || 'channel ?') + ' · ' + r.duration_seconds.toFixed(1) + ' s'
      options.push(option)
    }
    picker.replaceChildren(...options)
    picker.disabled = !options.length
    if (!options.length) throw new Error('No recordings were found')
    selectRecord(requestedId && records.has(String(requestedId)) ? requestedId : options[0].value, true)
  }
  const load = async () => {
    if (fixtureUrl) {
      if (!loopback) throw new Error('Fixtures are allowed only on localhost, 127.0.0.1, or ::1')
      const url = new URL(fixtureUrl, location.href)
      if (url.origin !== location.origin) throw new Error('Fixture manifest must use this local origin')
      fixtureSource = url.href
      const response = await fetch(url, { cache: 'no-store' })
      if (!response.ok) throw new Error('Fixture manifest returned ' + response.status)
      const manifest = await response.json()
      for (const r of manifest.records || []) {
        const audio = new URL(r.audioUrl, url)
        if (audio.origin !== location.origin) throw new Error('Fixture audio must use this local origin')
        r.audioUrl = audio.href
      }
      populate(manifest.records || [])
      return
    }
    const response = await fetch(apiBase + 'transcripts?limit=500', { credentials: 'include', cache: 'no-store' })
    if (!response.ok) throw new Error('Archive is unavailable (' + response.status + ')')
    const archive = await response.json()
    populate(archive.records || [])
  }
  picker.addEventListener('change', () => selectRecord(picker.value))
  compareButton.addEventListener('click', () => runCompare(false))
  exportOneButton.addEventListener('click', () => {
    const item = [...completed.values()].find((value) => value.source.id === selected?.id)
    if (item) downloadJson(item, 'vhf-transcript-' + selected.id + '-device-result.json')
  })
  exportAllButton.addEventListener('click', () => downloadJson({
    exportedAt: new Date().toISOString(), source: isFixture ? fixtureSource : 'Signal K archive API',
    results: evidenceRows()
  }, 'vhf-device-transcript-evaluation.json'))
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') {
      dwell.cancel()
      if (activeJob) cancelActive('Page hidden. Active on-device work was stopped.')
      return
    }
    if (selected && !cached()) scheduleDwell()
    compareButton.disabled = !selected
  })
  window.addEventListener('pagehide', () => {
    dwell.cancel()
    activeJob = undefined
    worker?.terminate()
    worker = undefined
  })
  window.addEventListener('pageshow', () => {
    if (selected && !cached()) scheduleDwell()
  })
  el('provenance').textContent = JSON.stringify({
    model: MODEL, revision: REVISION, runtime: 'Transformers.js 3.8.1 bundled locally',
    backend: 'WebGPU only; no CPU fallback', dtype: DTYPE, language: 'English',
    task: 'transcribe', chunkLengthSeconds: 30, strideLengthSeconds: 5,
    modelFiles: 'Fetched from Hugging Face and cached by the browser'
  }, null, 2)
  load().catch((error) => { status.textContent = 'Unable to load recording · ' + err(error) })
})()
