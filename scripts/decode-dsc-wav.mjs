#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DscAudioDecoder } from '../dist/dsc.js'

function usage() {
  console.error('usage: npm run decode:dsc-wav -- <24-kHz-mono-16-bit-PCM.wav>')
  process.exitCode = 2
}

function wavPcm(contents) {
  if (contents.toString('ascii', 0, 4) !== 'RIFF' || contents.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file')
  }
  let format
  let pcm
  for (let offset = 12; offset + 8 <= contents.length;) {
    const type = contents.toString('ascii', offset, offset + 4)
    const length = contents.readUInt32LE(offset + 4)
    const start = offset + 8
    const end = start + length
    if (end > contents.length) throw new Error(`truncated ${type} chunk`)
    if (type === 'fmt ') {
      format = {
        encoding: contents.readUInt16LE(start),
        channels: contents.readUInt16LE(start + 2),
        sampleRate: contents.readUInt32LE(start + 4),
        bitsPerSample: contents.readUInt16LE(start + 14)
      }
    } else if (type === 'data') {
      pcm = contents.subarray(start, end)
    }
    offset = end + (length % 2)
  }
  if (!format || !pcm) throw new Error('WAV must contain fmt and data chunks')
  if (format.encoding !== 1 || format.channels !== 1 || format.sampleRate !== 24_000 || format.bitsPerSample !== 16) {
    throw new Error(`expected PCM mono 24000 Hz 16-bit; received ${JSON.stringify(format)}`)
  }
  return pcm
}

const filename = process.argv[2]
if (!filename) {
  usage()
} else {
  try {
    const decoder = new DscAudioDecoder(24_000)
    const messages = decoder.push(wavPcm(readFileSync(resolve(filename))))
    process.stdout.write(`${JSON.stringify(messages, null, 2)}\n`)
    if (messages.length === 0) process.exitCode = 1
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
