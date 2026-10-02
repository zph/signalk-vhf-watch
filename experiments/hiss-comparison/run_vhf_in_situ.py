#!/usr/bin/env python3
"""Run bounded VHF archive comparisons entirely on the Signal K host."""

from __future__ import annotations

import argparse
import array
import datetime as dt
import json
import math
import os
import re
import shutil
import subprocess
import time
import urllib.parse
import urllib.request
import wave
from pathlib import Path


API = "http://127.0.0.1:3000/plugins/signalk-vhf-watch/api"
TARGET_IDS = (819, 817)
MODEL = "base.en-q5_1"
THREADS = 2


def get_json(url: str) -> dict[str, object]:
    with urllib.request.urlopen(url, timeout=10) as response:
        return json.load(response)


def status_snapshot() -> dict[str, object]:
    status = get_json(f"{API}/status")
    transcription = status.get("transcription", {})
    metrics = status.get("receiverMetrics", {})
    return {
        "transcription_state": transcription.get("state"),
        "transcription_queued": transcription.get("queued"),
        "dropped_iq_chunks": metrics.get("droppedIqChunks"),
        "restarts": metrics.get("restarts"),
        "receiving": status.get("receiving"),
        "receiver_state": status.get("receiverState"),
    }


def select_records(requested_ids: list[int] | tuple[int, ...], records: list[dict[str, object]] | None = None) -> list[dict[str, object]]:
    if records is None:
        response = get_json(f"{API}/transcripts?limit=30")
        records = response.get("records", [])
    by_id = {int(record["id"]): record for record in records}
    if requested_ids != TARGET_IDS:
        missing = [record_id for record_id in requested_ids if record_id not in by_id]
        if missing:
            raise RuntimeError(f"Requested archive IDs are not present in the bounded metadata: {missing}")
        return [by_id[record_id] for record_id in requested_ids]
    if all(record_id in by_id for record_id in requested_ids):
        return [by_id[record_id] for record_id in requested_ids]

    eligible = [
        record for record in records
        if float(record.get("durationSeconds", 0)) >= 8
        and not str(record.get("channel", "")).upper().startswith("WX")
    ]
    long_calls = [record for record in eligible if float(record["durationSeconds"]) >= 30]
    short_calls = [record for record in eligible if 8 <= float(record["durationSeconds"]) <= 25]
    if not long_calls or not short_calls:
        raise RuntimeError("The bounded recent archive metadata did not contain two suitable voice calls")
    long_call = long_calls[0]
    short_call = next((record for record in short_calls if record["id"] != long_call["id"]), None)
    if short_call is None:
        raise RuntimeError("The bounded recent archive metadata did not contain two distinct voice calls")
    return [long_call, short_call]


def read_pcm(path: Path) -> tuple[int, list[int]]:
    with wave.open(str(path), "rb") as source:
        if source.getnchannels() != 1 or source.getsampwidth() != 2:
            raise ValueError(f"Expected mono PCM16 source: {path.name}")
        pcm = array.array("h")
        pcm.frombytes(source.readframes(source.getnframes()))
        return source.getframerate(), list(pcm)


def dbfs(values: list[int]) -> float | None:
    if not values:
        return None
    level = math.sqrt(sum(value * value for value in values) / len(values)) / 32768
    return 20 * math.log10(max(level, 1e-12))


def audio_summary(path: Path, activity_start: float | None, activity_end: float | None) -> dict[str, object]:
    rate, pcm = read_pcm(path)
    frames = len(pcm)
    duration = frames / rate
    active_start = max(0, min(frames, round((activity_start or 0) * rate)))
    active_end = max(active_start, min(frames, round((activity_end if activity_end is not None else duration) * rate)))
    active = pcm[active_start:active_end]
    quiet = pcm[:active_start] + pcm[active_end:]
    return {
        "sample_rate": rate,
        "duration_seconds": duration,
        "peak_dbfs": 20 * math.log10(max(max((abs(value) for value in pcm), default=0) / 32768, 1e-12)),
        "whole_record_rms_dbfs": dbfs(pcm),
        "activity_window_rms_dbfs": dbfs(active),
        "outside_activity_level_proxy_dbfs": dbfs(quiet) if len(quiet) >= rate // 2 else None,
        "activity_start_seconds": activity_start,
        "activity_end_seconds": activity_end,
    }


