# Third-party notices

The DSC streaming and framing design in `src/dsc.ts` was independently adapted from the DSC receiver in
[GopherTrunk](https://github.com/MattCheramie/GopherTrunk), copyright its contributors and licensed
under the Apache License 2.0. The character error-detection code was independently implemented from
ITU-R M.493's published ten-bit table. The implementation in this package was rewritten in
TypeScript and retains this notice as required by that license.

The optional `vhf-whisper-runtime` Debian package is built from
[`whisper.cpp`](https://github.com/ggml-org/whisper.cpp), copyright its contributors and licensed
under the MIT License, converted Whisper models such as `base.en-q5_1` and `small.en-q5_1`, and the
Silero VAD model. The Silero model is licensed under the MIT License, copyright (c) 2020-present
Silero Team; its complete license is installed in the runtime package. The package records exact
source revisions and model hashes in its documentation. No Whisper or VAD binary or model is
included in the VHF Watch npm package itself.

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

The browser UI vendors the WaveSurfer.js 7.11.1 minified distribution from the npm package
[`wavesurfer.js@7.11.1`](https://www.npmjs.com/package/wavesurfer.js), licensed under BSD-3-Clause.
Its unmodified license is in [`public/vendor/WAVESURFER-LICENSE.txt`](public/vendor/WAVESURFER-LICENSE.txt).
The bundled file is `public/vendor/wavesurfer-7.11.1.min.js` (SHA-256
`3d53013cf5d4e7079e1b3ff445a13571c737393782ffd22bdf5f8d5d16bac807`).
