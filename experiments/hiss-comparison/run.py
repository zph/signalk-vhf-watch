#!/usr/bin/env python3
"""Compare offline speech denoisers on public speech with synthetic radio hiss."""

from __future__ import annotations

import argparse
import array
import json
import math
import random
import re
import shutil
import subprocess
import time
import wave
from pathlib import Path


RATE = 16_000
TAIL_SECONDS = 2
MASK_FLOOR = 0.015
MASK_DILATION_MS = 80
REFERENCE_WORDS = "And so, my fellow Americans: ask not what your country can do for you; ask what you can do for your country."


def run(command: list[str], *, capture: bool = False) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, check=True, text=True, capture_output=capture)


def read_wav(path: Path) -> tuple[int, list[float]]:
    with wave.open(str(path), "rb") as source:
        if source.getnchannels() != 1 or source.getsampwidth() != 2:
            raise ValueError(f"Expected mono PCM16 WAV: {path}")
        rate = source.getframerate()
        samples = array.array("h")
        samples.frombytes(source.readframes(source.getnframes()))
        return rate, [sample / 32768.0 for sample in samples]


def write_wav(path: Path, samples: list[float]) -> None:
    pcm = array.array("h", (max(-32768, min(32767, round(value * 32767))) for value in samples))
    with wave.open(str(path), "wb") as target:
        target.setnchannels(1)
        target.setsampwidth(2)
        target.setframerate(RATE)
        target.writeframes(pcm.tobytes())


def rms(values: list[float]) -> float:
    return math.sqrt(sum(value * value for value in values) / max(1, len(values)))


