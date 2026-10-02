#!/usr/bin/env python3
"""Offline raw-hiss heuristic gate applied to a fixed-gain GTCRN listening copy."""

from __future__ import annotations

import argparse
import array
import json
import math
import statistics
import wave
from pathlib import Path


RATE = 16_000
FRAME = 320
HOP = 160
LOW_BINS = tuple(range(8, 61, 2))
HIGH_BINS = tuple(range(80, 141, 2))
FLOOR = 10 ** (-25 / 20)


def percentile(values: list[float], fraction: float) -> float:
    ordered = sorted(values)
    if not ordered:
        raise ValueError("percentile requires data")
    position = (len(ordered) - 1) * fraction
    lower = int(position)
    upper = min(len(ordered) - 1, lower + 1)
    weight = position - lower
    return ordered[lower] * (1 - weight) + ordered[upper] * weight


def centered_median(values: list[float], width: int) -> list[float]:
    radius = width // 2
    return [
        statistics.median(values[max(0, i - radius) : min(len(values), i + radius + 1)])
        for i in range(len(values))
    ]


def goertzel_power(samples: list[float], bin_index: int) -> float:
    coefficient = 2 * math.cos(2 * math.pi * bin_index / len(samples))
    previous = older = 0.0
    for sample in samples:
        current = sample + coefficient * previous - older
        older, previous = previous, current
    return max(0.0, previous * previous + older * older - coefficient * previous * older)


def analyze_raw(raw: list[int]) -> dict[str, object]:
    if not raw:
        raise ValueError("raw input is empty")
    frame_count = (len(raw) + HOP - 1) // HOP
    window = [0.5 - 0.5 * math.cos(2 * math.pi * i / (FRAME - 1)) for i in range(FRAME)]
    window_power = sum(value * value for value in window)
    levels: list[float] = []
    ratios: list[float] = []
    for frame_index in range(frame_count):
        center = frame_index * HOP
        start = center - FRAME // 2
        weighted: list[float] = []
        unweighted: list[float] = []
        for offset, weight in enumerate(window):
            source_index = start + offset
            value = raw[source_index] if 0 <= source_index < len(raw) else 0
            unweighted.append(float(value))
            weighted.append(value * weight)
        rms = math.sqrt(sum(value * value for value in weighted) / window_power)
        levels.append(20 * math.log10(max(rms / 32768, 1e-12)))
        low = statistics.fmean(goertzel_power(weighted, k) for k in LOW_BINS)
        high = statistics.fmean(goertzel_power(weighted, k) for k in HIGH_BINS)
        ratios.append(10 * math.log10(max(low, 1e-30) / max(high, 1e-30)))

    level_q25 = percentile(levels, 0.25)
    level_q75 = percentile(levels, 0.75)
    top_count = max(1, math.ceil(frame_count * 0.25))
    top_indices = sorted(range(frame_count), key=lambda i: levels[i], reverse=True)[:top_count]
    template = [ratios[i] for i in top_indices]
    template_center = statistics.median(template)
    template_mad = statistics.median(abs(value - template_center) for value in template)
    reasons = []
    if level_q75 - level_q25 < 8:
        reasons.append("raw_level_interquartile_range_below_8db")
    if top_count * HOP / RATE < 0.5:
        reasons.append("less_than_0_5s_in_top_level_quartile")
    if template_mad > 2:
        reasons.append("noise_template_mad_above_2db")

    smoothed_levels = centered_median(levels, 11)
    smoothed_ratios = centered_median(ratios, 11)
    ratio_mads = []
    half_window = 12
    for i in range(frame_count):
        neighborhood = smoothed_ratios[max(0, i - half_window) : min(frame_count, i + half_window + 1)]
        center_ratio = statistics.median(neighborhood)
        ratio_mads.append(statistics.median(abs(value - center_ratio) for value in neighborhood))

    candidate = hiss_candidates(levels, smoothed_levels, smoothed_ratios, ratio_mads, level_q75, template_center)
    sustained = [False] * frame_count
    index = 0
    minimum_run = math.ceil(0.25 * RATE / HOP)
    while index < frame_count:
        if not candidate[index]:
            index += 1
            continue
        end = index + 1
        while end < frame_count and candidate[end]:
            end += 1
        if end - index >= minimum_run:
            sustained[index:end] = [True] * (end - index)
        index = end

    if reasons:
        sustained = [False] * frame_count
    # All uncertain frames are protected/open; only a sustained positive hiss result closes.
    open_frames = [not value for value in sustained]
    return {
        "levels_dbfs": levels,
        "band_ratios_db": ratios,
        "sustained_hiss_frames": sustained,
        "open_frames": open_frames,
        "frame_count": frame_count,
        "frame_hop_samples": HOP,
        "level_q25_dbfs": level_q25,
        "level_q75_dbfs": level_q75,
        "noise_template_ratio_db": template_center,
        "noise_template_mad_db": template_mad,
        "abstain_reasons": reasons,
        "candidate_frame_count": sum(candidate),
        "sustained_hiss_frame_count": sum(sustained),
    }


