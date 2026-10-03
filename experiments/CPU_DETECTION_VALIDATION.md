# VHF CPU and speech-detection validation

This is an internal engineering record for separating measured CPU use from code-level hypotheses.
The VAD threshold is not enabled as a production filter: VAD remains observational, and every
eligible batch still goes to the configured Base transcription model with its original audio.
The package does not change the model/thread defaults. For the current Pi ASR comparison, the
persisted thread setting is one; the Base model and full-context transcription remain in use.

## Current Pi workload sample

The completed trial log `/private/tmp/vhf-removal-live-trial/live-20261003-15min.jsonl` contains
439.8 seconds of valid samples. Reported system busy was 29.8% on average, 70.8% at p95, and 82.8%
at peak; maximum temperature was 79°C. Per-process figures are CPU percent of one core: the VHF
sidecar averaged 69.45%, Node 13.33%, Whisper 21.41% across roughly 187 active seconds, VAD 0.08%,
and FFmpeg 0.72%. These process averages do not add up to the system busy average because the
sampling windows and process activity differ. They are a workload snapshot, not a controlled
before/after benchmark; exact deployed-package attribution for this log still needs confirmation.

The trial stopped after undervoltage/throttle flags `0xf0005` were reported at 74.7°C. Treat those
power and thermal conditions as a confounder in CPU comparisons. Do not infer that DSP is the only
remaining cost from the sidecar's largest per-process average: Whisper has a much higher short peak
than its full-window average.

### Optimized one-thread live interval

The later optimized run contributed 339.79 seconds of plugin-ready samples (414 monitor rows before
the cutoff). System busy averaged 26.37%, with p95 46.9% and maximum 81.9%. Per-process CPU means
were sidecar 64.64%, Node 13.64%, Whisper 12.60%, VAD 0.00%, FFmpeg 0.69%, and RTL-SDR 0.73%, each
as a percentage of one core. Temperature averaged 68.7°C, p95 was 74.1°C, and the maximum was
76.8°C; throttle flags stayed at `0xf0000`. Status reported idle in 71 of 82 polls and transcribing
in 11; VAD observation counters were 4 checked, 4 would-skip, and 0 skipped. The VHF receiver and
scanning were enabled, and four recordings were processed, but status showed no active reception at
the sampled instants. There were no IQ drops or receiver restarts. This was not a controlled match
to the earlier interval and does not establish radio-call quality.

Metrics-only log: `/private/tmp/vhf-public-validation-20261003/one-thread-live-metrics.jsonl`, SHA256
`f106a6766bac5673dcb16d7cf4a3c81e46870c630e04980e717fe1c8b6f281a0a`. The cutoff excluded later
cleanup samples. The report uses aggregate values only; it contains no audio, transcripts, or private
record identifiers.

### Isolated sidecar DSP comparison

An offline two-channel probe compared the old and new sidecars using three alternating 24 MB,
seeded AES-CTR synthetic CU8 inputs. The probe exercised the two-channel filters but no FFT scan or
live receiver work. Old DSP times were 0.9830, 0.9814, and 0.9834 seconds (median 0.9830); new
times were 0.9426, 0.9224, and 0.9249 seconds (median 0.9249), about 5.9% less elapsed DSP time.
Sample counts and other outputs matched; checksum difference was about 1e-13. Temperature ranged
from 54.9°C at start to 63.7°C maximum, with current flags clear. This supports a narrow synthetic
DSP improvement, not an end-to-end/live-scan CPU claim. The later one-thread workload interval is
summarized above, but its activity and time window differ, so it is not a matched before/after
comparison.

### Public-control Base thread comparison

With the same Base model and complete input context, clean JFK speech was transcribed in four runs
(two paired measurements). At one thread, wall times were 12.38 and 12.48 seconds; at two threads,
6.38 and 6.49 seconds. Normalized text matched exactly (WER 0). The noisy JFK 8 dB control was run
once at each setting: 12.58 seconds at one thread and 6.52 seconds at two; both outputs had WER
3/22 (0.1364), but the differing words were not the same errors. Aggregate CPU time was roughly
12.3 versus 12.5 seconds for the clean pair, so one thread reduced peak concurrency and increased
latency without a material total-CPU/energy reduction. The public trial peaked at 69.7°C with no
current undervoltage/throttle flags. This is a small public-control sample, not a measured live-radio
quality or overnight thermal result.

## Verified software changes and local checks

Commit `2b26b100a118bce7a1f28e8b572cb881618022ab` precomputes the spectrum Hann coefficients,
replaces two trig-based phase normalizations per discriminator sample with bounded phase wrapping,
uses constant-time replay counts in status, and caches the Whisper model inventory with a 30-second
refresh. The packaged Linux/ARM64 sidecar at that commit has SHA256
`e484462fd4c148f85d11c4d9e9b9a486bb395679a9f403efb52c7b513dc77480`.

Go tests compare the cached Hann values exactly with the original formula and exercise 100,000 phase
values against the original trig expression. The direct-FIR PCM regression uses the original
trig-based discriminator as its reference and remains within one PCM least-significant bit. The
Apple M5 microbenchmark measured bounded phase wrapping at 0.71–0.81 ns/op and the trig expression
at 7.96–8.24 ns/op. The isolated Hann-window loop measured about 9.1 µs versus 9.4 µs per 4096
samples. These are local microbenchmarks, not Raspberry Pi pipeline measurements; the Hann result
in particular is small and platform-sensitive.

