#!/usr/bin/env python3
"""Measure standalone whisper.cpp Silero VAD without recording audio or ASR text."""

import argparse
import concurrent.futures
import json
import pathlib
import re
import resource
import subprocess
import time
import wave


def usage_seconds():
    usage = resource.getrusage(resource.RUSAGE_CHILDREN)
    return usage.ru_utime + usage.ru_stime


def duration(path):
    with wave.open(str(path), "rb") as audio:
        return audio.getnframes() / audio.getframerate()


def run_one(args, audio, threshold):
    command = [
        args.helper,
        "--vad-model", args.model,
        "--file", str(audio),
        "--threads", "1",
        "--vad-threshold", str(threshold),
        "--vad-min-speech-duration-ms", "80",
        "--vad-min-silence-duration-ms", "100",
        "--vad-speech-pad-ms", "200",
        "--no-prints",
    ]
    before_cpu = usage_seconds()
    before = time.perf_counter()
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    wall = time.perf_counter() - before
    cpu = max(0, usage_seconds() - before_cpu)
    match = re.search(r"^Detected (\d+) speech segments:$", result.stdout, re.M)
    return {
        "exit": result.returncode,
        "segments": int(match.group(1)) if match else None,
        "wallSeconds": round(wall, 4),
        "cpuSeconds": round(cpu, 4),
        "audioSeconds": round(duration(audio), 3),
        "cpuPerAudioSecond": round(cpu / duration(audio), 4),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--helper", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--thresholds", default="0.1,0.2,0.35")
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--concurrency", default="2,4,8")
    parser.add_argument("audio", nargs="+", type=pathlib.Path)
    args = parser.parse_args()
    thresholds = [float(value) for value in args.thresholds.split(",")]
    output = {"helper": args.helper, "thresholds": {}}
    for threshold in thresholds:
        key = str(threshold)
        output["thresholds"][key] = {"files": {}, "concurrency": {}}
        for audio in args.audio:
            runs = [run_one(args, audio, threshold) for _ in range(args.repeats)]
            output["thresholds"][key]["files"][audio.name] = {
                "first": runs[0],
                "repeats": runs[1:],
            }
        for count in (int(value) for value in args.concurrency.split(",")):
            audio = args.audio[0]
            before_cpu = usage_seconds()
            before = time.perf_counter()
            with concurrent.futures.ThreadPoolExecutor(max_workers=count) as pool:
                runs = list(pool.map(lambda _: run_one(args, audio, threshold), range(count)))
            total_cpu = max(0, usage_seconds() - before_cpu)
            total_wall = time.perf_counter() - before
            output["thresholds"][key]["concurrency"][str(count)] = {
                "audio": audio.name,
                "workers": count,
                "totalAudioSeconds": round(sum(row["audioSeconds"] for row in runs), 3),
                "wallSeconds": round(total_wall, 4),
                "cpuSeconds": round(total_cpu, 4),
                "cpuPerAudioSecond": round(total_cpu / sum(row["audioSeconds"] for row in runs), 4),
                "results": [{"exit": row["exit"], "segments": row["segments"]} for row in runs],
            }
    print(json.dumps(output, indent=2))


if __name__ == "__main__":
    main()
