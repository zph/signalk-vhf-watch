#!/usr/bin/env python3
"""Aggregate-only aligned waveform diagnostics for private Pi trial WAVs."""

from __future__ import annotations

import argparse
import array
import json
import math
import wave
from pathlib import Path


def read_pcm(path: Path) -> tuple[int, list[int]]:
    with wave.open(str(path), "rb") as source:
        if source.getnchannels() != 1 or source.getsampwidth() != 2:
            raise ValueError(f"Expected mono PCM16 WAV: {path.name}")
        pcm = array.array("h")
        pcm.frombytes(source.readframes(source.getnframes()))
        return source.getframerate(), list(pcm)


def correlation_for_lag(reference: list[int], estimate: list[int], start: int, length: int, lag: int) -> float:
    x = reference[start : start + length]
    y = estimate[start + lag : start + lag + length]
    if len(x) != length or len(y) != length:
        return -1.0
    mean_x = sum(x) / length
    mean_y = sum(y) / length
    sum_xx = sum_xy = sum_yy = 0.0
    for left, right in zip(x, y):
        dx = left - mean_x
        dy = right - mean_y
        sum_xx += dx * dx
        sum_xy += dx * dy
        sum_yy += dy * dy
    return sum_xy / math.sqrt(max(1e-30, sum_xx * sum_yy))


def find_alignment_lag(
    reference: list[int], estimate: list[int], start: int, length: int, max_lag: int = 3_200
) -> tuple[int, int]:
    """Search every second sample, then all neighboring integer lags at full rate."""
    best_lag = 0
    best_correlation = -2.0
    for lag in range(-max_lag, max_lag + 1, 2):
        correlation = correlation_for_lag(reference, estimate, start, length, lag)
        if correlation > best_correlation:
            best_lag, best_correlation = lag, correlation
    for lag in range(max(-max_lag, best_lag - 1), min(max_lag, best_lag + 1) + 1):
        correlation = correlation_for_lag(reference, estimate, start, length, lag)
        if correlation > best_correlation:
            best_lag, best_correlation = lag, correlation
    return best_lag, best_correlation


def fit_activity(reference: list[int], estimate: list[int], start: int, end: int, lag: int) -> dict[str, float | int]:
    lo = max(start, 0, -lag)
    hi = min(end, len(reference), len(estimate) - lag)
    x = reference[lo:hi]
    y = estimate[lo + lag : hi + lag]
    if not x:
        raise ValueError("No common activity samples after alignment")
    count = len(x)
    mean_x = sum(x) / count
    mean_y = sum(y) / count
    xx = xy = yy = 0.0
    for left, right in zip(x, y):
        dx = left - mean_x
        dy = right - mean_y
        xx += dx * dx
        xy += dx * dy
        yy += dy * dy
    gain = xy / max(xx, 1e-30)
    intercept = mean_y - gain * mean_x
    residual = 0.0
    for left, right in zip(x, y):
        error = right - (gain * left + intercept)
        residual += error * error
    rms_y = math.sqrt(sum(value * value for value in y) / count)
    rms_x = math.sqrt(sum(value * value for value in x) / count)
    rms_residual = math.sqrt(residual / count)
    return {
        "common_activity_samples": count,
        "lag_samples": lag,
        "lag_ms": lag * 1000 / 16_000,
        "pearson_full_activity": xy / math.sqrt(max(1e-30, xx * yy)),
        "fitted_gain_db": 20 * math.log10(max(abs(gain), 1e-15)),
        "fitted_intercept_pcm": intercept,
        "residual_over_output_rms_db": 20 * math.log10(max(rms_residual / max(rms_y, 1e-15), 1e-15)),
        "residual_over_raw_rms_db": 20 * math.log10(max(rms_residual / max(rms_x, 1e-15), 1e-15)),
    }


def analyze_record(record_dir: Path, metadata: dict[str, object]) -> dict[str, object]:
    sample_rate, raw = read_pcm(record_dir / "source-raw.wav")
    if sample_rate != 16_000:
        raise ValueError(f"Expected 16 kHz archive audio in {record_dir.name}")
    activity_start = round(float(metadata["activity_start_seconds"]) * sample_rate)
    activity_end = min(len(raw), round(float(metadata["activity_end_seconds"]) * sample_rate))
    window = min(sample_rate // 10, activity_end - activity_start)  # Up to 100 ms
    if window <= 0:
        raise ValueError(f"No activity interval in {record_dir.name}")
    hop = sample_rate // 50  # 20 ms window search hop
    possible = range(activity_start, max(activity_start + 1, activity_end - window + 1), hop)
    align_start = max(possible, key=lambda index: sum(value * value for value in raw[index : index + window]))
    outputs: dict[str, object] = {}
    for name, filename in (("gtcrn", "gtcrn.wav"), ("dpdfnet_12db", "dpdfnet-12db.wav")):
        rate, estimate = read_pcm(record_dir / filename)
        if rate != sample_rate:
            raise ValueError(f"Sample rate mismatch for {record_dir.name}/{filename}")
        lag, window_corr = find_alignment_lag(raw, estimate, align_start, window)
        fit = fit_activity(raw, estimate, activity_start, activity_end, lag)
        fit["alignment_window_start_seconds"] = align_start / sample_rate
        fit["alignment_window_pearson"] = window_corr
        outputs[name] = fit
    return {"record_id": record_dir.name.removeprefix("record-"), "variants": outputs}


def analyze_run(run_dir: Path) -> dict[str, object]:
    summary = json.loads((run_dir / "summary.json").read_text())
    records = summary["records"]
    results = []
    for record_id, metadata in records.items():
        results.append(analyze_record(run_dir / f"record-{record_id}", metadata))
    return {"run_id": summary["run_id"], "records": results}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run_dirs", type=Path, nargs="+", help="Pi-local in-situ run directories")
    args = parser.parse_args()
    print(json.dumps({"mechanism_diagnostics_only": True, "runs": [analyze_run(path) for path in args.run_dirs]}, indent=2))


if __name__ == "__main__":
    main()
