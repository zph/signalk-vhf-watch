import { env, pipeline } from '@huggingface/transformers'

const MODEL_ID = 'onnx-community/whisper-large-v3-turbo'
const MODEL_REVISION = '2f3ff544dec10f61ab7bcc7ba538766300ab5f91'
const DTYPE = { encoder_model: 'fp16', decoder_model_merged: 'q4f16' }
let transcriber
let modelLoadMs = 0
let gpuInfo
let activeId
let audioController

env.allowLocalModels = false
env.allowRemoteModels = true
env.useBrowserCache = true
env.backends.onnx.wasm.wasmPaths = new URL('./client-transcription-assets/', import.meta.url).href
env.backends.onnx.wasm.numThreads = 1

function status(id, message, extra = {}) {
  self.postMessage({ type: 'status', id, message, ...extra })
}

function reportCanceled(id) {
  self.postMessage({ type: 'canceled', id })
}

function wavToAudio(bytes) {
  const view = new DataView(bytes)
  if (view.byteLength < 44 || view.getUint32(0, false) !== 0x52494646 || view.getUint32(8, false) !== 0x57415645) {
    throw new Error('Audio is not a RIFF/WAVE file')
  }
  let offset = 12
  let format
  let channels
  let sampleRate
  let bits
  let dataOffset
  let dataLength
  while (offset + 8 <= view.byteLength) {
    const size = view.getUint32(offset + 4, true)
    const end = offset + 8 + size
    if (end > view.byteLength) throw new Error('WAV chunk extends beyond the audio file')
    const tag = view.getUint32(offset, false)
    if (tag === 0x666d7420) {
      format = view.getUint16(offset + 8, true)
      channels = view.getUint16(offset + 10, true)
      sampleRate = view.getUint32(offset + 12, true)
      bits = view.getUint16(offset + 22, true)
    } else if (tag === 0x64617461) {
      dataOffset = offset + 8
      dataLength = size
      break
    }
    offset = end + (size % 2)
  }
  if (format !== 1 || bits !== 16 || !channels || !sampleRate || dataOffset === undefined) {
    throw new Error('Expected PCM16 WAV audio')
  }
  const frames = Math.floor(dataLength / (2 * channels))
  if (!frames) throw new Error('WAV audio contains no samples')
  const mono = new Float32Array(frames)
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0
    for (let channel = 0; channel < channels; channel += 1) {
      sum += view.getInt16(dataOffset + (frame * channels + channel) * 2, true) / 32768
    }
    mono[frame] = sum / channels
  }
  if (sampleRate === 16000) return { audio: mono, sampleRate }
  const outputLength = Math.round(frames * 16000 / sampleRate)
  const resampled = new Float32Array(outputLength)
  const ratio = sampleRate / 16000
  for (let i = 0; i < outputLength; i += 1) {
    const source = i * ratio
    const left = Math.floor(source)
    const right = Math.min(frames - 1, left + 1)
    const blend = source - left
    resampled[i] = mono[left] * (1 - blend) + mono[right] * blend
  }
  return { audio: resampled, sampleRate: 16000 }
}

async function ensurePipeline(id) {
  if (!navigator.gpu) throw new Error('WebGPU is unavailable in this browser')
  if (!gpuInfo) {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
    if (!adapter) throw new Error('No WebGPU adapter is available')
    if (!adapter.features?.has('shader-f16')) throw new Error('This GPU does not support shader-f16, required by the selected fp16 encoder')
    const rawInfo = adapter.info || (typeof adapter.requestAdapterInfo === 'function' ? await adapter.requestAdapterInfo() : {})
    gpuInfo = Object.fromEntries(['vendor', 'architecture', 'device', 'description'].map((key) => [key, rawInfo[key] || '']).filter(([, value]) => value))
  }
  self.postMessage({ type: 'gpu', id, info: gpuInfo })
  if (transcriber) return
  const started = performance.now()
  transcriber = await pipeline('automatic-speech-recognition', MODEL_ID, {
    revision: MODEL_REVISION,
    device: 'webgpu',
    dtype: DTYPE,
    progress_callback: (progress) => {
      const detail = progress?.file ? `${progress.file} ${Math.round(progress.progress || 0)}%` : progress?.status
      if (detail) status(id, `Loading model · ${detail}`)
    }
  })
  modelLoadMs = performance.now() - started
}

self.onmessage = async ({ data }) => {
  if (data?.type === 'cancel') {
    if (data.id === activeId) {
      activeId = undefined
      audioController?.abort()
    }
    return
  }
  if (data?.type !== 'run') return
  const { id, audioUrl } = data
  activeId = id
  audioController = new AbortController()
  try {
    status(id, 'Fetching original recording')
    const fetchStarted = performance.now()
    const response = await fetch(audioUrl, { credentials: 'include', signal: audioController.signal, cache: 'no-store' })
    if (!response.ok) throw new Error(`Could not read audio (${response.status})`)
    const bytes = await response.arrayBuffer()
    const audioFetchMs = performance.now() - fetchStarted
    if (activeId !== id) { reportCanceled(id); return }
    const { audio, sampleRate } = wavToAudio(bytes)
    const pipelineWasReady = Boolean(transcriber)
    await ensurePipeline(id)
    if (activeId !== id) { reportCanceled(id); return }
    status(id, 'Transcribing on this device')
    const inferenceStarted = performance.now()
    const result = await transcriber(audio, {
      sampling_rate: sampleRate,
      language: 'english',
      task: 'transcribe',
      chunk_length_s: 30,
      stride_length_s: 5,
      return_timestamps: false
    })
    const inferenceMs = performance.now() - inferenceStarted
    if (activeId !== id) { reportCanceled(id); return }
    self.postMessage({ type: 'result', id, text: result.text || '', metrics: { audioFetchMs, modelLoadThisRunMs: pipelineWasReady ? 0 : modelLoadMs, modelLoadMs, modelWasCached: pipelineWasReady, inferenceMs, sampleRate, audioSeconds: audio.length / sampleRate } })
  } catch (error) {
    if (activeId === id && error?.name !== 'AbortError') {
      self.postMessage({ type: 'error', id, error: error instanceof Error ? error.message : String(error) })
    } else {
      reportCanceled(id)
    }
  } finally {
    if (activeId === id) activeId = undefined
    audioController = undefined
  }
}
