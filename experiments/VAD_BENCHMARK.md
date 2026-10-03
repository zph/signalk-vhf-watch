# Silero VAD precheck trial

The VHF Watch production path currently runs Silero as an observer. It records `checked`,
`wouldSkip`, and `failOpen` counts in status, but still sends every batch to Base with the original
PCM and overlap. The internal filter mode is used only by tests. This avoids losing a call while the
radio recall of the detector is uncertain.

## Pi CPU cost

On 2026-10-03, the standalone one-thread helper built from whisper.cpp v1.9.4 commit
`927cfce34f31707e17f2bff35c349632fb9e2c3a` ran on boat-pi against six existing archived recordings
(10–40 seconds each). The helper and Silero v6.2.0 model were copied into temporary same-host
directories, the archive database was opened read-only, and extracted WAVs were removed after the
trial. No private audio or transcript text was exported.

Serial processing used 0.0054–0.0060 CPU seconds per audio second, about 0.54–0.60% of one core per
continuously active channel. A linear steady-state budget gives about 0.011–0.012 cores for two
channels, 0.022–0.024 for four, and 0.043–0.048 for eight. Each measurement launched a fresh helper
and loaded the model again; these figures include process startup. They do not measure a resident
model or true recurrent-state batching. A separate 2/4/8-process burst reached 1.9/3.2/3.3 cores
while the processes overlapped, which is not the same as persistent per-channel streams or batching.
The temperature reading was 51.8°C before and 66.65°C after the burst series; throttle flags were
not sampled during the bursts.

The implementation currently invokes one helper for each transcription batch. True batching would
feed one 32 ms frame per independent channel to a shared model call while maintaining a separate
Silero recurrent state for every channel; frames within a channel must remain ordered. The standalone
file helper does not expose that interface, so no batching speedup is claimed here.

## Speech recall and noise controls

The configured measurement threshold is 0.35, with an 80 ms minimum speech span and 200 ms speech
padding. At 0.35, four of six archived records with prior nonempty Base results returned valid zero
segments; two returned speech segments. The prior Base outputs are not ground-truth labels, and the
audio was not independently adjudicated, so this is a conservative warning rather than a measured
false-negative rate. A public built-in `jfk.wav` speech sample and public clean/noisy JFK radio
controls were detected at 0.35.

Lowering the threshold to 0.01 produced segments on all six archive records, including those that
were zero at 0.35, but also triggered on synthetic 60 Hz hum and low-level white noise. Silence was
rejected. In a threshold sweep, 0.02 still missed two of the four challenged archive records and
triggered on synthetic hiss; 0.03 and higher missed all four. These synthetic controls are
supplemental and do not represent real RF squelch-noise distributions. Applying the existing
half-wet RNNoise output before VAD produced zero segments on all six archive examples at thresholds
0.1 and 0.35, including the two raw examples detected at 0.35. This does not establish that denoising
should be used as a VAD input.

There is not enough labeled marine audio to justify dropping a batch on a zero result. The runtime
therefore reports candidate skips without applying them. Existing playback behavior, archive audio,
and the Base transcription path remain intact.

## Reproduction

For public WAV controls, use the checked-in harness on the Pi or another target running the matching
helper and model. Every invocation starts a new process; repeated runs only warm filesystem caches.
Do not interpret the concurrency option as model batching.

```sh
LD_LIBRARY_PATH=/usr/lib/vhf-whisper python3 experiments/bench-whisper-vad.py \
  --helper /usr/lib/vhf-whisper/whisper-vad-speech-segments \
  --model /usr/share/vhf-whisper/vad/ggml-silero-v6.2.0.bin \
  --thresholds 0.1,0.2,0.35 --repeats 3 --concurrency 2,4,8 \
  /path/to/public-speech.wav /path/to/public-radio-noise.wav
```
