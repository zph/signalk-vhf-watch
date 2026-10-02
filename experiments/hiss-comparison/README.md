# VHF hiss comparison experiment

This runner compares the existing FFmpeg Comfort path with GTCRN and DPDFNet on the public
11-second JFK speech sample distributed by `whisper.cpp`. It band-limits the clean reference to
300–3,200 Hz, adds deterministic high-passed Gaussian noise at calibrated 0 dB and 8 dB speech SNR,
and appends a two-second noise-only tail. The noise is a repeatable radio-hiss approximation, not a
recorded VHF channel.

The experiment preserves the source, reference, noisy inputs, and each processed WAV. Metrics use a
single mask derived from the clean reference (20 ms frames, 80 ms dilation), an exhaustive full-rate
constant-delay search over ±200 ms on a strong 500 ms reference window, and a common valid interval.
It reports speech-region
SI-SDR, SNR improvement, speech-region RMS change, projected speech gain, quiet-tail RMS, and
fixed-model Whisper word error against the well-known spoken JFK sentence.
Listening copies are made after metrics by matching speech-region RMS with shared peak headroom.
Per-run cold process wall time (including startup, model load, I/O, and low-priority scheduling) and
peak RSS are recorded for one-thread and two-thread model runs; these values are not warm real-time
factors.

Run on an ARM64 Pi with FFmpeg, `vhf-whisper`, the sherpa-onnx offline denoiser runtime, and the two
models installed in temporary or explicitly selected directories:

```sh
python3 experiments/hiss-comparison/run.py \
  --input /tmp/vhf-hiss-20261002/jfk.wav \
  --out /tmp/vhf-hiss-20261002/results \
  --runtime /tmp/vhf-hiss-20261002/pi-runtime/sherpa-onnx-v1.13.8-linux-aarch64-shared-cpu \
  --gtcrn /tmp/vhf-hiss-20261002/pi-runtime/gtcrn_simple.onnx \
  --dpdfnet /tmp/vhf-hiss-20261002/pi-runtime/dpdfnet_baseline.onnx
```

The noise model, thresholds, metrics, and selected Whisper setup are experimental choices. Results
on this public control do not establish performance on marine radio speech or justify changing the
production playback pipeline. For an authorized, bounded in-domain trial, `run_vhf_in_situ.py`
processes selected archived calls entirely on boat-pi and emits aggregate metrics without exporting
audio or transcript text. See `VHF_IN_SITU_RESULTS.md`; that small trial is inconclusive about
voice quality without ground truth and human listening. `analyze_vhf_waveforms.py` reproduces its
raw-vs-output gain/correlation/residual diagnostics from the Pi-local trial artifacts without
rerunning denoising or transcription.