def contiguous_runs(mask: list[bool]) -> list[tuple[int, int]]:
    runs = []
    index = 0
    while index < len(mask):
        if not mask[index]:
            index += 1
            continue
        end = index + 1
        while end < len(mask) and mask[end]:
            end += 1
        runs.append((index, end))
        index = end
    return runs


def hiss_candidates(
    raw_levels: list[float],
    smoothed_levels: list[float],
    smoothed_ratios: list[float],
    ratio_mads: list[float],
    level_q75: float,
    template_ratio: float,
) -> list[bool]:
    return [
        raw_levels[i] >= level_q75 - 3
        and smoothed_levels[i] >= level_q75 - 3
        and abs(smoothed_ratios[i] - template_ratio) <= 2.5
        and ratio_mads[i] <= 1.5
        for i in range(len(raw_levels))
    ]


def build_envelope(open_frames: list[bool], sample_count: int, open_guard_seconds: float = 0.15) -> list[float]:
    envelope = [FLOOR] * sample_count
    guard = min(sample_count, round(open_guard_seconds * RATE))
    envelope[:guard] = [1.0] * guard
    guard_release_end = min(sample_count, guard + round(0.200 * RATE))
    for sample in range(guard, guard_release_end):
        progress = (sample - guard + 1) / max(1, guard_release_end - guard)
        value = FLOOR + (1 - FLOOR) * (0.5 + 0.5 * math.cos(math.pi * progress))
        envelope[sample] = max(envelope[sample], value)
    backward = round(0.150 * RATE / HOP)
    forward = round(0.400 * RATE / HOP)
    attack = round(0.015 * RATE)
    release = round(0.200 * RATE)
    frame_count = len(open_frames)
    for start, end in contiguous_runs(open_frames):
        expanded_start = max(0, start - backward) * HOP
        expanded_end = min(frame_count, end + forward) * HOP
        expanded_end = min(sample_count, expanded_end)
        attack_start = max(0, expanded_start - attack)
        for sample in range(attack_start, expanded_start):
            progress = (sample - attack_start + 1) / max(1, expanded_start - attack_start)
            value = FLOOR + (1 - FLOOR) * (0.5 - 0.5 * math.cos(math.pi * progress))
            envelope[sample] = max(envelope[sample], value)
        for sample in range(expanded_start, expanded_end):
            envelope[sample] = 1.0
        release_end = min(sample_count, expanded_end + release)
        for sample in range(expanded_end, release_end):
            progress = (sample - expanded_end + 1) / max(1, release_end - expanded_end)
            value = FLOOR + (1 - FLOOR) * (0.5 + 0.5 * math.cos(math.pi * progress))
            envelope[sample] = max(envelope[sample], value)
    return envelope


def gated_samples(gtcrn: list[int], envelope: list[float]) -> list[int]:
    if len(gtcrn) != len(envelope):
        raise ValueError("gate envelope and GTCRN waveform must have the same sample count")
    return [max(-32768, min(32767, round(sample * gain))) for sample, gain in zip(gtcrn, envelope)]


def load_wav(path: Path) -> tuple[wave._wave_params, list[int]]:
    with wave.open(str(path), "rb") as source:
        if source.getframerate() != RATE or source.getnchannels() != 1 or source.getsampwidth() != 2:
            raise ValueError(f"Expected 16 kHz mono PCM16 WAV: {path.name}")
        samples = array.array("h")
        samples.frombytes(source.readframes(source.getnframes()))
        return source.getparams(), list(samples)


