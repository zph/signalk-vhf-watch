# ARM64 FIR optimization validation

This record separates a controlled Pi replay from the live before/after observation. The
controlled replay is the primary performance result. Live radio traffic and transcription activity
varied between windows, so the live system-wide CPU change is not attributable to the DSP change
alone.

## Tested artifacts and workload

The isolated stage commit `401a1d14a0abfbb910122d59a19ba98f21e59be3` is based on the deployed
`036df6f69b23c5bdc46d167dba13292f1d67588b` source and contains the reviewed FIR optimization and
its tests only. The packaged Linux/ARM64 sidecar SHA256 is
`e52c362ef1eb1ee27f850ea20a8504d2050cf3372db77df0e7d8e90ad14130e2`; it matches the candidate
used for replay. The previously deployed reference sidecar SHA256 is
`e484462fd4c148f85d11c4d9e9b9a486bb395679a9f403efb52c7b513dc77480`.

The private Pi-local input was a 10-second, 48,000,000-byte interleaved CU8 capture at 2.4 MS/s,
centered on WX4 at 162.425 MHz, using RTL device `00000001`, PPM 0, and default gain. Its SHA256 is
`cdd304f0496d81536cc2d07866a013fa2990c12573ef4f1982b8cf01daff4cd2`. It remained on the Pi at
`/var/tmp/vhf-neon-benchmark-20261003/wx4-162425000-10s.cu8`; no IQ or audio data was exported.

Three alternating old/candidate pairs replayed that exact fixture through the same Go test harness.
Each run used `-test.run '^$' -test.bench '^BenchmarkReceiverReplay$' -test.benchtime=1x
-test.count=1 -test.v` with `VHF_BENCH_IQ_PATH` set to the Pi-local fixture. The harness emitted
aggregate PCM hashes and sample counts for these scenarios:

- `WX4_fixed_voice_plus_DSC`, matching the actual single-frequency receiver configuration.
- `wideband_A16_plus_DSC_plus_scanner45_cost_on_WX4_fixture`.
- `wideband_A16_B68_DSC_scanner45_cost_on_WX4_fixture`.

The latter two are controlled DSP workload scenarios using the same captured bytes; they are not
claims of captured A16/B68 signal quality. “45” is the scanner frequency count, not an FFT-bin
count. The exact paired replay runner binaries were baseline
`5bd082393db464ef994ca2eb8c24c85c6b300f6c219fd01fa17b61f129fe64bd` and candidate
`95de560c1c21d9c24d773873906017c5a258c58cdbfcc97f429cd1dd8163df3b`.

## Paired Pi replay

Each scenario timing below is Go `ns/op` converted to seconds per 10 seconds of input. Pair order
was old 1, candidate 1, old 2, candidate 2, old 3, candidate 3. All nine paired scenario outputs
had identical PCM sample counts, PCM SHA256 values, activity counts, and activity SHA256 values.

| Scenario | Old pair 1 | Candidate 1 | Old pair 2 | Candidate 2 | Old pair 3 | Candidate 3 | Mean change |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| WX4 voice + DSC | 1.8296 s | 1.1020 s | 1.8240 s | 1.1156 s | 1.8392 s | 1.1094 s | 1.831 → 1.109 s (−39.4%) |
| A16 + DSC + 45 scanner frequencies | 1.8345 s | 1.0599 s | 1.8414 s | 1.0605 s | 1.8430 s | 1.0637 s | 1.840 → 1.061 s (−42.3%) |
| A16 + B68 + DSC + 45 scanner frequencies | 1.9038 s | 1.1154 s | 1.9136 s | 1.0792 s | 1.8867 s | 1.1077 s | 1.901 → 1.101 s (−42.1%) |

Whole test-run resource use (three scenarios per process) averaged 5.765 seconds wall and 13.227
seconds user CPU for the reference, versus 3.461 seconds wall and 7.809 seconds user CPU for the
candidate. Average system CPU time was 0.029 versus 0.039 seconds, respectively. The user CPU
reduction was 41.0%; total user-plus-system CPU reduction was 40.8%. The per-scenario figures are
the most direct DSP comparison; process startup and harness work are included in the whole-run
resource figures.

The Pi reported an active ARM clock of 2.2 GHz for every paired run. Run temperatures peaked at
69.2–70.8°C for the reference and 69.2–72.5°C for the candidate. `vcgencmd get_throttled` was
`0xf0000` throughout, meaning historical bits only; no current low throttle or undervoltage bits
were set. An accidental extra unpaired reference run during controller recovery is excluded from
all results.

### FIR kernel microbenchmark

One Pi run compared the old ring-buffer path, contiguous scalar path, and ARM64 kernel. Values are
nanoseconds per input sample; all paths allocated zero bytes and made zero allocations.

| Taps / decimation | Old ring | Contiguous scalar | ARM64 kernel |
| --- | ---: | ---: | ---: |
| 63 / 5 | 37.82 ns | 29.23 ns | 20.47 ns |
| 511 / 5 | 182.5 ns | 171.8 ns | 85.83 ns |

The microbenchmark peaked at 64.8°C with the ARM clock at 2.2 GHz and no current throttle or
undervoltage flags.

