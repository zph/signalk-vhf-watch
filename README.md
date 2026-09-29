# Signal K VHF Watch

**EXPERIMENTAL**

Receive-only marine VHF monitoring for Signal K with a dedicated touch-friendly web interface,
authenticated live audio, and a private rolling replay buffer.

The default channel plan covers both the United States and Canada. The web interface can switch
between the combined plan, US-only channels from the US Coast Guard table, and Canadian channels
from the Canadian Coast Guard's current Radio Aids to Marine Navigation table. For duplex channels,
the receiver tunes the coast-station frequency that a vessel radio hears.

- US: <https://navcen.uscg.gov/us-vhf-channel-information>
- Canada: <https://www.canada.ca/en/canadian-coast-guard/corporate/publications/radio-aids-marine-navigation/foreword.html#toc3>

VHF Watch deliberately contains **no transmitter or push-to-talk implementation**. It is not a
substitute for a certified marine VHF radio or required watchkeeping equipment. Channel 70 is
continuously decoded as Digital Selective Calling data and is never offered as voice audio.

## First run without hardware

The plugin defaults to `Demo audio`. Install and enable it, then open `/signalk-vhf-watch/`. The demo
receiver generates a quiet periodic two-tone signal so the entire live/replay workflow can be tested
without radio hardware.

## RTL-SDR receiver

Install the `rtl_sdr` utility on the Signal K host, then make the SDR USB device visible to Signal K.
The npm package includes a statically linked `linux-arm64` sidecar, so Go is not required on the Pi;
the configurable sidecar path supports development builds and future platforms. Choose `RTL-SDR
wideband` in the plugin configuration and restart the plugin. The native sidecar opens the tuner at 2.4 MS/s and performs both channelizers;
only low-rate PCM crosses into JavaScript. Independent NFM streams provide the selected voice
channel and an uninterrupted 24 kHz Channel 70 DSC decoder. Changing voice channels inside the
capture window does not restart or retune the hardware.

Select the tuner by its stable serial number when possible; a numeric device index is retained for
single-SDR and backward-compatible configurations. Set the receiver's measured PPM correction in
the plugin configuration. If the capture process or USB device fails, VHF Watch retries with bounded
exponential backoff. Status reports receiver restart counts and IQ chunks dropped when the
channelizer cannot keep up, so a trial can distinguish quiet RF from an unhealthy processing path.

Marine mode is centered at 156.75 MHz. Its 2.4 MHz window covers Channel 70, Channel 16, and
the 156–157.425 MHz simplex marine voice range simultaneously. A live Raspberry Pi trial sustained
this native dual-channel DSP with more than 30× processing headroom and no RTL-SDR sample loss.
Duplex coast-side and weather channels around 160–162 MHz are outside that instantaneous window.
Selecting one in fixed Slot A mode switches the same SDR into single-frequency reception centered on
that channel; Slot B, scanning, and Channel 70 DSC are visibly paused until Slot A returns to a marine
channel. Monitoring a distant channel while retaining continuous DSC still requires a second SDR.

An RTL-SDR Blog V4 already used by AIS-Catcher is valid prototype hardware, but the two programs
cannot own the same USB tuner at the same time. Stop AIS-Catcher before selecting the wideband
receiver source. AIS at 161.975/162.025 MHz and Channel 70/voice near 156–157 MHz do not fit in one
instantaneous capture window. Use a second receiver when continuous AIS and marine voice/DSC are
both required.

For a controlled one-SDR trial, stop `ais-catcher.service`, enable VHF Watch, and verify its status
before listening. Reverse that order when restoring AIS: disable VHF Watch or stop Signal K's
receiver, start AIS-catcher, and verify that fresh AIS messages resume. Never run both processes
against the same tuner and treat repeated device-open failures as harmless contention.

When Signal K runs in Podman, pass the SDR through to the container, preferably by stable USB path or
device identity rather than a changing bus number. The container image must include `rtl_sdr`.

Do not connect an SDR to the same coax as a transmitting VHF with a passive tee. Use a separate
receive antenna or a marine transmit-rated active splitter with a protected and muted receiver port.

## API

All endpoints are under `/plugins/signalk-vhf-watch` and use Signal K access control.

- `GET /api/status` — receiver and buffer state
- `GET /api/channels` — supported receive channels
- `POST /api/region` — select `US_CA`, `US`, or `CA`
- `POST /api/channel` — tune the receiver; body `{ "channel": "16" }`
- `GET /api/live.wav` — private live streaming WAV
- `GET /api/dsc` — decoded Channel 70 calls (MMSI/category/position when present)
- `DELETE /api/dsc` — clear decoded calls
- `GET /api/replay` — replay segment metadata
- `GET /api/replay/:id.wav` — one replay segment
- `DELETE /api/replay` — clear the rolling buffer
- `DELETE /api/replay/:id` — delete one retained replay segment
- `GET /api/transcripts` — retained transcript/audio metadata
- `GET /api/transcripts/:id.wav` — play one retained transcript's audio