def rms_dbfs(samples: list[int]) -> float:
    if not samples:
        return float("-inf")
    rms = math.sqrt(sum(value * value for value in samples) / len(samples)) / 32768
    return 20 * math.log10(max(rms, 1e-12))


def peak_dbfs(samples: list[int]) -> float:
    peak = max((abs(value) for value in samples), default=0) / 32768
    return 20 * math.log10(max(peak, 1e-12))


def run(raw_path: Path, gtcrn_path: Path, out_dir: Path) -> dict[str, object]:
    raw_params, raw = load_wav(raw_path)
    gtcrn_params, gtcrn = load_wav(gtcrn_path)
    if len(raw) != len(gtcrn):
        raise ValueError("Raw detector and fixed-gain GTCRN WAVs must have identical lengths")
    analysis = analyze_raw(raw)
    envelope = build_envelope(analysis["open_frames"], len(gtcrn))
    output = gated_samples(gtcrn, envelope)
    out_dir.mkdir(parents=True, exist_ok=True)
    gated_path = out_dir / "829-gtcrn-softgated.wav"
    with wave.open(str(gated_path), "wb") as target:
        target.setparams(gtcrn_params)
        target.writeframes(array.array("h", output).tobytes())
    metrics: dict[str, object] = {
        "method": "offline raw-driven close-only hiss heuristic; not VAD or carrier detector",
        "source_record": "authorized local ID829 CH80A only",
        "sample_rate": RATE,
        "samples": len(output),
        "duration_seconds": len(output) / RATE,
        "raw_detector_path": str(raw_path),
        "fixed_gain_gtcrn_path": str(gtcrn_path),
        "gated_path": str(gated_path),
        "gate_floor_db": -25,
        "open_guard_ms": 150,
        "backward_open_dilation_ms": 150,
        "forward_open_dilation_ms": 400,
        "attack_ms": 15,
        "release_ms": 200,
        "abstain_reasons": analysis["abstain_reasons"],
        "raw_level_q25_dbfs": analysis["level_q25_dbfs"],
        "raw_level_q75_dbfs": analysis["level_q75_dbfs"],
        "noise_template_ratio_db": analysis["noise_template_ratio_db"],
        "noise_template_mad_db": analysis["noise_template_mad_db"],
        "candidate_hiss_frames": analysis["candidate_frame_count"],
        "sustained_hiss_frames": analysis["sustained_hiss_frame_count"],
        "detector_open_frames_before_temporal_protection": sum(analysis["open_frames"]),
        "detector_open_mask_coverage_fraction_before_temporal_protection": sum(analysis["open_frames"]) / len(analysis["open_frames"]),
        "gate_envelope_min": min(envelope),
        "gate_envelope_max": max(envelope),
        "gate_envelope_transition_count": sum(a != b for a, b in zip(envelope, envelope[1:])),
        "gtcrn_overall_rms_dbfs": rms_dbfs(gtcrn),
        "gated_overall_rms_dbfs": rms_dbfs(output),
        "gtcrn_peak_dbfs": peak_dbfs(gtcrn),
        "gated_peak_dbfs": peak_dbfs(output),
        "samples_at_pcm_limit": sum(abs(value) >= 32767 for value in output),
        "level_threshold_db_below_q75": 3,
        "band_ratio_tolerance_db": 2.5,
        "rolling_ratio_mad_limit_db": 1.5,
        "rolling_ratio_window_ms": 250,
        "sustained_hiss_minimum_ms": 250,
        "abstain_if_level_iqr_below_db": 8,
        "abstain_if_noise_template_mad_above_db": 2,
        "evidence_limit": "Aggregate waveform levels and mask diagnostics do not establish speech preservation or perceived quality; compare by listening.",
    }
    metrics_path = out_dir / "829-soft-squelch-metrics.json"
    metrics_path.write_text(json.dumps(metrics, indent=2) + "\n")
    return metrics


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--raw", type=Path, required=True, help="authorized local raw matched listening WAV")
    parser.add_argument("--gtcrn", type=Path, required=True, help="fixed-gain GTCRN matched listening WAV")
    parser.add_argument("--out-dir", type=Path, required=True, help="temporary output folder; keep outside repository")
    args = parser.parse_args()
    print(json.dumps(run(args.raw, args.gtcrn, args.out_dir), indent=2))


if __name__ == "__main__":
    main()
