export const PCM_CHANNELS = 1
export const PCM_BITS = 16

export function wavHeader(sampleRate: number, dataBytes: number): Buffer {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(Math.min(0xffff_ffff, 36 + dataBytes), 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(PCM_CHANNELS, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * PCM_CHANNELS * (PCM_BITS / 8), 28)
  header.writeUInt16LE(PCM_CHANNELS * (PCM_BITS / 8), 32)
  header.writeUInt16LE(PCM_BITS, 34)
  header.write('data', 36)
  header.writeUInt32LE(Math.min(0xffff_ffff, dataBytes), 40)
  return header
}

export function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  return Buffer.concat([wavHeader(sampleRate, pcm.length), pcm])
}

export function rmsLevel(pcm: Buffer): number {
  const samples = Math.floor(pcm.length / 2)
  if (samples === 0) return 0
  let sum = 0
  for (let offset = 0; offset + 1 < pcm.length; offset += 2) {
    const sample = pcm.readInt16LE(offset) / 32768
    sum += sample * sample
  }
  return Math.sqrt(sum / samples)
}
