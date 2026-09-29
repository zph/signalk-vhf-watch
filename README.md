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

Install the `rtl_sdr` utility on the Signal K host and make the SDR USB device visible to the Signal K
container. Choose `RTL-SDR wideband` in the plugin configuration and restart the plugin. VHF Watch
opens the tuner once at 1.2 MS/s and sends its IQ stream to worker-backed channelizers. Independent
NFM streams provide the selected voice channel and an uninterrupted 24 kHz Channel 70 DSC decoder.
Changing voice channels inside the capture window does not restart or retune the hardware.

Select the tuner by its stable serial number when possible; a numeric device index is retained for
single-SDR and backward-compatible configurations. Set the receiver's measured PPM correction in
the plugin configuration. If the capture process or USB device fails, VHF Watch retries with bounded
exponential backoff. Status reports receiver restart counts and IQ chunks dropped when the
channelizer cannot keep up, so a trial can distinguish quiet RF from an unhealthy processing path.

The shared capture is centered at 156.750 MHz. Its 1.2 MHz window covers Channel 70, Channel 16, and
nearby simplex marine voice channels simultaneously while remaining sustainable on a Raspberry Pi.
Duplex coast-side and weather channels around 160–162 MHz are
outside an RTL-SDR's instantaneous bandwidth and are disabled in hardware mode. Monitoring those
while retaining continuous DSC requires a second SDR; demo mode continues to expose the full plan.

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

Replay is held only in process memory. Restarting Signal K clears it, and nothing is uploaded. The
configured time window is also capped by a separate memory limit (64 MiB by default), so higher
sample rates cannot silently exhaust an onboard computer.

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

The receiver, rolling buffer, HTTP API, and web UI are deliberately independent of Binnacle so this
plugin can mature before a chart-client integration is added.
