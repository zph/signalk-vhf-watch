import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { DEFAULT_RNNOISE_MODEL, playbackFilterGraph, RnnoiseDenoiser, rnnoiseFilterGraph } from '../src/rnnoise'

test('builds a half-wet RNNoise graph that returns to the receiver sample rate', () => {
  const graph = rnnoiseFilterGraph('/tmp/radio:model.rnnn', 16_000)
  assert.match(graph, /aresample=48000,arnndn=/)
  assert.match(graph, /radio\\:model\.rnnn/)
  assert.match(graph, /weights='0\.5 0\.5'/)
  assert.match(graph, /aresample=16000/)
})

test('builds the validated adaptive playback cleanup graphs', () => {
  const comfort = playbackFilterGraph('comfort', '/unused', 16_000)
  assert.match(comfort, /afftdn=nr=10:nf=-28:tn=1:ad=0\.8:gs=6/)
  assert.match(comfort, /weights='0\.15 0\.85'/)
  const maximum = playbackFilterGraph('maximum', '/unused', 16_000)
  assert.match(maximum, /highpass=f=180:p=2,lowpass=f=3200:p=2/)
  assert.match(maximum, /afftdn=nr=6:nf=-28:tn=1:ad=0\.8:gs=4/)
  assert.match(maximum, /weights='0\.25 0\.75'/)
})

test('bundles the speech recording-noise model and reports a missing runtime safely', async () => {
  const sourceModel = path.resolve(__dirname, '../../models/rnnoise/speech-recording.rnnn')
  assert.match(readFileSync(sourceModel, 'utf8').slice(0, 64), /^rnnoise-nu model file version 1/)
  assert.match(DEFAULT_RNNOISE_MODEL, /models\/rnnoise\/speech-recording\.rnnn$/)
  const unavailable = new RnnoiseDenoiser('/definitely/missing/ffmpeg', path.join(__dirname, 'missing.rnnn'))
  assert.equal(unavailable.available(), false)
  assert.equal(unavailable.available('comfort'), false)
  await assert.rejects(() => unavailable.processPcm(Buffer.alloc(320), 16_000), /requires FFmpeg/)
})
