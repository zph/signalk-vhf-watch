# Go native receiver sidecar

This experimental pure-Go program has two modes. `probe` reads RTL-SDR CU8 IQ on standard input and
reports bounded throughput. Production `stream` mode owns `rtl_sdr`, fully channelizes 16 kHz voice
and 24 kHz Channel 70 DSC, and emits framed PCM to the Signal K plugin. JavaScript never handles the
2.4 MS/s raw IQ stream.

Build a static Raspberry Pi binary from macOS or Linux:

```sh
GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o vhf-go-sidecar .
```

The plugin starts stream mode itself. Its stdin accepts `tune <frequency-hz>` commands, allowing an
in-band voice channel change without interrupting Channel 70 or retuning the hardware.

## CPU optimization status

The DSP precomputes its Hann weights, uses bounded phase wrapping, and runs a symmetric float64 FIR
through an ARM64 NEON kernel; tests compare these paths with the prior formula, discriminator, and
scalar ring. VAD remains in observation mode, and persisted Base model and thread settings are
unchanged. See the paired Pi results below.

During an intentional AIS interruption, a bounded 20-second trial is:

```sh
rtl_sdr -d 00000001 -f 156750000 -s 2400000 -n 48000000 - |
  ./vhf-go-sidecar \
    -sample-rate 2400000 \
    -center 156750000 \
    -voice 156800000 \
    -dsc 156525000
```

## boat-pi result, 2026-09-29

The trial consumed all 48,000,000 complex samples with no RTL-SDR loss diagnostic and produced the
exact audio counts expected for 20 seconds:

| Measurement | Result |
| --- | ---: |
| DSP wall time | 0.615 s |
| DSP headroom | 32.50× real time |
| Voice samples at 16 kHz | 320,000 |
| DSC samples at 24 kHz | 480,000 |
| RTL-SDR delivery plus DSP | 20.949 s |

This establishes that the Raspberry Pi and tuner can sustain the desired 2.4 MS/s dual-channel
workload. The dropped-IQ problem is specific to the JavaScript implementation.

The production sidecar now replaces the original integrate-and-dump channelizer with two stages of
Blackman-windowed FIR filtering. Its default 9 kHz pre-demodulation passband, slow residual-carrier
tracking, and controlled decimation were selected by replaying the same 60-second NOAA CU8 capture
through the old and candidate paths. The selected filter reduced quiet-window PCM RMS about 14%,
retained all 960,000 expected 16 kHz samples, and completed the dual-channel replay in about 19
seconds (roughly 3.2x real-time headroom) on the Pi 5. `--rf-cutoff` remains available for bounded
comparison trials.

The polar phase discriminator is already invariant to positive IQ amplitude scaling, so an explicit
amplitude limiter produced no different demodulated samples. Instead, near-zero filtered samples are
handled without inventing phase. Stream status reports residual carrier offsets and the CU8 edge-byte
fraction so PPM and front-end gain can be tuned from measured data rather than by aggressively
blanking valid RF peaks.

A bounded full-band RAM ring plus triggered narrowband IQ/audio recordings could preserve pre-roll
for later decoder experiments without continuously writing roughly 17 GB/hour of full CU8 IQ.

## ARM64 FIR path and matched replay

On ARM64, the symmetric FIR keeps two copies of interleaved float64 I/Q history so each tap window
is contiguous. Its NEON kernel accumulates paired taps with fused vector multiply-add, matching the
original scalar ring's arithmetic order. Other architectures use the contiguous scalar fallback.
Tests compare ARM64 results bit-for-bit with the old ring and contiguous scalar paths, and compare
channelizer PCM with independent direct convolution within one LSB.

`receiver_replay_test.go` benchmarks a private, pre-captured CU8 file without saving that recording
in the repository. Compile the same test file against the baseline and candidate `main.go`, then run
both binaries on the identical Pi-local file. The test follows the stream's 1 MiB chunking and
reports input/output hashes, expected PCM sample counts, and fixed-workload elapsed time; its
wideband scenarios measure DSP cost only when the fixture was captured on a different center
frequency.

The Pi 5 comparison used the same private 10-second CU8 fixture (48,000,000 bytes) for three
baseline/candidate pairs at 2.2 GHz. The fixed WX4 case matches the saved 162.425 MHz receiver
configuration. The two wideband cases reuse those bytes with other channel settings, so they measure
DSP cost rather than RF detection quality; the scanner evaluates 45 configured channel
frequencies. All PCM sample counts, PCM hashes, and scanner-activity hashes matched in all three
pairs.

| 10-second workload | Baseline | NEON | Elapsed reduction |
| --- | ---: | ---: | ---: |
| Fixed WX4 voice + DSC | 1.830 s | 1.109 s | 39% |
| Wideband A16 + DSC + 45-channel scanner | 1.841 s | 1.061 s | 42% |
| Wideband A16 + B68 + DSC + 45-channel scanner | 1.904 s | 1.108 s | 42% |

Across the three sequential scenarios, median process user CPU time fell from 13.224 s to 7.807 s
(41%); median total wall time fell from 5.779 s to 3.424 s. The paired runs peaked at 72.5°C with
power flags clear. Pi FIR microbenchmarks also separated the contiguous layout gain from NEON:

| FIR | Original ring | Contiguous scalar | NEON |
| --- | ---: | ---: | ---: |
| 63 taps, decimation 5 | 37.82 ns/input | 29.23 ns/input | 20.47 ns/input |
| 511 taps, decimation 5 | 182.5 ns/input | 171.8 ns/input | 85.83 ns/input |

The measured 39–42% reduction is from offline replay, not a claim about live RF load or reception
quality. The stored fixture and raw logs remain on the Pi; benchmark output contains only aggregate
timings, counts, and hashes.

```sh
VHF_BENCH_IQ_PATH=/path/to/private.cu8 \
  /usr/bin/time -v ./vhf-replay.test -test.run '^$' \
  -test.bench '^BenchmarkReceiverReplay$' -test.benchtime=1x -test.count=1 -test.v
```
