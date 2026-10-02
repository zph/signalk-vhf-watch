# Go audio sidecar prototype

`vhf-audio-sidecar` is an independent Go implementation of VHF Watch's voice squelch and optional
adaptive hiss filter. It is a **frame-stream filter**, not an RTL-SDR capture program. Feed it the
native sidecar's framed stdout and it writes the same frame format to stdout. Each frame has a
one-byte kind, a little-endian 32-bit payload length, and a payload. It processes Slot A voice
(kind 1) and Slot B voice (kind 4), whose payloads begin with a little-endian float64 discriminator
noise measurement followed by mono signed 16-bit PCM. DSC (kind 2), status (kind 3), and other
frames pass through unchanged. This lets the audio stage merge into the deployed Go receiver later
without changing DSC or the RF channelizers.

The gate uses FM carrier quieting rather than PCM loudness. At the default squelch level 20, it
opens below a measured discriminator noise value of 0.22 and closes above 0.264. A 250 ms hang and
short fades avoid chatter and clicks. Each voice slot keeps independent state. The thresholds use
the deployed sidecar's documented strong-carrier (~0.05) and idle (~0.31–0.34) measurements and
still need testing with weak real calls.

Adaptive mode estimates a spectral noise floor from noise-like frames, applies smoothed Wiener-style
gains, and limits audio to the voice band. It runs before the gate, so silence from squelch never
contaminates its noise estimate. It adds approximately 32 ms latency and is off by default. This
remains an experiment for listening comparisons; it has not shown an overall transcription gain on
boat-pi audio.

[The paired Base Whisper evaluation](EVALUATION.md) found both recovered and lost speech. Keep
transcription on the raw audio path; adaptive mode is for listening trials only.

```sh
cd go-sidecar
go test ./...
go build -o /tmp/vhf-audio-sidecar ./cmd/vhf-audio-sidecar
/tmp/vhf-audio-sidecar --audio-rate 16000 --squelch 20 --hiss adaptive < captured.frames > cleaned.frames
```

The prototype does not replace the deployed receiver. Its output must be connected to a client
that understands the native frame protocol; do not stream the binary frames to a speaker.
