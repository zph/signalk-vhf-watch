# Go sidecar throughput probe

This experimental pure-Go program reads RTL-SDR CU8 IQ on standard input and fully channelizes two
NFM streams: 16 kHz voice and 24 kHz Channel 70 DSC. It discards the audio after computing it and
reports throughput, output sample counts, signal levels, and a checksum. Its purpose is to separate
Pi/USB limits from the JavaScript channelizer's performance.

Build a static Raspberry Pi binary from macOS or Linux:

```sh
GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -trimpath -o vhf-go-sidecar .
```

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

The production sidecar should retain continuous DSC, use inexpensive in-band channel-presence
detectors, prioritize Channel 16 audio, and demodulate other active channels on demand. A bounded
full-band RAM ring plus triggered narrowband IQ/audio recordings can preserve pre-roll and permit
later decoder experiments without continuously writing roughly 17 GB/hour of full CU8 IQ.