def speech_mask(reference: list[float]) -> list[bool]:
    frame = int(RATE * 0.020)
    levels = [rms(reference[index : index + frame]) for index in range(0, len(reference), frame)]
    threshold = max(levels, default=0.0) * MASK_FLOOR
    radius = round(MASK_DILATION_MS / 20)
    active = [level >= threshold and level > 0 for level in levels]
    expanded = [any(active[max(0, i - radius) : min(len(active), i + radius + 1)]) for i in range(len(active))]
    return [expanded[min(index // frame, len(expanded) - 1)] for index in range(len(reference))]


def align(reference: list[float], estimate: list[float]) -> tuple[list[float], list[float], int]:
    # Choose a high-energy 500 ms speech window, then correlate at full rate.
    window_samples = min(RATE // 2, len(reference))
    starts = range(0, max(1, len(reference) - window_samples + 1), RATE // 4)
    window_start = max(starts, key=lambda start: rms(reference[start : start + window_samples]))
    window_end = min(len(reference), window_start + window_samples)
    def score(delay: int) -> float:
        start = max(window_start, -delay)
        end = min(window_end, len(reference), len(estimate) - delay)
        if end <= start:
            return -1.0
        pairs = ((reference[i], estimate[i + delay]) for i in range(start, end))
        xy = xx = yy = 0.0
        for x, y in pairs:
            xy += x * y
            xx += x * x
            yy += y * y
        return xy / math.sqrt(max(xx * yy, 1e-30))

    delay = max(range(-3200, 3201), key=score)
    start = max(0, -delay)
    end = min(len(reference), len(estimate) - delay)
    return reference[start:end], estimate[start + delay : end + delay], delay


def normalize_words(text: str) -> list[str]:
    return re.findall(r"[a-z0-9]+", text.casefold())


def clean_whisper_output(text: str) -> str:
    text = re.sub(r"\x1b\[[0-9;]*m", "", text)
    text = re.sub(r"\[BLANK_AUDIO\]", "", text, flags=re.IGNORECASE)
    lines = [re.sub(r"^\s*\[\d{2}:\d{2}:\d{2}\.\d{3}\s+-->\s+\d{2}:\d{2}:\d{2}\.\d{3}\]\s*", "", line) for line in text.splitlines()]
    return re.sub(r"\s+", " ", " ".join(lines)).strip()


def edit_distance(left: list[str], right: list[str]) -> int:
    row = list(range(len(right) + 1))
    for i, word in enumerate(left, 1):
        next_row = [i]
        for j, other in enumerate(right, 1):
            next_row.append(min(next_row[-1] + 1, row[j] + 1, row[j - 1] + (word != other)))
        row = next_row
    return row[-1]


def speech_metrics(reference: list[float], estimate: list[float], noisy: list[float]) -> dict[str, float | int]:
    _ref_est, _est, delay = align(reference, estimate)
    # Inputs are sample-synchronous by construction; do not optimize noise-baseline alignment.
    start = max(0, -delay)
    end = min(len(reference), len(estimate) - delay, len(noisy))
    ref_all = reference[start:end]
    est_all = estimate[start + delay : end + delay]
    noisy_all = noisy[start:end]
    # Use one clean-reference-derived mask with an 80 ms dilation to retain weak consonants.
    mask = speech_mask(reference)
    common_mask = mask[start:end]
    ref_speech = [value for value, enabled in zip(ref_all, common_mask) if enabled]
    est_speech = [value for value, enabled in zip(est_all, common_mask) if enabled]
    noisy_speech = [value for value, enabled in zip(noisy_all, common_mask) if enabled]
    error = [e - r for r, e in zip(ref_speech, est_speech)]
    baseline_error = [n - r for r, n in zip(ref_speech, noisy_speech)]
    ref_mean = sum(ref_speech) / max(1, len(ref_speech))
    est_mean = sum(est_speech) / max(1, len(est_speech))
    centered_ref = [value - ref_mean for value in ref_speech]
    centered_est = [value - est_mean for value in est_speech]
    projection = sum(r * e for r, e in zip(centered_ref, centered_est)) / max(sum(r * r for r in centered_ref), 1e-30)
    target = [projection * value for value in centered_ref]
    residual = [e - t for e, t in zip(centered_est, target)]
    ref_rms = rms(ref_speech)
    speech_region_rms_change_db = 20 * math.log10(max(rms(est_speech), 1e-12) / max(ref_rms, 1e-12))
    projected_speech_gain_db = 20 * math.log10(max(abs(projection), 1e-12))
    tail_start = max(0, len(reference) - RATE * TAIL_SECONDS - start)
    quiet_tail = [est_all[i] for i in range(tail_start, len(est_all)) if not common_mask[i]]
    tail_rms = rms(quiet_tail)
    return {
        "delay_samples": delay,
        "valid_samples": len(ref_all),
        "speech_samples": len(ref_speech),
        "speech_snr_db": 10 * math.log10(sum(r * r for r in ref_speech) / max(sum(v * v for v in error), 1e-30)),
        "input_speech_snr_db": 10 * math.log10(sum(r * r for r in ref_speech) / max(sum(v * v for v in baseline_error), 1e-30)),
        "snr_improvement_db": 10 * math.log10(max(sum(v * v for v in baseline_error), 1e-30) / max(sum(v * v for v in error), 1e-30)),
        "si_sdr_db": 10 * math.log10(max(sum(v * v for v in target), 1e-30) / max(sum(v * v for v in residual), 1e-30)),
        "speech_region_rms_change_db": speech_region_rms_change_db,
        "projected_speech_gain_db": projected_speech_gain_db,
        "quiet_tail_rms_dbfs": 20 * math.log10(max(tail_rms, 1e-12)),
    }


def make_noisy(reference: list[float], snr_db: int, seed: int) -> tuple[list[float], list[float], float]:
    mask = speech_mask(reference)
    speech = [value for value, enabled in zip(reference, mask) if enabled]
    desired_noise_rms = rms(speech) / (10 ** (snr_db / 20))
    generator = random.Random(seed)
    alpha = math.exp(-2 * math.pi * 900 / RATE)
    raw = [generator.gauss(0.0, 1.0) for _ in range(len(reference))]
    colored: list[float] = []
    previous_x = previous_y = 0.0
    for value in raw:
        output = alpha * (previous_y + value - previous_x)
        colored.append(output)
        previous_x, previous_y = value, output
    measured = rms([value for value, enabled in zip(colored, mask) if enabled])
    scale = desired_noise_rms / max(measured, 1e-12)
    noise = [value * scale for value in colored]
    mixed = [speech_value + noise_value for speech_value, noise_value in zip(reference, noise)]
    peak = max((abs(value) for value in mixed), default=0.0)
    headroom = min(1.0, 0.90 / max(peak, 1e-12))
    return [value * headroom for value in mixed], [value * headroom for value in reference], headroom


def timed_command(command: list[str], log_path: Path) -> tuple[float, int | None, str]:
    timer = shutil.which("/usr/bin/time") or "/usr/bin/time"
    full = ["nice", "-n", "15"]
    ionice = shutil.which("ionice")
    if ionice:
        full.extend([ionice, "-c", "3"])
    full.extend([timer, "-v", *command])
    started = time.monotonic()
    result = subprocess.run(full, text=True, capture_output=True, check=True)
    elapsed = time.monotonic() - started
    log_path.write_text(result.stderr)
    match = re.search(r"Maximum resident set size \(kbytes\): (\d+)", result.stderr)
    return elapsed, int(match.group(1)) if match else None, result.stdout.strip()


def listening_gain(source: Path, reference: list[float], known_delay: int | None = None) -> tuple[list[float], float]:
    rate, estimate = read_wav(source)
    if rate != RATE:
        raise ValueError(f"Unexpected sample rate {rate}: {source}")
    if known_delay is None:
        aligned_ref, aligned_est, _delay = align(reference, estimate)
    else:
        start = max(0, -known_delay)
        end = min(len(reference), len(estimate) - known_delay)
        aligned_ref = reference[start:end]
        aligned_est = estimate[start + known_delay : end + known_delay]
    mask = speech_mask(aligned_ref)
    gain = rms([v for v, enabled in zip(aligned_ref, mask) if enabled]) / max(rms([v for v, enabled in zip(aligned_est, mask) if enabled]), 1e-12)
    return estimate, gain


def rescore_existing(args: argparse.Namespace) -> None:
    result_path = args.out / "results.json"
    manifest = json.loads(result_path.read_text())
    rate, clean_reference = read_wav(args.out / "jfk-bandlimited-clean.wav")
    if rate != RATE:
        raise ValueError(f"Reference must be {RATE} Hz")
    modes = ("raw", "comfort", "gtcrn", "dpdfnet-full", "dpdfnet-12db")
    reference_text = normalize_words(args.reference)
    variants: dict[str, tuple[Path, Path, list[float]]] = {}
    for snr in (0, 8):
        scale = float(manifest["variants"][f"raw-{snr}db"]["common_headroom_scale"])
        scaled_reference = [value * scale for value in clean_reference]
        noisy = args.out / f"jfk-radio-noisy-{snr}db.wav"
        for mode in modes:
            candidate = noisy if mode == "raw" else args.out / f"jfk-{mode}-{snr}db.wav"
            variants[f"{mode}-{snr}db"] = (candidate, noisy, scaled_reference)

    listening: dict[str, tuple[list[float], float]] = {}
    maximum_peak = 0.0
    for name, (candidate, noisy, scaled_reference) in variants.items():
        candidate_rate, estimate = read_wav(candidate)
        noisy_rate, noisy_samples = read_wav(noisy)
        if candidate_rate != RATE or noisy_rate != RATE:
            raise ValueError(f"Unexpected sample rate for {name}")
        metrics = speech_metrics(scaled_reference, estimate, noisy_samples)
        transcript = manifest.get("whisper_transcripts", {}).get(name, "")
        metrics["whisper_word_errors"] = edit_distance(reference_text, normalize_words(transcript))
        metrics["whisper_reference_words"] = len(reference_text)
        metrics["whisper_wer"] = metrics["whisper_word_errors"] / max(1, len(reference_text))
        metrics["output_duration_seconds"] = len(estimate) / RATE
        metrics["speech_duration_seconds"] = sum(speech_mask(scaled_reference)) / RATE
        manifest["variants"][name]["metrics"] = metrics
        audio, gain = listening_gain(candidate, scaled_reference, int(metrics["delay_samples"]))
        listening[name] = (audio, gain)
        maximum_peak = max(maximum_peak, max((abs(value * gain) for value in audio), default=0.0))

    shared_headroom = min(1.0, 0.94 / max(maximum_peak, 1e-12))
    manifest["listening_shared_headroom_scale"] = shared_headroom
    for name, (samples, gain) in listening.items():
        listening_path = args.out / f"{name}-listen.wav"
        write_wav(listening_path, [value * gain * shared_headroom for value in samples])
        manifest["variants"][name]["listening_copy"] = str(listening_path)
    result_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
    print(json.dumps({name: manifest["variants"][name]["metrics"] for name in variants}, indent=2))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True, help="public mono speech WAV")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--runtime", type=Path, required=True, help="sherpa-onnx runtime root")
    parser.add_argument("--gtcrn", type=Path, required=True)
    parser.add_argument("--dpdfnet", type=Path, required=True)
    parser.add_argument("--whisper", type=Path, default=Path("/usr/bin/vhf-whisper"))
    parser.add_argument("--reference", default=REFERENCE_WORDS)
    parser.add_argument("--score-only", action="store_true", help="rescore saved public outputs without running denoisers or Whisper")
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    if args.score_only:
        rescore_existing(args)
        return

    reference_path = args.out / "jfk-bandlimited-clean.wav"
    run(["/usr/bin/ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", str(args.input), "-af", "highpass=f=300,lowpass=f=3200", "-ac", "1", "-ar", str(RATE), "-c:a", "pcm_s16le", str(reference_path)])
    rate, reference = read_wav(reference_path)
    if rate != RATE:
        raise ValueError(f"Reference must be {RATE} Hz")
    reference += [0.0] * (RATE * TAIL_SECONDS)
    write_wav(reference_path, reference)

    manifest: dict[str, object] = {
        "input": str(args.input), "reference": str(reference_path), "sample_rate": RATE,
        "reference_transcript": args.reference, "synthetic_noise": "seeded first-order high-passed Gaussian noise; radio-like approximation only",
        "mask": f"20 ms reference frames above {MASK_FLOOR:.3f} of peak frame RMS; dilated {MASK_DILATION_MS} ms",
        "variants": {},
    }
    variant_paths: dict[str, tuple[Path, Path, list[float]]] = {}
    for snr in (0, 8):
        noisy, scaled_reference, headroom = make_noisy(reference, snr, 1701 + snr)
        input_path = args.out / f"jfk-radio-noisy-{snr}db.wav"
        write_wav(input_path, noisy)
        variant_paths[f"raw-{snr}db"] = (input_path, input_path, scaled_reference)
        manifest["variants"][f"raw-{snr}db"] = {"file": str(input_path), "synthetic_snr_db": snr, "common_headroom_scale": headroom}

        comfort_path = args.out / f"jfk-comfort-{snr}db.wav"
        comfort_filter = "[0:a]asplit=2[raw][work];[work]afftdn=nr=10:nf=-28:tn=1:ad=0.8:gs=6[clean];[raw][clean]amix=inputs=2:weights='0.15 0.85':normalize=1[out]"
        run(["/usr/bin/ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", str(input_path), "-filter_complex", comfort_filter, "-map", "[out]", "-ac", "1", "-ar", str(RATE), "-c:a", "pcm_s16le", str(comfort_path)])
        variant_paths[f"comfort-{snr}db"] = (comfort_path, input_path, scaled_reference)
        manifest["variants"][f"comfort-{snr}db"] = {"file": str(comfort_path)}

        for model_name, model_flag, model_path in (
            ("gtcrn", "--speech-denoiser-gtcrn-model", args.gtcrn),
            ("dpdfnet-full", "--speech-denoiser-dpdfnet-model", args.dpdfnet),
            ("dpdfnet-12db", "--speech-denoiser-dpdfnet-model", args.dpdfnet),
        ):
            for threads in ((1, 2) if snr == 8 else (1,)):
                suffix = "" if threads == 1 else f"-t{threads}"
                output = args.out / f"jfk-{model_name}-{snr}db{suffix}.wav"
                args_list = [str(args.runtime / "bin/sherpa-onnx-offline-denoiser"), "--provider=cpu", f"--num-threads={threads}", f"{model_flag}={model_path}"]
                if model_name == "dpdfnet-12db":
                    args_list.append("--speech-denoiser-dpdfnet-attenuation-limit-db=12")
                args_list.extend([f"--input-wav={input_path}", f"--output-wav={output}"])
                elapsed, max_rss_kb, _text = timed_command(args_list, args.out / f"{model_name}-{snr}db{suffix}.time.txt")
                if threads == 1:
                    variant_paths[f"{model_name}-{snr}db"] = (output, input_path, scaled_reference)
                manifest["variants"][f"{model_name}-{snr}db{suffix}"] = {
                    "file": str(output), "threads": threads,
                    "process_wall_seconds_including_startup_model_load_io_and_nice_scheduling": elapsed,
                    "max_rss_kb": max_rss_kb,
                }

    reference_text = normalize_words(args.reference)
    whisper_results: dict[str, str] = {}
    listening_outputs: dict[str, tuple[list[float], float]] = {}
    max_listening_peak = 0.0
    for name, (candidate, noisy, scaled_reference) in variant_paths.items():
        rate, estimate = read_wav(candidate)
        if rate != RATE:
            raise ValueError(f"Unexpected output sample rate {rate}: {candidate}")
        metrics = speech_metrics(scaled_reference, estimate, read_wav(noisy)[1])
        transcript_path = args.out / f"{name}.transcript.txt"
        whisper_command = ["nice", "-n", "15"]
        ionice = shutil.which("ionice")
        if ionice:
            whisper_command.extend([ionice, "-c", "3"])
        result = run([*whisper_command, str(args.whisper), str(candidate), "base.en-q5_1", "2"], capture=True)
        transcript_path.write_text(result.stdout)
        cleaned_transcript = clean_whisper_output(result.stdout)
        whisper_results[name] = cleaned_transcript
        predicted = normalize_words(cleaned_transcript)
        metrics["whisper_word_errors"] = edit_distance(reference_text, predicted)
        metrics["whisper_reference_words"] = len(reference_text)
        metrics["whisper_wer"] = metrics["whisper_word_errors"] / max(1, len(reference_text))
        metrics["output_duration_seconds"] = len(estimate) / RATE
        metrics["speech_duration_seconds"] = sum(speech_mask(scaled_reference)) / RATE
        manifest["variants"][name]["metrics"] = metrics
        listen_path = args.out / f"{name}-listen.wav"
        listening_data, gain = listening_gain(candidate, scaled_reference)
        listening_outputs[name] = (listening_data, gain)
        max_listening_peak = max(max_listening_peak, max((abs(value * gain) for value in listening_data), default=0.0))
        manifest["variants"][name]["listening_copy"] = str(listen_path)

    shared_headroom = min(1.0, 0.94 / max(max_listening_peak, 1e-12))
    manifest["listening_shared_headroom_scale"] = shared_headroom
    for name, (samples, speech_gain) in listening_outputs.items():
        listen_path = args.out / f"{name}-listen.wav"
        write_wav(listen_path, [value * speech_gain * shared_headroom for value in samples])

    manifest["whisper_transcripts"] = whisper_results
    (args.out / "results.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
    print(json.dumps({name: value.get("metrics") for name, value in manifest["variants"].items() if isinstance(value, dict) and "metrics" in value}, indent=2))


if __name__ == "__main__":
    main()
