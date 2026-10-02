import assert from 'node:assert/strict'
import test from 'node:test'
import { cleanArchivedPlaybackPcm, cleanPlaybackPcm, parsePlaybackCleanup, PlaybackCleaner } from '../src/playback-cleanup'
import { rmsLevel } from '../src/wav'

function tone(sampleRate: number, frequency: number, amplitude: number, seconds: number): Buffer {
  const pcm = Buffer.alloc(Math.round(sampleRate * seconds) * 2)
  for (let index = 0; index < pcm.length / 2; index += 1) {
    pcm.writeInt16LE(Math.round(Math.sin(2 * Math.PI * frequency * index / sampleRate) * amplitude), index * 2)
  }
  return pcm
}

test('parses only supported playback cleanup modes', () => {
  assert.equal(parsePlaybackCleanup('raw'), 'raw')
  assert.equal(parsePlaybackCleanup('modified'), 'modified')
  assert.equal(parsePlaybackCleanup('voice'), 'modified')
  assert.equal(parsePlaybackCleanup('comfort'), 'modified')
  assert.equal(parsePlaybackCleanup('anything-else'), 'modified')
})

test('voice focus preserves speech frequencies while reducing low rumble', () => {
  const sampleRate = 16_000
  const speech = cleanPlaybackPcm(tone(sampleRate, 1_000, 8_000, 1), sampleRate, 'voice')
  const rumble = cleanPlaybackPcm(tone(sampleRate, 80, 8_000, 1), sampleRate, 'voice')
  assert.ok(rmsLevel(speech) > rmsLevel(rumble) * 4)
})

test('strong cleanup attenuates steady static more than a voice burst', () => {
  const sampleRate = 16_000
  const cleaner = new PlaybackCleaner(sampleRate, 'strong')
  const staticOnly = tone(sampleRate, 1_400, 700, 1)
  const voice = tone(sampleRate, 1_000, 7_000, 0.5)
  const cleanedStatic = cleaner.process(staticOnly)
  const cleanedVoice = cleaner.process(voice)
  assert.ok(rmsLevel(cleanedStatic) < rmsLevel(staticOnly) * 0.35)
  assert.ok(rmsLevel(cleanedVoice) > rmsLevel(voice) * 0.45)
})

test('archive squelch gates quiet audio while retaining strong speech', () => {
  const sampleRate = 16_000
  const quiet = cleanArchivedPlaybackPcm(tone(sampleRate, 1_000, 200, 1), sampleRate, 'raw', 20)
  const speech = cleanArchivedPlaybackPcm(tone(sampleRate, 1_000, 3_000, 1), sampleRate, 'raw', 20)
  assert.ok(rmsLevel(quiet) < 0.005)
  assert.ok(rmsLevel(speech) > 0.05)
})
