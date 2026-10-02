# Third-party notices

The DSC streaming and framing design in `src/dsc.ts` was independently adapted from the DSC receiver in
[GopherTrunk](https://github.com/MattCheramie/GopherTrunk), copyright its contributors and licensed
under the Apache License 2.0. The character error-detection code was independently implemented from
ITU-R M.493's published ten-bit table. The implementation in this package was rewritten in
TypeScript and retains this notice as required by that license.

The optional `vhf-whisper-runtime` Debian package is built from
[`whisper.cpp`](https://github.com/ggml-org/whisper.cpp), copyright its contributors and licensed
under the MIT License, and converted Whisper models such as `base.en-q5_1` and `small.en-q5_1`. The package builder installs
the upstream license and records the exact source and model URLs in the package documentation. No
Whisper binary or model is included in the VHF Watch npm package itself.

The optional `vhf-tts-runtime` Debian package is built from
[`sherpa-onnx`](https://github.com/k2-fsa/sherpa-onnx), licensed under the Apache License 2.0, and
the English Kokoro model and `af_sarah` voice distributed by its official model release. The package
installs the upstream model license and exact source URLs. FFmpeg, supplied by the host operating
system, encodes generated PCM as Ogg Opus. No TTS binary or model is included in the VHF Watch npm
package itself.

The optional `vhf-playback-runtime` Debian package uses the Sherpa-ONNX 1.13.8 C API and its Linux
aarch64 shared CPU runtime (Apache License 2.0), plus ONNX Runtime (MIT License; the package installs
its full license and third-party notices). The GTCRN source implementation and committed streaming
ONNX file are in [Xiaobin-Rong/gtcrn at pinned commit
`502ebfab64da7c4a9af78dcb9c6ceef1ebb01c73`](https://github.com/Xiaobin-Rong/gtcrn/tree/502ebfab64da7c4a9af78dcb9c6ceef1ebb01c73);
the package includes that repository's full MIT notice. The runtime uses the streaming-converted
[`gtcrn_simple.onnx` from Sherpa-ONNX's speech-enhancement-models release](https://github.com/k2-fsa/sherpa-onnx/releases/download/speech-enhancement-models/gtcrn_simple.onnx),
whose hash differs from the pinned source-repository ONNX file. The release asset has no separate
weight-specific license file or embedded license metadata; the package records this source
provenance but does not assert an independently verified license for the converted weight. Runtime,
model, source-model, and notice SHA-256 hashes are pinned in the package builder. No playback runtime
binary or model is included in the VHF Watch npm package.

VHF Watch includes the `somnolent-hogwash` speech/recording-noise model from
[`GregorR/rnnoise-models`](https://github.com/GregorR/rnnoise-models). The repository states that,
apart from its README and tools, the model work is not creative and is not subject to copyright.
FFmpeg's `arnndn` filter executes the model; no RNNoise executable is bundled. The plugin mixes the
denoised result equally with the original signal to preserve narrow-band radio speech detail.