## Live before/after observation

Both windows used Base transcription with one thread, fixed WX4 on slot A, configured fixed channel
68 on slot B, and the same 2.4 MS/s receiver settings. The plugin actually ran single-frequency
WX4 capture; slot B and DSC were paused. The before and after windows each contributed 132.2
seconds of plugin-ready samples. The before run stopped at its 78°C safety guard (a 78.5°C
sample); the post run completed its full interval without hitting the 78°C guard or any current
power/throttle flag.

| Metric | Before | After |
| --- | ---: | ---: |
| Samples | 26 | 27 |
| Whole-system busy mean / p95 / max | 34.48% / 46.91% / 73.42% | 26.62% / 40.62% / 67.26% |
| Sidecar CPU mean (% of one core) | 39.91% | 24.10% |
| Signal K Node CPU mean (% of one core) | 27.26% | 24.67% |
| Whisper CPU mean over full window (% of one core) | 49.96% | 36.92% |
| Whisper CPU while reported transcribing (% of one core) | 86.60% (15 samples) | 90.62% (11 samples) |
| Temperature mean / max | 70.85°C / 78.5°C | 69.52°C / 75.7°C |
| VAD checked / would-skip / skipped | 2 / 0 / 0 | 1 / 0 / 0 |
| Maximum IQ drops / receiver restarts | 0 / 0 | 0 / 0 |

Live total CPU is not a matched causal result: recordings and ASR-active samples differed (15 of 26
before, 11 of 27 after), and Whisper consumed about one core while active. In the ASR-active
subsets, system busy averaged 41.51% before and 36.50% after, while sidecar CPU averaged 39.61%
and 23.40% of one core. These observations are consistent with lower DSP cost, but changing radio
traffic prevents a strict live attribution. The fixed-input replay above is the controlled
evidence.

The post deployment left the receiver enabled because service and webapp health remained good, the
receiver reported receiving, temperature was below the guard, and current flags were clear.
Signal K root health returned HTTP 200 and the webapp returned HTTP 200. Global settings, tuning,
transcription, and DSC settings hashes remained unchanged. Only the authorized outer enabled flag
changed; its JSON hash changed from `325db1b4a09213f20a86c7e92f757b92a659bc63a4e42cc05ec3a2c7c1f2397e`
to `2930abb533504e1ea1057e52bf6ce80ba7b7e594b275ed2f182e4c5fea5dc9ea`.

## Reproduction

Capture was performed on boat-pi with the outer VHF setting disabled, no VHF sidecar owning the tuner, temperature at or below 65°C, and current throttle/undervoltage mask `0x0f` clear. The wrapper checked temperature every 0.5 seconds and stopped at 75°C or any current low flag. It ran:

```sh
/usr/bin/rtl_sdr -d 00000001 -f 162425000 -s 2400000 -p 0 -n 48000000 - > "$fixture"
```

RTL-SDR `-n` counts complex samples, so it can produce 96,000,000 bytes. The wrapper retained the first 48,000,000 bytes (10 seconds) by truncating the file, then fsyncing it, setting mode `0600`, and verifying SHA256 `cdd304f0496d81536cc2d07866a013fa2990c12573ef4f1982b8cf01daff4cd2`. The resulting fixture stayed on the Pi.

Both test runners used Go 1.26.3 (`GOROOT=/Users/zph/.local/share/mise/installs/go/1.26.3`) with `GOOS=linux GOARCH=arm64 GOARM64=v8.0 CGO_ENABLED=0`. The baseline source was `main.go` from `036df6f` plus the current `receiver_replay_test.go`; from the repository root:

```sh
mkdir -p /private/tmp/vhf-replay-baseline
git show 036df6f:experiments/go-sidecar/main.go > /private/tmp/vhf-replay-baseline/main.go
cp experiments/go-sidecar/go.mod /private/tmp/vhf-replay-baseline/go.mod
cp experiments/go-sidecar/receiver_replay_test.go /private/tmp/vhf-replay-baseline/
export GOROOT=/Users/zph/.local/share/mise/installs/go/1.26.3
export PATH="$GOROOT/bin:$PATH"
cd /private/tmp/vhf-replay-baseline
GOOS=linux GOARCH=arm64 GOARM64=v8.0 CGO_ENABLED=0 \
  go test -c -o /private/tmp/vhf-baseline-replay-arm64.test
```

To rebuild the candidate test runner from stage commit `401a1d14a0abfbb910122d59a19ba98f21e59be3`:

```sh
cd /private/tmp/vhf-neon-stage/experiments/go-sidecar
export GOROOT=/Users/zph/.local/share/mise/installs/go/1.26.3
export PATH="$GOROOT/bin:$PATH"
GOOS=linux GOARCH=arm64 GOARM64=v8.0 CGO_ENABLED=0 \
  go test -c -o /private/tmp/vhf-neon-bench-linux-arm64.test
```

For a production binary built from the same stage source:

```sh
GOOS=linux GOARCH=arm64 GOARM64=v8.0 CGO_ENABLED=0 \
  go build -trimpath -ldflags='-s -w' -o ../../bin/linux-arm64/vhf-watch-sidecar .
```

