# Boat-pi in-situ VHF trial

Run on 2026-10-02 using archived calls fetched and processed on boat-pi. The original WAVs, denoised WAVs, Whisper outputs, and timing logs remain under the private temporary directories listed below; this report contains aggregate measurements only.

## Method

Three retained calls were compared at their full archived boundaries: raw; sherpa-onnx GTCRN; and sherpa-onnx DPDFNet with a 12 dB attenuation limit. Denoisers ran sequentially on CPU with one thread and low process/I/O priority. Each raw and processed WAV was sent to the existing `/usr/bin/vhf-whisper` wrapper using `base.en-q5_1` and two threads. Production transcription state and queue were checked before every Whisper invocation. The receiver and production transcription were not reconfigured or restarted.

| Archive ID | Channel | Duration | Archived words* | Fresh raw Whisper words | Activity interval |
|---:|---:|---:|---:|---:|---:|
| 819 | 16 | 56.751 s | 4 | 4 | 21.604–55.743 s |
| 817 | 14 | 11.499 s | 3 | 3 | 0–11.475 s |
| 829 | 80A | 21.384 s | 25 | 25 | 0–21.360 s |

\* Archived word count is only a metadata-based selection proxy, not a verified transcript or ground truth. ID 829 was selected from the newest 30 archive records as the longer marine call with at least 20 archived words. It is the only one of these three with a substantial fresh raw Whisper output, and remains a single-call observation.

## Results

Activity-window RMS levels are dBFS. They describe output level over the archived activity interval, not speech-only gain or SNR. “Edit distance” compares each processed call’s fresh Whisper token sequence with a fresh raw-call Whisper sequence; it is disagreement, not accuracy.

| ID | Variant | Activity RMS | Denoiser wall | User / system CPU | Max RSS | Fresh words | Edit distance from raw |
|---:|---|---:|---:|---:|---:|---:|---:|
| 819 | Raw | −9.10 dBFS | — | — | — | 4 | — |
| 819 | GTCRN | −41.28 dBFS | 7.403 s | 7.30 / 0.02 s | 56,368 KB | 1 | 4 |
| 819 | DPDFNet 12 dB | −21.10 dBFS | 18.554 s | 18.27 / 0.05 s | 73,504 KB | 4 | 0 |
| 817 | Raw | −8.24 dBFS | — | — | — | 3 | — |
| 817 | GTCRN | −36.94 dBFS | 1.647 s | 1.61 / 0.01 s | 34,432 KB | 0 | 3 |
| 817 | DPDFNet 12 dB | −20.24 dBFS | 3.241 s | 3.22 / 0.00 s | 44,160 KB | 3 | 3 |
| 829 | Raw | −9.04 dBFS | — | — | — | 25 | — |
| 829 | GTCRN | −33.51 dBFS | 2.440 s | 2.41 / 0.01 s | 39,296 KB | 21 | 6 |
| 829 | DPDFNet 12 dB | −21.04 dBFS | 5.288 s | 5.26 / 0.01 s | 53,552 KB | 25 | 0 |

Times are cold process wall time including model load, I/O, and low-priority scheduling. CPU percentages were 98–99% for the denoiser jobs. Output durations remained close to source durations: GTCRN was 8–15 ms shorter; DPDFNet was within 0–1 ms.

## Waveform mechanism check

Because DPDFNet's activity-window level drop looked exactly like its 12 dB attenuation cap, a separate aggregate-only comparison was run on the Pi. For each call, lag was searched from −3,200 to +3,200 samples around the highest-RMS 100 ms window found inside the raw activity interval (20 ms window hop), sampling every second lag and then checking neighboring integer samples at full rate. The best lag was zero for every output. A centered least-squares gain, Pearson correlation, and affine-fit residual were then calculated over the common full activity interval. These compare the processed waveform to raw; raw is not a clean reference, so these are mechanism statistics, not denoising/SNR/quality scores.

| ID | Variant | Lag | Fitted gain | Centered correlation | Fit residual / output RMS |
|---:|---|---:|---:|---:|---:|
| 819 | GTCRN | 0 samples | −38.28 dB | 0.497310 | −1.26 dB |
| 819 | DPDFNet 12 dB | 0 samples | −12.00 dB | 0.9999995 | −60.18 dB |
| 817 | GTCRN | 0 samples | −34.94 dB | 0.488014 | −1.19 dB |
| 817 | DPDFNet 12 dB | 0 samples | −12.01 dB | 0.9988499 | −26.39 dB |
| 829 | GTCRN | 0 samples | −33.78 dB | 0.345274 | −0.62 dB |
| 829 | DPDFNet 12 dB | 0 samples | −12.01 dB | 0.9993181 | −28.65 dB |

The Pearson correlation is calculated over the same full activity interval as the fitted gain and residual. On these three calls, DPDFNet 12 dB is mostly the raw waveform multiplied by approximately −12 dB gain; ID 819 is nearly a pure scaled copy, while IDs 817 and 829 show small but nonzero changes. GTCRN changed the waveform substantially and greatly reduced its level, but these measurements cannot determine whether that removed hiss, weak speech, or both. Neither mechanism result establishes listening quality.

## Interpretation and limits

There was no observed receiver-health regression in the recorded checks: production transcription was idle with queue 0 before and after; IQ drops and receiver restarts remained 0; receiver state was unchanged. DPDFNet took about 0.25–0.33× each call’s audio duration on these cold runs; GTCRN took about 0.11–0.14×.

DPDFNet's near-identical −12 dB scaling means its raw-run transcript agreement is not evidence of hiss reduction. Its fresh Whisper output matched the raw-run token sequence on IDs 819 and 829 but disagreed on all three tokens for ID 817. GTCRN’s activity-window level fell by about 24–32 dB and it produced fewer words than raw on all calls. That could reflect noise/hallucination suppression or weak-speech loss; these measurements cannot distinguish them. The third call provides a more substantive marine example, but one call and raw-run agreement do not establish word accuracy or listening quality. No ground-truth transcript or human audition was available, so there is not enough evidence to adopt either filter for production.

Outside-activity level, when present in the machine-readable summary, is only an RMS level over the non-activity portion; it is not guaranteed to be silence or noise-only and is not used as an SNR claim.

## Reproducibility and artifacts

Runner: `run_vhf_in_situ.py`. It defaults to IDs 819 and 817 and accepts one or more explicit IDs via `--ids`; explicit missing IDs fail rather than silently selecting a different call. Only the default pair may use the documented bounded fallback over the newest 30 metadata records.

Private Pi artifact roots:

- `/tmp/vhf-hiss-20261002/in-situ/run_20261002T161524Z/` (IDs 819 and 817)
- `/tmp/vhf-hiss-20261002/in-situ/run_20261002T162032Z/` (ID 829)

Each run contains a `summary.json`, per-call WAVs, Whisper outputs, and denoiser timing logs. Do not copy or publish those private call artifacts.

To reproduce the waveform-only mechanism table without rerunning either denoiser or Whisper, run on boat-pi from the repository root:

```sh
python3 experiments/hiss-comparison/analyze_vhf_waveforms.py \
  /tmp/vhf-hiss-20261002/in-situ/run_20261002T161524Z \
  /tmp/vhf-hiss-20261002/in-situ/run_20261002T162032Z
```

This prints aggregate lag, gain, full-activity correlation, and fit residual values only; it does not print or export audio samples or transcript text.
