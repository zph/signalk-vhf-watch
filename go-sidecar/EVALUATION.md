# Whisper comparison on boat-pi

The Go audio sidecar remains experimental and is not installed in Signal K. On 2026-10-01, eight
archived 16 kHz VHF clips were processed offline with `--squelch 0 --hiss adaptive`. Filter latency
was removed and the output was padded to the original WAV duration. Each original and filtered WAV
was transcribed separately by the installed `base.en-q5_1` Whisper model with two threads. The
reproducible harness is [`eval-whisper.mjs`](eval-whisper.mjs). It writes the paired WAVs and full
Whisper output to a private temporary directory; no recordings are committed.

| Archive ID | Channel | Base result after filtering |
| --- | --- | --- |
| 640 | 80A | Same transcript as raw. |
| 599 | 67 | First phrase changed; correctness cannot be judged without listening. |
| 613 | 11 | Repetitive raw transcript became blank; likely suppressed a noise hallucination. |
| 532 | 22A | Forecast remained recognizable but several words and numbers changed. |
| 612 | 11 | Speech transcribed from raw became blank. Small Whisper recognized speech in both WAVs, confirming a Base regression. |
| 596 | 19A | Repetitive raw transcript became a one-word sound label; neither is a reliable transcription. |
| 581 | 18A | Real speech remained, with several changed words. |
| 534 | 22A | Base recovered most of a Coast Guard notice that its raw pass reduced to a closing line. Small Whisper recognized the notice in both WAVs. |

The archived transcript was produced by Whisper and is **not** ground truth. Small Whisper is a
secondary check, not a reference transcript. These results show both a clear Base improvement and a
clear Base regression. Do not feed this filter to the transcription worker by default. Keep raw audio
for Whisper, and treat the filtered output as a listening option until paired recordings have human
transcripts and can be scored for word error rate and preservation of names, numbers, and directions.