def normalize_words(text: str) -> list[str]:
    text = re.sub(r"\x1b\[[0-9;]*m", "", text)
    text = re.sub(r"\[BLANK_AUDIO\]", "", text, flags=re.IGNORECASE)
    text = re.sub(r"^\s*\[\d{2}:\d{2}:\d{2}\.\d{3}\s+-->\s+\d{2}:\d{2}:\d{2}\.\d{3}\]\s*", "", text, flags=re.MULTILINE)
    return re.findall(r"[a-z0-9]+", text.casefold())


def edit_distance(left: list[str], right: list[str]) -> int:
    row = list(range(len(right) + 1))
    for index, token in enumerate(left, 1):
        next_row = [index]
        for other_index, other in enumerate(right, 1):
            next_row.append(min(next_row[-1] + 1, row[other_index] + 1, row[other_index - 1] + (token != other)))
        row = next_row
    return row[-1]


def low_priority() -> list[str]:
    prefix = ["nice", "-n", "15"]
    ionice = shutil.which("ionice")
    if ionice:
        prefix.extend([ionice, "-c", "3"])
    return prefix


def run_measured(command: list[str], log_path: Path, env: dict[str, str] | None = None) -> dict[str, float | int | None]:
    timer = shutil.which("/usr/bin/time") or "/usr/bin/time"
    started = time.monotonic()
    result = subprocess.run([*low_priority(), timer, "-v", *command], text=True, capture_output=True, check=False, env=env)
    elapsed = time.monotonic() - started
    log_path.write_text(result.stderr)
    if result.returncode != 0:
        raise RuntimeError(f"Experiment command failed with exit {result.returncode}; inspect {log_path.name}")
    def matched(pattern: str) -> str | None:
        match = re.search(pattern, result.stderr)
        return match.group(1) if match else None
    max_rss = matched(r"Maximum resident set size \(kbytes\): (\d+)")
    user = matched(r"User time \(seconds\): ([0-9.]+)")
    system = matched(r"System time \(seconds\): ([0-9.]+)")
    cpu_percent = matched(r"Percent of CPU this job got: (\d+)%")
    return {
        "cold_process_wall_seconds_including_model_load_io_and_nice": elapsed,
        "user_cpu_seconds": float(user) if user else None,
        "system_cpu_seconds": float(system) if system else None,
        "cpu_percent": int(cpu_percent) if cpu_percent else None,
        "max_rss_kb": int(max_rss) if max_rss else None,
    }