The measured runners were copied to boat-pi as `/var/tmp/vhf-neon-benchmark-20261003/old-vhf-watch-sidecar.test` and `new-vhf-watch-sidecar.test`, mode `0700`. Their SHA256 values were `5bd082393db464ef994ca2eb8c24c85c6b300f6c219fd01fa17b61f129fe64bd` and `95de560c1c21d9c24d773873906017c5a258c58cdbfcc97f429cd1dd8163df3b`. The installed sidecar was the exact replay-tested candidate artifact, SHA256 `e52c362ef1eb1ee27f850ea20a8504d2050cf3372db77df0e7d8e90ad14130e2`; rebuilds can differ because Go embeds VCS metadata.

The initial run required start temperature at or below 65°C and current mask `0x0f` clear. After a cooldown race, remaining pairs required two consecutive readings at or below 62°C. The controller cooled between runs, sampled temperature/current flags every 250 ms, and stopped at 78°C or any current low flag. The selected run order was old1, candidate1, old2, candidate2, old3, candidate3. Verify the fixture SHA before replay:

```sh
printf '%s  %s\n' \
  cdd304f0496d81536cc2d07866a013fa2990c12573ef4f1982b8cf01daff4cd2 \
  /var/tmp/vhf-neon-benchmark-20261003/wx4-162425000-10s.cu8 | sha256sum -c -
```

A manual run uses:

```sh
VHF_BENCH_IQ_PATH=/var/tmp/vhf-neon-benchmark-20261003/wx4-162425000-10s.cu8 \
  /usr/bin/time -v /var/tmp/vhf-neon-benchmark-20261003/old-vhf-watch-sidecar.test \
  -test.run '^$' -test.bench '^BenchmarkReceiverReplay$' -test.benchtime=1x \
  -test.count=1 -test.v
```

Use `new-vhf-watch-sidecar.test` for candidate runs. The recorded controller did not use `/usr/bin/time -v`: it measured wall time with a monotonic clock, child user/system CPU with Python `resource.getrusage(RUSAGE_CHILDREN)`, and sampled ARM clock during each run. Each Go `ns/op` value is one iteration over the 10-second fixture. An extra unpaired reference run during controller recovery is excluded from results.

Metrics-only Pi logs:

- Pair 1: `/var/tmp/vhf-neon-benchmark-20261003/paired-replay.jsonl`, SHA256 `b6db8db2737513674190baffec8e3a6489f150f5d54a700217de8b34bec7862f`.
- Pairs 2–3 and FIR: `/var/tmp/vhf-neon-benchmark-20261003/paired-replay-pairs2-3.jsonl`, SHA256 `5a80192190e7387f1c76e09da52b3c2f19c77afd99786726eeb8b794ee7616d8`.
- Live before: `/var/tmp/vhf-neon-benchmark-20261003/live-pre.jsonl`, SHA256 `f9deee8153008cb0fb5975ddfb7718b422087e3494e210a74fe593db2b89745c`.
- Live after: `/var/tmp/vhf-neon-benchmark-20261003/live-post-neon.jsonl`, SHA256 `96ddbc816a8d3a513cfc6bd24ac7b9161a140d3f5df6ea7d54baa4790605a93b`.

The replay validates deterministic DSP cost and output parity. It does not evaluate RF reception quality, scanner coverage, or transcription accuracy. Live CPU values are workload observations, not an overnight thermal result.

### Stable output hashes

These per-scenario values were identical in all six selected runs:

| Scenario | Voice samples / PCM SHA256 | Slot B samples / PCM SHA256 | DSC samples / PCM SHA256 | Scanner activity |
| --- | --- | --- | --- | --- |
| WX4 voice + DSC | 160,000 / `61d7e439f25db16d53251a7e20d74a43104b446b9e2008ceae2e1c7c77b1d23d` | 0 / empty | 240,000 / `d6c7ab38e9257c6be767d5b6892741e2ce18b7c162cb8cf7ce0c76099ac7f3b3` | 0 / empty |
| A16 + DSC + 45 scanner frequencies | 160,000 / `40b9bccd679e4abc25f8109bcfb8cfabeaf2a1f95c6952cf19ea1b0a927ff9c0` | 0 / empty | 240,000 / `ba41398beb7456fe5e1a899656ed6e0d99335fdd8bea60a3b2bd1aa19c332c6a` | 45 / `09a2c61915913c5e9557a819fbcba7f6907e0577cc9cdc6d0fb4a232f1ace51f` |
| A16 + B68 + DSC + 45 scanner frequencies | 160,000 / `40b9bccd679e4abc25f8109bcfb8cfabeaf2a1f95c6952cf19ea1b0a927ff9c0` | 160,000 / `94f35c192a0de27bb50469ff441bb2d1e751a47ea1b30f7db9a00d4f27d5b09b` | 240,000 / `ba41398beb7456fe5e1a899656ed6e0d99335fdd8bea60a3b2bd1aa19c332c6a` | 45 / `09a2c61915913c5e9557a819fbcba7f6907e0577cc9cdc6d0fb4a232f1ace51f` |
