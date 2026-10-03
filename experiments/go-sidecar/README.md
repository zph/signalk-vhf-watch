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

The DSP precomputes its Hann weights and uses bounded phase wrapping; tests compare these paths with
the prior formula and discriminator. VAD remains in observation mode, and persisted Base model and
thread settings are unchanged. Raspberry Pi measurements of this build are still pending.

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
