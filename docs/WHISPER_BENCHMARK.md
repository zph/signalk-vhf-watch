# Raspberry Pi Whisper prototype

Measured on `boat-pi` on 2026-09-29 while VHF Watch continued its 2.4 MS/s RTL-SDR capture of
Channel 16 plus continuous DSC Channel 70.

- Raspberry Pi Cortex-A76, 4 cores at up to 2.4 GHz
- 8 GiB RAM and NVMe storage
- Debian 13 ARM64
- `whisper.cpp` v1.9.4, CPU/NEON build
- 11-second English reference clip, plus a 300–3,000 Hz band-limited copy approximating voice-radio
  audio

| Model / settings | Wall time | Average CPU | Peak RAM | Relative to 11 s audio |
| --- | ---: | ---: | ---: | ---: |
| tiny.en F16, 2 threads, full context | 1.99 s | 191% | 178 MB | 5.5× real time |
| tiny.en Q5_1, 1 thread, full context | 4.94 s | 99% | 132 MB | 2.2× real time |
| tiny.en Q5_1, 2 threads, full context | 2.61 s | 194% | 132 MB | 4.2× real time |
| tiny.en Q5_1, 4 threads, full context | 1.86 s | 332% | 133 MB | 5.9× real time |
| base.en Q5_1, 2 threads, full context | 6.22 s | 197% | 200 MB | 1.8× real time |
| base.en Q5_1, 4 threads, full context | 4.02 s | 344% | 201 MB | 2.7× real time |
| **tiny.en Q5_1, 2 threads, context 768** | **1.51 s** | **189%** | **116 MB** | **7.3× real time** |
| base.en Q5_1, 2 threads, context 768 | 3.11 s | 194% | 181 MB | 3.5× real time |

The band-limited copy produced essentially identical timings. Tiny Q5_1 made a minor singular/plural
error (`American` rather than `Americans`) on that degraded sample; base Q5_1 retained the expected
word. This is only a controlled performance and smoke test, not an accuracy validation against real
marine traffic, weak signals, overlapping speakers, accents, or radio static.

The complete repeated run raised CPU temperature from 62.8 °C to 78.8 °C. Four-thread inference
used most of the Pi and offers too little latency benefit to justify that thermal and scheduling
pressure. During every run the receiver reported zero IQ drops and zero restarts. The VHF sidecar's
baseline was about 6% of one CPU; Signal K as a whole was about 22–25% of one CPU immediately after
restart.

The prototype therefore uses `tiny.en-q5_1`, two threads, and audio context 768. Jobs are serialized,
bounded, and only queued for replay slices containing at least 0.35 seconds that pass RF squelch.
Transcription remains off by default and is an optional, separately installed package.

See the official [`whisper.cpp` project](https://github.com/ggml-org/whisper.cpp) for implementation,
model, quantization, and platform details.