def compare_words(reference: list[str], candidate: list[str]) -> dict[str, object]:
    edits = edit_distance(reference, candidate)
    return {
        "raw_reference_word_count": len(reference),
        "candidate_word_count": len(candidate),
        "word_edit_distance_from_fresh_raw_run": edits,
        "relative_word_disagreement_fraction_not_accuracy": edits / max(1, len(reference)),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out-root", type=Path, default=Path("/tmp/vhf-hiss-20261002/in-situ"))
    parser.add_argument("--ids", type=int, nargs="+", default=TARGET_IDS)
    parser.add_argument("--runtime", type=Path, default=Path("/tmp/vhf-hiss-20261002/pi-runtime/sherpa-onnx-v1.13.8-linux-aarch64-shared-cpu"))
    parser.add_argument("--gtcrn", type=Path, default=Path("/tmp/vhf-hiss-20261002/pi-runtime/gtcrn_simple.onnx"))
    parser.add_argument("--dpdfnet", type=Path, default=Path("/tmp/vhf-hiss-20261002/pi-runtime/dpdfnet_baseline.onnx"))
    args = parser.parse_args()
    os.umask(0o077)
    run_id = dt.datetime.now(dt.timezone.utc).strftime("run_%Y%m%dT%H%M%SZ")
    out_dir = args.out_root / run_id
    out_dir.mkdir(parents=True, mode=0o700, exist_ok=False)

    before = status_snapshot()
    selected = select_records(args.ids)

    library_dir = args.runtime / "lib"
    env = os.environ.copy()
    env["LD_LIBRARY_PATH"] = str(library_dir) + (":" + env["LD_LIBRARY_PATH"] if env.get("LD_LIBRARY_PATH") else "")
    summary: dict[str, object] = {
        "run_id": run_id,
        "host": "boat-pi",
        "whisper": {"model": MODEL, "threads": THREADS},
        "denoisers": {"gtcrn": str(args.gtcrn), "dpdfnet": str(args.dpdfnet), "threads": 1},
        "selection": [],
        "caveat": "Transcription comparisons are disagreement versus a fresh Whisper run on the same raw VHF clip, not accuracy. No ground truth or human listening score was available.",
        "status_before": before,
        "records": {},
    }
    for record in selected:
        record_id = int(record["id"])
        sample_dir = out_dir / f"record-{record_id}"
        sample_dir.mkdir(mode=0o700)
        source = sample_dir / "source-raw.wav"
        query = urllib.parse.urlencode({"cleanup": "raw", "squelch": "0"})
        with urllib.request.urlopen(f"{API}/transcripts/{record_id}.wav?{query}", timeout=60) as response:
            source.write_bytes(response.read())
        rate, samples = read_pcm(source)
        if rate != int(record.get("sampleRate", rate)) or rate != 16_000:
            raise ValueError(f"Unexpected sample rate {rate} in archive record {record_id}")
        activity_start = record.get("activityStartSeconds")
        activity_end = record.get("activityEndSeconds")
        activity_start = float(activity_start) if activity_start is not None else None
        activity_end = float(activity_end) if activity_end is not None else None
        record_summary: dict[str, object] = {
            "channel": record.get("channel"),
            "duration_seconds": len(samples) / rate,
            "sample_rate": rate,
            "archived_discriminator_noise_min": record.get("minimumDiscriminatorNoise"),
            "source_audio_bytes": source.stat().st_size,
            "activity_start_seconds": activity_start,
            "activity_end_seconds": activity_end,
            "variants": {},
        }
        candidates = {"raw": source, "gtcrn": sample_dir / "gtcrn.wav", "dpdfnet_12db": sample_dir / "dpdfnet-12db.wav"}
        record_summary["variants"]["raw"] = {"file_local_only": source.name, "levels": audio_summary(source, activity_start, activity_end)}
        commands = {
            "gtcrn": [
                str(args.runtime / "bin/sherpa-onnx-offline-denoiser"), "--provider=cpu", "--num-threads=1",
                f"--speech-denoiser-gtcrn-model={args.gtcrn}", f"--input-wav={source}", f"--output-wav={candidates['gtcrn']}",
            ],
            "dpdfnet_12db": [
                str(args.runtime / "bin/sherpa-onnx-offline-denoiser"), "--provider=cpu", "--num-threads=1",
                f"--speech-denoiser-dpdfnet-model={args.dpdfnet}", "--speech-denoiser-dpdfnet-attenuation-limit-db=12",
                f"--input-wav={source}", f"--output-wav={candidates['dpdfnet_12db']}",
            ],
        }
        for name, command in commands.items():
            resources = run_measured(command, sample_dir / f"{name}.time.txt", env)
            record_summary["variants"][name] = {
                "file_local_only": candidates[name].name,
                "levels": audio_summary(candidates[name], activity_start, activity_end),
                **resources,
                "threads": 1,
            }

        raw_texts: dict[str, str] = {}
        for name, audio_path in candidates.items():
            current = status_snapshot()
            if current["transcription_state"] != "idle" or current["transcription_queued"] not in (0, None):
                raise RuntimeError(f"Production Whisper busy before {record_id}/{name}; skipped remaining ASR calls")
            started = time.monotonic()
            result = subprocess.run([*low_priority(), "/usr/bin/vhf-whisper", str(audio_path), MODEL, str(THREADS)], text=True, capture_output=True, check=False)
            if result.returncode != 0:
                (sample_dir / f"{name}.whisper.stderr.txt").write_text(result.stderr)
                raise RuntimeError(f"Whisper failed on {record_id}/{name}; inspect local experiment logs")
            (sample_dir / f"{name}.transcript.txt").write_text(result.stdout)
            raw_texts[name] = result.stdout
            record_summary["variants"][name]["whisper_wall_seconds"] = time.monotonic() - started
            record_summary["variants"][name]["transcript_path_local_only"] = f"record-{record_id}/{name}.transcript.txt"
            if name != "raw":
                record_summary["variants"][name]["transcript_comparison"] = compare_words(normalize_words(raw_texts["raw"]), normalize_words(result.stdout))
        summary["selection"].append({
            "id": record_id,
            "channel": record.get("channel"),
            "started_at": record.get("startedAt"),
            "duration_seconds": record.get("durationSeconds"),
            "selection_reason": "requested record retained" if record_id in args.ids else "recent metadata fallback",
        })
        summary["records"][str(record_id)] = record_summary

    summary["status_after"] = status_snapshot()
    (out_dir / "summary.json").write_text(json.dumps(summary, indent=2, ensure_ascii=False) + "\n")
    print(json.dumps(summary, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
