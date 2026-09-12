# Signal K VHF Watch

Receive-only marine VHF monitoring for Signal K with a dedicated touch-friendly web interface,
authenticated live audio, and a private rolling replay buffer.

VHF Watch deliberately contains **no transmitter or push-to-talk implementation**. It is not a
substitute for a certified marine VHF radio or required watchkeeping equipment. Voice channel 70 is
not offered because channel 70 is reserved for Digital Selective Calling.

## First run without hardware

The plugin defaults to `Demo audio`. Install and enable it, then open `/signalk-vhf-watch/`. The demo
receiver generates a quiet periodic two-tone signal so the entire live/replay workflow can be tested
without radio hardware.

## RTL-SDR receiver

Install `rtl_fm` on the Signal K host and make the SDR USB device visible to the Signal K container.
Choose `RTL-SDR using rtl_fm` in the plugin configuration and restart the plugin. VHF Watch invokes
`rtl_fm` directly without a shell and demodulates one selected channel at a time to 16-bit mono PCM.

An RTL-SDR Blog V4 already used by AIS-Catcher is valid prototype hardware, but the two programs
cannot own the same USB tuner at the same time. Stop AIS-Catcher before selecting the `rtl_fm`
receiver source. AIS at 161.975/162.025 MHz and voice channel 16 at 156.800 MHz also do not fit in
the V4's approximately 2.56 MHz instantaneous capture window. Use a second receiver when continuous
AIS and marine voice monitoring are both required. NOAA weather channels near 162 MHz fit near AIS,
but concurrent decoding would still require one shared channelizer rather than two processes opening
the dongle; that is intentionally outside this first reliable prototype.

When Signal K runs in Podman, pass the SDR through to the container, preferably by stable USB path or
device identity rather than a changing bus number. The container image must include `rtl_fm`.

Do not connect an SDR to the same coax as a transmitting VHF with a passive tee. Use a separate
receive antenna or a marine transmit-rated active splitter with a protected and muted receiver port.

## API

All endpoints are under `/plugins/signalk-vhf-watch` and use Signal K access control.

- `GET /api/status` — receiver and buffer state
- `GET /api/channels` — supported receive channels
- `POST /api/channel` — tune the receiver; body `{ "channel": "16" }`
- `GET /api/live.wav` — private live streaming WAV
- `GET /api/replay` — replay segment metadata
- `GET /api/replay/:id.wav` — one replay segment
- `DELETE /api/replay` — clear the rolling buffer

Replay is held only in process memory. Restarting Signal K clears it, and nothing is uploaded. The
configured time window is also capped by a separate memory limit (64 MiB by default), so higher
sample rates cannot silently exhaust an onboard computer.

## Development

```sh
npm install
npm test
npm pack --dry-run
```

The receiver, rolling buffer, HTTP API, and web UI are deliberately independent of Binnacle so this
plugin can mature before a chart-client integration is added.
