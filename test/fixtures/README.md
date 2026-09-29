# External DSC validation sample

The VHF DSC audio on Signal Identification Wiki was used transiently to validate the decoder on
2026-09-29:

- Page: <https://www.sigidwiki.com/wiki/GMDSS_Digital_Selective_Calling>
- Audio: <https://www.sigidwiki.com/images/d/d5/Gmdss_vhf_247365000.mp3>
- Independent published decode: <https://jeremyclark.ca/wp/telecom/rtl-sdr-for-marine-gmdss-dsc-on-multipsk/>
- SHA-256 of the tested MP3: `dc2d68e671ac7cd94012f24e8b36e676f2af990d21d8bee1176dd4866aa039c9`

The site administrator describes the material as: “All recordings and images from this website are
shown and given as-is for educational purpose.” The site does not attach the Unlicense, Creative
Commons terms, or another explicit redistribution license to the file, so the MP3 is deliberately
not copied into this repository.

After conversion to 24 kHz mono 16-bit PCM, `npm run decode:dsc-wav` produced this clean symbol
sequence:

```text
120,120,24,73,65,0,0,100,24,73,65,0,0,100,126,90,0,6,126,126,126,117
```

The independently published decoder screenshot identifies it as an individual routine call from
MMSI `247365000` to MMSI `247365000`, with end-of-sequence symbol `117`. The facts and decoded
symbol sequence are captured in `test/dsc.test.ts` as a regression test without redistributing the
audio recording.
