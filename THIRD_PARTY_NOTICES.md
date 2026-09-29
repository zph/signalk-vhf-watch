# Third-party notices

The DSC streaming and framing design in `src/dsc.ts` was independently adapted from the DSC receiver in
[GopherTrunk](https://github.com/MattCheramie/GopherTrunk), copyright its contributors and licensed
under the Apache License 2.0. The character error-detection code was independently implemented from
ITU-R M.493's published ten-bit table. The implementation in this package was rewritten in
TypeScript and retains this notice as required by that license.

The optional `vhf-whisper-runtime` Debian package is built from
[`whisper.cpp`](https://github.com/ggml-org/whisper.cpp), copyright its contributors and licensed
under the MIT License, and the converted `tiny.en-q5_1` Whisper model. The package builder installs
the upstream license and records the exact source and model URLs in the package documentation. No
Whisper binary or model is included in the VHF Watch npm package itself.