The full npm suite passed 127/127, TypeScript typecheck passed, Go tests passed, and `npm pack
--dry-run` included the rebuilt ARM64 binary. Native Go checks on boat-pi passed in 0.263 seconds.
An isolated Pi microbenchmark measured cached Hann lookup at 13.5–13.9 µs versus 74.7 µs using
per-sample cosine (~5.4×), and bounded phase wrapping at 2.74 ns versus 63.2 ns using trig (~23×).
These are microbenchmarks, not whole-pipeline savings. Runtime CPU savings from Node status
processing and end-to-end/live-scan CPU effects are not yet isolated.

## Speech-detection evidence and limits

The earlier Silero helper trial on boat-pi used whisper.cpp v1.9.4 commit
`927cfce34f31707e17f2bff35c349632fb9e2c3a` and Silero VAD v6.2.0. Serial fresh-process checks
measured 0.0054–0.0060 CPU seconds per audio second (about 0.54–0.60% of one core per continuously
active channel), including process startup and model load. This is not a persistent-model or true
multi-channel batching measurement. The helper ran against six archived recordings, but previous
Base transcription output is not ground truth and the recordings were not independently adjudicated.
At threshold 0.35, four records had zero speech segments and two had speech segments; this cannot
establish a false-negative rate. At 0.01, the helper also triggered on synthetic hum and white noise.

The public validation matrix contained 20 rows: 13 positive speech rows across five variants and
three speakers (clean JFK, JFK noisy at 0 dB, George W. Bush, Laura Bush, and JFK noisy at 8 dB),
plus seven negative rows. Silence and deterministic white noise were each tested at thresholds 0.10,
0.20, and 0.35; 60 Hz hum was tested at 0.35. The detector found speech in all 13 positive rows
and rejected all seven negative rows. These are clip-level presence checks on a small curated set;
they do not prove word-level recall or recall for real marine voice, weak transmissions, short calls,
or changing RF hiss.

The standalone helper was whisper.cpp v1.9.4, SHA256
`d0f2df699262a7954381beb19ecc58c9d5fb2aeeeb2a75188b5fd9b180628050`; the Silero v6.2.0 model had
SHA256 `2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987`. The metrics-only
public validation artifact is `/private/tmp/vhf-public-validation-20261003/metrics.jsonl`, SHA256
`77d352553398754e2b84f2682b8e268a9969c24750f61eed068166e7bcc730fe`.

The speech controls were: the upstream [whisper.cpp JFK sample](https://github.com/ggml-org/whisper.cpp/raw/refs/heads/master/samples/jfk.wav), deterministic noisy derivatives at 0 dB and 8 dB, a 25-second first slice of the US public-domain [George W. Bush radio address](https://commons.wikimedia.org/wiki/File:George_Bush_radio_address_-_October_11,_2008.ogg), and a 25-second first slice of the US public-domain NARA [Laura Bush weekly address](https://commons.wikimedia.org/wiki/File:Weekly_Radio_Address_-_NARA_-_6171394.oga). The JFK source is an upstream benchmark fixture; no separate license is asserted for that sample or its derivatives here. The Bush and Laura slices were converted to 16 kHz mono PCM for testing; the original NARA/Commons downloads had SHA256 `b844a36b9b0c0d777c64f1d62356bf0b6cad6a0f753627f5a7e7abd17c843f0c` and `4adcfe4bb0f0043bcb0fae0a71cb41dd226cd259bb5dcc722986683944346b17`, respectively. White noise and 60 Hz hum were deterministic synthetic controls. The helper used thresholds 0.10, 0.20, and 0.35, minimum speech duration 80 ms, and 200 ms padding.

The reviewed application run reported six VAD checks, five `wouldSkip` results, and zero skipped
batches. That is the intended safe behavior while marine voice recall labels are unresolved. These
counts must not be interpreted as calls rejected by VAD.

The live application remains in observer mode: all four checked batches in the latest interval
would have been classified as no-speech, but none were skipped and all still went to Base. Separately,
an approved offline archive reprocessing script is prepared to classify every existing recording
with Silero first, then re-run Base only for speech-positive recordings. That one-time archival pass
has not been run; it is distinct from the production observer and its counters. Do not copy private
audio, transcript text, or private record identifiers into this report.

## Reproduction and comparison requirements

- Run the checked-in Go tests and Go phase/window benchmarks from `experiments/go-sidecar` with a
  Go toolchain matching its `GOROOT`. A Pi comparison can run the ARM64 test binary
  `/private/tmp/vhf-vhf-go-cache/vhf-watch-sidecar-linux-arm64.test`; record the binary SHA above.
- For Pi CPU comparisons, use the same receiver settings, channel activity, transcription setting,
  recording interval, and temperature/power monitoring before and after. Report both process CPU as
  percent of one core and system busy using the same sampling definition.
- For ASR thread comparisons, keep the Base model, original full PCM, overlap, and cleanup settings
  fixed. Report wall time, aggregate CPU time, normalized transcript comparison, and thermal/power
  flags; output agreement on public clips does not establish marine-call quality.
- Keep the speech detector observational until independently labeled marine voice and non-voice
  examples demonstrate conservative voice recall under hiss, weak speech, and short calls. Record
  threshold and minimum speech duration. A detector zero on a recording with no verified label is
  not a validated skip.
- Treat subprocess-per-record concurrency as a burst test, not inference batching. A true batch
  requires one ordered Silero recurrent state per channel and shared-frame inference; the current
  file helper does not provide that interface.
