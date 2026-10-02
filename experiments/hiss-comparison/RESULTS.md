# Public-control trial results

Run on `boat-pi` (8 GiB Raspberry Pi Cortex-A76, ARM64) on 2026-10-02 with sherpa-onnx 1.13.8,
ONNX Runtime 1.28.2, FFmpeg, and the production `base.en-q5_1` Whisper model at two threads. The
11-second mono/16 kHz JFK clip came from the official [`whisper.cpp` sample directory](https://github.com/ggml-org/whisper.cpp/tree/master/samples).
It was band-limited to 300–3,200 Hz, extended with a two-second quiet tail, and mixed with a
deterministic 900 Hz high-passed Gaussian noise approximation at calibrated 0 dB or 8 dB speech SNR.
This is a public speech control, not recorded VHF audio or a physical FM receiver simulation.

The table reports change from the matching unprocessed noisy control. SNR improvement and SI-SDR
use a clean-reference-derived speech mask with 80 ms dilation and exhaustive full-rate, constant-delay
alignment over ±200 ms, scored on a strong 500 ms reference window.
Quiet-tail RMS uses the known noise-only tail. WER uses the spoken JFK reference normalized for
punctuation and case (22 words); it does not measure marine-radio accuracy.

The first coarse-lag pass selected 453 samples for Comfort; exhaustive alignment finds the actual
400-sample (25 ms) filter delay. Comfort's objective rows below use the corrected alignment. Whisper
transcriptions and all model outputs were reused unchanged.

| Input SNR | Playback | Speech SNR gain | SI-SDR | Speech-region RMS change | Quiet-tail RMS | Whisper WER |
| ---: | --- | ---: | ---: | ---: | ---: | ---: |
| 0 dB | Raw | 0.00 dB | 0.04 dB | +3.03 dB | -18.7 dBFS | 1/22 (4.5%) |
| 0 dB | Comfort | +1.09 dB | -0.27 dB | +1.65 dB | -20.1 dBFS | 4/22 (18.2%) |
| 0 dB | GTCRN | +10.97 dB | +12.48 dB | -1.83 dB | -70.1 dBFS | 1/22 (4.5%) |
| 0 dB | DPDFNet full | +13.36 dB | +13.18 dB | -0.07 dB | -101.8 dBFS | 11/22 (50.0%) |
| 0 dB | DPDFNet, 12 dB attenuation limit | +10.02 dB | +9.84 dB | +0.24 dB | -30.8 dBFS | 1/22 (4.5%) |
| 8 dB | Raw | 0.00 dB | +8.00 dB | +0.64 dB | -25.0 dBFS | 3/22 (13.6%) |
| 8 dB | Comfort | -0.05 dB | +7.19 dB | -0.79 dB | -26.6 dBFS | 5/22 (22.7%) |
| 8 dB | GTCRN | +9.10 dB | +17.11 dB | -0.27 dB | -75.9 dBFS | 2/22 (9.1%) |
| 8 dB | DPDFNet full | +9.34 dB | +17.26 dB | -0.07 dB | -112.7 dBFS | 1/22 (4.5%) |
| 8 dB | DPDFNet, 12 dB attenuation limit | +8.26 dB | +16.18 dB | -0.01 dB | -37.1 dBFS | 0/22 (0%) |

The attenuation-limited DPDFNet result retained more quiet-tail hiss than full DPDFNet while scoring
better on this short speech sample. Full DPDFNet removed the most noise, but at 0 dB it substantially
damaged recognition. GTCRN improved the measured noise metrics and modestly improved WER at 8 dB.
With corrected 400-sample alignment, Comfort is near raw on the objective speech metrics at 8 dB and
slightly improves measured SNR at 0 dB, while producing more Whisper word errors than raw at both
levels. These are useful candidate rankings for the next listening comparison, not grounds for a
product change: this noise has no real receiver static, multipath, interference, or marine-radio
speaker variation.

Cold process wall times include process startup, model loading, I/O, and low-priority scheduling; do
not read them as steady-state real-time factors.

| Model | Threads | Cold wall time | Peak RSS |
| --- | ---: | ---: | ---: |
| GTCRN | 1 | 1.68–2.19 s | 34–35 MiB |
| GTCRN | 2 | 1.75 s | 33 MiB |
| DPDFNet full | 1 | 3.76–4.25 s | 46–48 MiB |
| DPDFNet full | 2 | 4.13 s | 48 MiB |
| DPDFNet, 12 dB limit | 1 | 3.36–3.62 s | 46–49 MiB |
| DPDFNet, 12 dB limit | 2 | 4.42 s | 49 MiB |

The Signal K transcription worker was idle before the run and idle afterward. Receiver counters were
zero IQ drops and zero restarts both before and after. Five speech-RMS-matched 8 dB comparison copies
and complete machine-readable metrics are retained in `/tmp/vhf-hiss-20261002/public-control` for
listening and review. The raw boat archive samples remain unavailable to this trial: automatic
approval rejected copying those private recordings into local temporary storage, and no workaround
was attempted.