Replay is held only in process memory. Restarting Signal K clears it, and nothing is uploaded. The
configured time window is also capped by a separate memory limit (64 MiB by default), so higher
sample rates cannot silently exhaust an onboard computer.

The native receiver preserves low-rate unsquelched voice PCM in that bounded replay buffer together
with discriminator-noise metadata. The Recent radio control can therefore apply a different squelch
when a segment is played without changing live listening or future recordings; `Off / raw` is useful
for investigating weak signals.

### Optional local transcription

Voice transcription is **off by default** and only starts after an operator explicitly enables
**Transcribe voice** in the VHF Watch page. That choice is stored in the plugin's private data
directory and survives Signal K restarts. Disabling it stops the worker and clears its queue.

Transcription requires the separately installed `vhf-whisper-runtime` Debian package. The receiver,
DSC decoder, live audio, and replay remain fully functional without it, and the UI will refuse to
enable transcription until `/usr/bin/vhf-whisper` is installed. The runtime uses the offline
`whisper.cpp` `base.en-q5_1` model with two CPU threads and its normal audio context by default. The
web UI discovers every model installed by the runtime package and durably selects both model and a
1–16 thread count. This boat package also includes `small.en-q5_1`; larger server installations can
add Medium or Large model files without changing the plugin. Off-air NOAA
marine forecasts showed that Base recovered substantially more radio speech and nearby place names
than Tiny. Timestamp-aware decoding is retained for reliable long-window alignment; the plugin strips
the timestamp labels before display. Adjacent
one-minute replay slices are exposed to the timeline while they are still growing and are combined into recognition windows. Successive windows reuse
ten seconds of audio for linguistic context, then reconcile the repeated text with the preceding
result so it is not shown twice. A shorter final window runs after the channel has been quiet for six
seconds. The decode watchdog is at least 90 seconds and scales to twice the audio duration, so a full
one-minute window receives two minutes to finish. Batches that pass the configured RF squelch are
processed one at a time; audio is not uploaded.

Completed batches are stored in the plugin's private `transcript-archive/transcripts.sqlite3` database with their
channel, start/end times, duration, sample rate, RF-noise metadata, transcript, and Zstandard-
compressed WAV. The Transcript archive section can play every retained record after a Signal K
restart. Records expire after 30 days or when the complete SQLite database reaches 100 MiB,
whichever happens first; the oldest records are removed first. The database and its containing
directory are created with service-account-only permissions. This archive requires Node.js 22.15 or
newer for the built-in SQLite and Zstandard implementations.

For an ARM64 or AMD64 package built from the matching `whisper.cpp` release, run the packaging helper
on the target Debian architecture, then install the resulting file with
`apt install ./vhf-whisper-runtime_*.deb`:

```sh
packaging/build-whisper-runtime-deb.sh /path/to/whisper.cpp/build/bin /tmp \
  /path/to/whisper.cpp/models/ggml-base.en-q5_1.bin \
  /path/to/whisper.cpp/models/ggml-small.en-q5_1.bin
```

The measured Pi CPU, memory, thermal, speed, and sample-quality tradeoffs are recorded in
[`docs/WHISPER_BENCHMARK.md`](docs/WHISPER_BENCHMARK.md).

Accepted DSC calls are different: they survive Signal K restarts in the plugin's private data
directory. The cache is pruned by age (seven days by default), call count (100 by default), and a
hard serialized-size limit (256 KiB by default). Incomplete, unknown-format, unknown-category, or
character-error decodes are discarded rather than shown as calls.

DSC decoding follows ITU-R M.493's ten-bit character table and 1,300/2,100 Hz VHF signalling. It is
experimental and must be validated against known-good, legally obtained over-the-air IQ captures;
never generate a distress alert for testing.

To replay a demodulated DSC recording through the same decoder used by the plugin, convert it to
24 kHz, mono, signed 16-bit PCM WAV and run:

```sh
npm run build
npm run decode:dsc-wav -- /path/to/capture.wav
```

The command exits unsuccessfully when it finds no complete DSC message, making a documented capture
suitable for a manual regression check without transmitting anything.

## Development

```sh
npm install
npm test
npm pack --dry-run
```

Go is a build dependency only. Published artifacts should be complete architecture-specific npm
packages containing `bin/<platform>-<architecture>/vhf-watch-sidecar`; the current experimental
artifact contains Linux ARM64. A release build matrix should compile and test each static sidecar,
insert it into the matching package, and attach those packages to the same GitHub release.

The receiver, rolling buffer, HTTP API, and web UI are deliberately independent of Binnacle so this
plugin can mature before a chart-client integration is added.
