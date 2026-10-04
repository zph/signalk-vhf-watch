# Continuous weather-channel ASR comparison

This report evaluates Tiny.EN as an optional weather model and measures reuse of loaded models. The
production default is Base Q5_1 with two threads for both weather and marine routes. Tiny is not
selected automatically because its private weather transcript differs substantially from Base, and
resident workers are off by default because the measured inference speed was essentially unchanged.
Private radio audio and decoded text stayed on boat-pi. WX transcripts have no independent reference,
so Tiny/Base comparisons below describe disagreement, not accuracy. English number words and digit
tokens can also represent the same value while differing in the token comparison.

## Controlled weather sample

One fixed 60-second WX4 recording was replayed locally on boat-pi. Both paths received the same
mono 16 kHz PCM16 audio after the current 50% RNNoise mix. The audio SHA256 is
`8b62893c20d67a332d56d23bb2d94829f81f5f7e6ff666593c5d028587f35495`; it was not copied off the Pi.
The RNNoise model SHA256 was `70bb6685eb0c2a1d18e2918dca3fbfbd39317010b1802eb1b6ea73a92f3fdec0`.
The Base Q5_1 model SHA256 was `4baf70dd0d7c4247ba2b81fafd9c01005ac77c2f9ef064e00dcf195d0e2fdd2f`; the Tiny.EN Q5_1
model SHA256 was `c77c5766f1cef09b6b7d47f21b546cbddd4157886b3b5d6d4f709e91e66c7c2b`.

Initial fresh-process CLI comparison used the same beam size 5, best-of 5, English and CPU-only
settings. It used the whisper.cpp CLI's default no-context setting; no text from prior requests was
carried between independent clips:

| Model / threads | Wall time | User CPU | Peak RSS | Output |
| --- | ---: | ---: | ---: | --- |
| Base Q5_1 / 1 | 56.76 s | 56.64 s | 245,568 KiB | nonempty |
| Tiny.EN Q5_1 / 1 | 22.36 s | 22.30 s | 198,160 KiB | nonempty |
| Base Q5_1 / 2 | 28.35 s | 55.80 s | 274,384 KiB | nonempty |
| Tiny.EN Q5_1 / 2 | 14.23 s | 27.75 s | 199,136 KiB | nonempty |

For this one clip, Tiny was about 61% faster than Base at one thread and about 50% faster at two
threads. Those are single-run elapsed-time comparisons, not steady-state server results. Two
threads roughly halved wall time. Base user CPU was nearly unchanged at one versus two threads
(56.64 versus 55.80 s), while Tiny used 27.75 s at two threads compared with 22.30 s at one thread,
about 24% more CPU. Thread counts remain configurable; both production routes now default to Base
with two threads.

With Tiny.EN Q5_1 at one thread and the same decoder options, the persistent server's first request
took 22.348 s wall / 22.320 s server CPU; a second request to the same process took 22.292 s wall /
22.280 s server CPU. Fresh CLI took 22.36 s / 22.30 s. This clip shows no meaningful inference-time
gain from a resident model; readiness took 108 ms, and the worker used no measurable CPU during a
five-second idle interval. After timestamp cleanup and word normalization, the Tiny one-thread
fresh CLI and server outputs matched exactly at 132 words; server cold and warm outputs also matched
exactly. A separate Base two-thread server pair took 27.99 / 28.19 seconds wall and 55.37 / 55.54
seconds CPU, and matched the normalized CLI output exactly. Keeping workers warm reduces startup and
reload work, but did not materially shorten either inference in these samples.

For the private weather clip, normalized word disagreement was measured using the left-hand output
as the denominator. Base one-thread versus Tiny one-thread differed by 54 edits over 121 Base words
(44.6%); Base two-thread versus Tiny two-thread differed by 52 edits over 124 Base words (41.9%).
Changing Base from one to two threads differed by 22 edits over 121 Base words (18.2%); changing
Tiny from one to two threads differed by 39 edits over 132 Tiny words (29.5%). Every output was
nonempty. These are model/thread disagreement measures, not WER: the weather clip has no independent
transcript, and spoken number words can differ from digits while expressing the same value. This
degree of disagreement is why the production default remains Base rather than Tiny.

## Context-overlap comparison

This synthetic comparison duplicated the last 2 seconds or last 10 seconds of the same 60-second
RNNoise-mixed WX4 clip in front of that same 60-second body. It did not join adjacent broadcast
segments. The resulting 62-second and 70-second inputs took 28.52 and 29.70 seconds wall time,
respectively; user CPU was 56.26 and 58.53 seconds. The outputs differed by 16 edit operations over
127 words in the shorter-window output. This measures the cost and output change of adding eight
seconds of duplicated overlap; it is not a quality or accuracy comparison because neither window has
a verified transcript.
The corresponding 2-second and 10-second WAV hashes are `3c2ddc2d8a898c506e810a2fe9ed5f4f159f7ac7591492a1c0b1423da9d0da42`
and `546898e1e5ebbb3b3c28bc0cd14f2bf762b6ca60d7434c20dca7e0d7d66112cb`.

## Public labeled control

