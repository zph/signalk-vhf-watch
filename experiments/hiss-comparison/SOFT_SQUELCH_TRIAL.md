# Offline soft-squelch trial after GTCRN

One authorized ID 829 / CH80A comparison only. Inputs were the already-created, same-boundary, fixed-gain RMS/peak-matched local listening clips. The raw clip drove an offline close-only hiss heuristic; its gain envelope was applied to the GTCRN clip. The GTCRN input gain was not restored or renormalized after gating. Original Pi recordings and source WAVs remain unchanged; generated listen copies and metrics are in `/tmp/vhf-hiss-20261002/authorized-audition/soft-gate/`.

## Detector and envelope

This is a raw-hiss heuristic, not a VAD or carrier detector. It uses centered 20 ms Hann-window frames at a 10 ms hop. For each frame it measures raw level and the ratio of mean Goertzel bin power at 400–3,000 Hz to 4,000–7,000 Hz (320-sample window, every other 50 Hz bin). A top-level-quartile template estimates the stable hiss ratio. The run abstains open if level IQR is below 8 dB, the top quartile contains under 0.5 s, or template-ratio MAD exceeds 2 dB.

A frame is only a close candidate if both raw and 11-frame-median-smoothed level are at least the 75th-percentile level minus 3 dB, smoothed band ratio is within 2.5 dB of the template, and rolling 250 ms ratio MAD is at most 1.5 dB. Candidates must persist 250 ms. Every uncertain/noncandidate frame stays open. The envelope has a 150 ms unity opening guard, protects open runs by 150 ms backward and 400 ms forward, uses a 15 ms raised-cosine opening ramp and a 200 ms release, and bottoms at −25 dB. All processing is linear multiplication; no compressor, hard cut, trim, or output normalization is used.

## Observed result

| Measurement | Result |
|---|---:|
| Sample rate / duration / frames | 16 kHz / 21.360 s / 341,760 |
| Abstention | No (guards passed for this clip) |
| Raw level Q25 / Q75 | −31.86 / −20.14 dBFS |
| Noise-template band ratio / MAD | +7.70 / 0.75 dB |
| Sustained candidate-hiss frames | 1,338 / 2,136 (62.6%) |
| Detector-open frames before temporal protection/fades | 798 / 2,136 (37.4%) |
| GTCRN matched RMS → gated RMS | −21.94 → −22.61 dBFS |
| Peak before / after | −1.00 / −1.00 dBFS |
| Samples at PCM limit | 0 |
| Gate envelope bounds | 0.0562 (−25 dB) to 1.0 |

These statistics establish only what the heuristic did to this waveform. The 37.4% protected-open coverage is not a speech-activity score, and neither the detector nor level changes demonstrate that speech was preserved or hiss was perceptually improved. Human audition is still required; this is not a production recommendation.

## Reproduction

The offline runner and unit tests are `soft_squelch.py` and `test_vhf_in_situ.py`. Example invocation for the authorized local ID829 clips:

```sh
python3 experiments/hiss-comparison/soft_squelch.py \
  --raw /tmp/vhf-hiss-20261002/authorized-audition/829-raw-matched.wav \
  --gtcrn /tmp/vhf-hiss-20261002/authorized-audition/829-gtcrn-matched.wav \
  --out-dir /tmp/vhf-hiss-20261002/authorized-audition/soft-gate
```

Do not place private call audio in the repository.
