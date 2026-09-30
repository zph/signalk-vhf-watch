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

VHF Watch includes the `somnolent-hogwash` speech/recording-noise model from
[`GregorR/rnnoise-models`](https://github.com/GregorR/rnnoise-models). The repository states that,
apart from its README and tools, the model work is not creative and is not subject to copyright.
FFmpeg's `arnndn` filter executes the model; no RNNoise executable is bundled. The plugin mixes the
denoised result equally with the original signal to preserve narrow-band radio speech detail.