The independent speech control is the 11-second `samples/jfk.wav` fixture from the official
[whisper.cpp repository](https://github.com/ggml-org/whisper.cpp), scored against its 22-word
reference: “And so my fellow Americans, ask not what your country can do for you, ask what you can do
for your country.” Clean and fixed 10 dB white-noise versions used identical decoding parameters.
The noise is deterministic uniform noise generated with xorshift seed 1337; it is a stress control,
not a measured radio channel.
After applying the production `cleanWhisperOutput` rules and aligning case-folded, punctuation-free
word tokens:

| Model | Input | Substitutions | Deletions | Insertions | WER |
| --- | --- | ---: | ---: | ---: | ---: |
| Base Q5_1 / 1 thread | Clean | 0 | 0 | 0 | 0% |
| Base Q5_1 / 2 threads | Clean | 0 | 0 | 0 | 0% |
| Tiny.EN Q5_1 / 1 thread | Clean | 1 | 0 | 1 | 9.1% |
| Base Q5_1 / 1 thread | 10 dB white noise | 1 | 0 | 0 | 4.5% |
| Base Q5_1 / 2 threads | 10 dB white noise | 1 | 0 | 0 | 4.5% |
| Tiny.EN Q5_1 / 1 thread | 10 dB white noise | 2 | 0 | 0 | 9.1% |

The clean source WAV SHA256 is `59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e`;
the 10 dB noisy source is `e800db68f50d7602fad0f96bd83ff4b58e769214189e1f0fd1a3285df4b82902`. After
the production 50% RNNoise mix, their hashes are `4b8eeb4bbaca81e46db534fb412933e157ce64a41f27d0e5edef6786eec4c859`
and `ecab2678fe7be4e09436db1147726489dddc5544ad1d4b49d38269bfc03c338a`, respectively.

This short public speech control is useful for checking general speech recognition and the scoring
path, but it does not establish weather-radio or marine-radio accuracy.

## Measurement method and privacy

Every model comparison uses the same input bytes and decoder settings unless the row explicitly
names the changed variable. Performance rows record wall time, child user/system CPU, peak resident
memory, output word count, and whether output is empty. Fresh CLI runs are kept separate from warm
server requests so model-load savings are not mistaken for inference savings. The same model is
repeated on identical input to quantify output stability.

To reproduce a fresh-process CLI run on the Pi, first verify the processed input and use the installed
1.9.4-5 CPU runtime. Store raw outputs and timing files in a mode-0700 private directory:

```sh
umask 077
private_dir=/var/tmp/vhf-asr-private
mkdir -p "$private_dir"
wav=/path/to/processed-wx4.wav
printf '%s  %s\n' 8b62893c20d67a332d56d23bb2d94829f81f5f7e6ff666593c5d028587f35495 "$wav" | sha256sum --check
model=/usr/share/vhf-whisper/ggml-base.en-q5_1.bin
LD_LIBRARY_PATH=/usr/lib/vhf-whisper /usr/bin/time -v -o "$private_dir/base-t2.time" \
  /usr/lib/vhf-whisper/whisper-cli -m "$model" -l en -t 2 -bs 5 -bo 5 -ng -np -f "$wav" \
  > "$private_dir/base-t2.txt"
```

Repeat with `-t 1` for the Base single-thread row or the Tiny model path and the same thread counts.
The CLI defaults to no-context decoding. “Fresh” here means a new process; the operating system's
file cache was not flushed. The CLI measures end-to-end ASR for already prepared audio; the Pi
replay comparison below does not include live demodulation, VAD, or RNNoise processing.

For a resident-process comparison, the plugin's `WhisperServerPool` starts the 1.9.4 server on
`127.0.0.1` with an ephemeral port and randomized request prefix, then posts the same WAV as
multipart fields `file`, `language=en`, `response_format=json`, `token_timestamps=false`, `beam_size=5`,
`best_of=5`, `temperature=0`, and `temperature_inc=0.2`. A first request is the cold server request;
send the second request to the same worker process for the warm result. Both modes use CPU-only,
English, beam size 5, best-of 5, and whisper.cpp's default no-context behavior.

Pi CPU measurements were run offline with VHF capture disabled. For another Pi run, begin only after
two consecutive temperature readings are at or below 62°C with `get_throttled & 0x0f` clear; stop at
78°C or immediately if any of those current throttling/undervoltage bits appear, and cool back to the
same start condition between runs. These safeguards describe the controlled benchmark procedure, not
production VHF operation.

For labeled public controls, prepare local JSONL rows with `kind=reference`, `dataset`, `system`,
`reference`, and `hypothesis`, then run:

```sh
python3 experiments/evaluate-asr-quality.py /private/path/asr-eval.jsonl
```

For unlabeled private weather pairs, use `kind=pair`, `dataset`, `left_system`, `right_system`,
`left`, and `right`. The evaluator prints aggregate counts and edit metrics only; keep its input
file, raw transcripts and radio audio on boat-pi and do not place them in the repository or shared
logs. Its normalization retains numbers as written, so equivalent spellings such as “twenty one”
and “21” count as token disagreement. Run `python3 experiments/evaluate-asr-quality.py --self-test`
to check the scorer without transcript data.
